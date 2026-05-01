defmodule Byob.SyncDecision do
  @moduledoc """
  Server-authoritative drift reconciliation decision logic.

  Each user's LV (or extension Channel) keeps a `%SyncDecision{}` in
  its assigns and calls `evaluate/4` on every drift report from THAT
  user. The decision returns either a seek command (with position +
  server_time) or `:no_seek`, and an updated state.

  ## Adaptive L learning

  After issuing a seek with overshoot O, the player's drift on the
  next report should be `O − L` where L is the device-specific seek
  processing time. From that we recover L = O − drift_after, smooth
  it as an EMA, and use the learned value for future seeks. First
  seek (`learned_l_ms = 0`) overshoots by 0; the residual drift
  becomes our first L sample. Subsequent seeks converge drift to
  ~0 in one step.

  ## Tolerance

  `tolerance = clamp(K × max(local_jitter, room_jitter), MIN, MAX)`,
  plus a small post-seek bump. No upper cap fights jitter — if a
  link genuinely can't hold tighter sync, tolerance grows to match.

  ## Cooldowns

  After a seek, exponential backoff (1, 2, 4, 5 s capped). After
  `MAX_SEEK_STREAK` consecutive seeks without settling, give up
  for this burst (streak resets after 10 s of quiet).
  """

  @noise_k_tolerance 4
  # Floor / ceiling tuned for the server-driven model. Floor at 300 keeps
  # peers tight on calm links; the post-seek bump to 600 gives breathing
  # room while a seek lands; ceiling at 1000 prevents fighting irrecoverable
  # links. With the v6.7.x adaptive-L learning seeks converge in 2 hops, so
  # a ~300 ms residual is entirely reasonable.
  @min_tolerance_ms 300
  @max_tolerance_ms 1_000
  @post_seek_tolerance_bump_ms 300
  @post_seek_quiet_ms 5_000

  @sustained_reports 2

  @seek_cooldown_base_ms 1_000
  @seek_cooldown_max_ms 15_000
  @seek_streak_reset_ms 10_000
  # No cap on streak: relying on the cooldown ladder (1/2/4/5 s capped at
  # 5 s) for rate-limiting. A previous cap at 3 left peers stuck whose
  # players were silently ignoring seek commands (iOS YT, slow Safari)
  # for 10 s windows. Cooldown alone keeps the rate sane (max 1 seek per
  # 5 s on chronic failures) while letting the system keep trying until
  # something lands.

  # Wait at least this long after a seek before the *next* drift report
  # is allowed to update the L estimate (so the seek has had time to
  # actually land before we sample residual drift).
  @l_observation_after_seek_ms 1_500
  # Reject samples outside this band — almost certainly noise / unrelated.
  @l_observation_min_sample_ms 50
  @l_observation_max_sample_ms 5_000
  @l_ema_alpha 0.4

  defstruct over_tolerance_count: 0,
            seek_streak: 0,
            last_seek_at: 0,
            last_overshoot_ms: 0,
            observation_pending: false,
            learned_l_ms: 0

  @type t :: %__MODULE__{
          over_tolerance_count: non_neg_integer(),
          seek_streak: non_neg_integer(),
          last_seek_at: integer(),
          last_overshoot_ms: number(),
          observation_pending: boolean(),
          learned_l_ms: number()
        }

  @type drift_data :: %{
          required(:drift_ms) => number(),
          required(:noise_floor_ms) => number(),
          required(:rtt_ms) => number()
        }

  @type room_data :: %{
          required(:expected_position) => number(),
          required(:room_jitter_ms) => number()
        }

  @type result ::
          {:seek, %{position: number(), server_time: integer()}, t()}
          | {:no_seek, t()}

  @spec new() :: t()
  def new, do: %__MODULE__{}

  @doc """
  Compute the effective tolerance for the current report. Exposed
  separately so callers can echo it to clients for stats display.
  """
  @spec tolerance_ms(drift_data(), room_data(), t(), integer()) :: number()
  def tolerance_ms(data, room, state, now_ms) do
    effective_jitter = max(data.noise_floor_ms || 0, room.room_jitter_ms || 0)
    base = clamp(@noise_k_tolerance * effective_jitter, @min_tolerance_ms, @max_tolerance_ms)

    if state.last_seek_at > 0 and now_ms - state.last_seek_at < @post_seek_quiet_ms do
      min(base + @post_seek_tolerance_bump_ms, @max_tolerance_ms)
    else
      base
    end
  end

  @doc """
  Compute remaining cooldown before another seek can fire (ms).
  """
  @spec cooldown_remaining_ms(t(), integer()) :: non_neg_integer()
  def cooldown_remaining_ms(state, now_ms) do
    if state.last_seek_at == 0 or state.seek_streak == 0 do
      0
    else
      cooldown =
        @seek_cooldown_base_ms
        |> Kernel.*(:math.pow(2, state.seek_streak - 1))
        |> min(@seek_cooldown_max_ms)
        |> trunc()

      max(0, cooldown - (now_ms - state.last_seek_at))
    end
  end

  @doc """
  Process a drift report and decide whether to issue a seek command.

  ## Args
    * `state` — `%SyncDecision{}` for this user
    * `data` — drift / jitter / rtt from the report
    * `room` — `expected_position` (canonical playback position right
      now, in seconds) and `room_jitter_ms` (max peer noise floor)
    * `now_ms` — `System.monotonic_time(:millisecond)`
  """
  @spec evaluate(t(), drift_data(), room_data(), integer()) :: result()
  def evaluate(state, data, room, now_ms) do
    # Update L estimate from prior seek (if observation window elapsed).
    state = maybe_observe_l(state, data, now_ms)

    # Reset streak after long quiet so a single overdue seek isn't
    # punished by a half-hour-old prior seek.
    state =
      if state.seek_streak > 0 and state.last_seek_at > 0 and
           now_ms - state.last_seek_at > @seek_streak_reset_ms do
        %{state | seek_streak: 0}
      else
        state
      end

    drift_ms = data.drift_ms || 0
    tolerance = tolerance_ms(data, room, state, now_ms)

    cond do
      abs(drift_ms) < tolerance ->
        {:no_seek, %{state | over_tolerance_count: 0}}

      true ->
        state = %{state | over_tolerance_count: state.over_tolerance_count + 1}

        cond do
          state.over_tolerance_count < @sustained_reports ->
            {:no_seek, state}

          cooldown_remaining_ms(state, now_ms) > 0 ->
            {:no_seek, state}

          true ->
            issue_seek(state, data, room, now_ms)
        end
    end
  end

  # Compute seek target with overshoot. `learned_l_ms` is the *total*
  # round-trip compensation (one-way-send + seek-processing), learned
  # directly from prior observations — DO NOT add rtt/2 separately or
  # we double-count it (the prior overshoot already included rtt/2's
  # worth of the round-trip, and the residual drift baked all of that
  # into learned_l_ms).
  #
  # First seek (learned_l_ms = 0): target = expected. Residual drift
  # = -(actual round-trip + seek processing); becomes our first sample.
  # Second seek with learned_l_ms = correct: target lands at exactly
  # expected_at_completion, drift converges to ~0.
  defp issue_seek(state, data, room, now_ms) do
    drift_ms = data.drift_ms || 0

    overshoot_ms =
      if drift_ms < 0 do
        state.learned_l_ms
      else
        # Ahead: don't overshoot forward. Just seek to expected.
        0
      end

    target_position = max(0, room.expected_position + overshoot_ms / 1000)

    new_state = %{
      state
      | over_tolerance_count: 0,
        seek_streak: state.seek_streak + 1,
        last_seek_at: now_ms,
        last_overshoot_ms: overshoot_ms,
        observation_pending: true
    }

    require Logger

    user_id = Map.get(data, :user_id) || "?"

    Logger.info(
      "[sync_decision] user=#{String.slice(to_string(user_id), 0..7)} " <>
        "seek drift=#{drift_ms}ms target=#{Float.round(target_position * 1.0, 2)} " <>
        "overshoot=#{Float.round(overshoot_ms * 1.0, 1)}ms streak=#{new_state.seek_streak} " <>
        "learned_L=#{Float.round(state.learned_l_ms * 1.0, 1)}ms"
    )

    {:seek, %{position: target_position, server_time: now_ms}, new_state}
  end

  # If a seek was issued and enough time has elapsed for the player to
  # have landed, sample the residual drift to learn this client's L.
  #   drift_after_seek = real - expected_at_completion
  #                    = (target - L_one_way_send) - (expected_at_send + L_one_way_send + L_seek)
  #                    ≈ overshoot - L_seek (if overshoot was applied symmetrically)
  # So L_seek ≈ overshoot - drift_after_seek.
  defp maybe_observe_l(state, data, now_ms) do
    require Logger
    user_short = data |> Map.get(:user_id, "?") |> to_string() |> String.slice(0..7)

    cond do
      not state.observation_pending ->
        state

      state.last_seek_at <= 0 ->
        state

      now_ms - state.last_seek_at < @l_observation_after_seek_ms ->
        state

      true ->
        sample = state.last_overshoot_ms - (data.drift_ms || 0)

        cond do
          sample < @l_observation_min_sample_ms ->
            Logger.info(
              "[sync_decision] user=#{user_short} L-observe rejected (low) " <>
                "sample=#{Float.round(sample * 1.0, 1)}ms drift=#{data.drift_ms}ms " <>
                "last_overshoot=#{Float.round(state.last_overshoot_ms * 1.0, 1)}ms"
            )

            %{state | observation_pending: false}

          sample > @l_observation_max_sample_ms ->
            Logger.info(
              "[sync_decision] user=#{user_short} L-observe rejected (high) " <>
                "sample=#{Float.round(sample * 1.0, 1)}ms drift=#{data.drift_ms}ms " <>
                "last_overshoot=#{Float.round(state.last_overshoot_ms * 1.0, 1)}ms"
            )

            %{state | observation_pending: false}

          true ->
            new_l =
              if state.learned_l_ms == 0 do
                sample
              else
                @l_ema_alpha * sample + (1 - @l_ema_alpha) * state.learned_l_ms
              end

            Logger.info(
              "[sync_decision] user=#{user_short} L-observe sample=#{Float.round(sample * 1.0, 1)}ms " <>
                "drift=#{data.drift_ms}ms last_overshoot=#{Float.round(state.last_overshoot_ms * 1.0, 1)}ms " <>
                "learned_L=#{Float.round(new_l * 1.0, 1)}ms"
            )

            %{state | learned_l_ms: new_l, observation_pending: false}
        end
    end
  end

  defp clamp(n, lo, hi), do: n |> max(lo) |> min(hi)
end
