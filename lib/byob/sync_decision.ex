defmodule Byob.SyncDecision do
  @moduledoc """
  Server-authoritative drift reconciliation decision logic.

  Each user's drift report drives a single per-user `%SyncDecision{}`
  held by the room's GenServer. `evaluate/4` either returns a seek
  command (with `position` + `server_time`) or `:no_seek`, plus an
  updated state.

  ## Adaptive L learning

  `learned_l_ms` is the device-specific seek-processing latency —
  the time from the moment the player is told to seek to the moment
  it resumes playback at the new position. The CLIENT measures it
  directly (timestamp the seek dispatch, capture the delta on the
  next "playing" / "seeked" transition) and reports it in its drift
  payload as `observed_l_ms`. The server smooths it as an EMA and
  uses it as the seek overshoot for that client.

  No post-seek timing windows, no `observation_pending` state machine —
  the client knows exactly when its own seek landed, so we just trust
  it and avoid the fragile inference that previous designs needed.

  ## Tolerance

  `tolerance = clamp(K × max(local_jitter, room_jitter), MIN, MAX)`,
  plus a small post-seek bump.

  ## Cooldowns

  After a seek, exponential backoff (1, 2, 4, 8, 15 s capped). Streak
  resets after 10 s of quiet.
  """

  @noise_k_tolerance 4
  @min_tolerance_ms 300
  @max_tolerance_ms 1_000
  @post_seek_tolerance_bump_ms 300
  @post_seek_quiet_ms 5_000

  @sustained_reports 2

  @seek_cooldown_base_ms 1_000
  @seek_cooldown_max_ms 15_000
  @seek_streak_reset_ms 10_000

  # L sample acceptance band — anything outside this is almost certainly
  # noise (a sub-50 ms reading is below typical IFrame API call overhead;
  # over 5 s means the player stalled, not a clean seek).
  @l_observation_min_sample_ms 50
  @l_observation_max_sample_ms 5_000
  @l_ema_alpha 0.7

  # Seed L with a sensible default so the FIRST sync seek already
  # overshoots reasonably (rather than landing exactly on `expected`
  # and being guaranteed to drift behind by L_actual). Most browser
  # players resume playback ~150-400 ms after `seekTo()`, so 300
  # converges most users in a single seek; outliers refine via EMA.
  @default_learned_l_ms 300

  defstruct over_tolerance_count: 0,
            seek_streak: 0,
            last_seek_at: 0,
            learned_l_ms: @default_learned_l_ms

  @type t :: %__MODULE__{
          over_tolerance_count: non_neg_integer(),
          seek_streak: non_neg_integer(),
          last_seek_at: integer(),
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
  Reset per-session decision state — streak, cooldown, last_seek_at —
  while PRESERVING `learned_l_ms`. Called when the canonical playback
  position changes for reasons other than gradual drift (video change,
  user-initiated seek). The device's seek-processing latency is a
  hardware/network characteristic and survives the reset.
  """
  @spec reset_for_new_video(t()) :: t()
  def reset_for_new_video(state) do
    %{
      state
      | over_tolerance_count: 0,
        seek_streak: 0,
        last_seek_at: 0
    }
  end

  # Public getters for the threshold constants. Templates / panels reach
  # for these so they don't have to know about the private @attrs.
  def min_tolerance_ms, do: @min_tolerance_ms
  def max_tolerance_ms, do: @max_tolerance_ms
  def post_seek_tolerance_bump_ms, do: @post_seek_tolerance_bump_ms
  def sustained_reports, do: @sustained_reports
  def seek_cooldown_base_ms, do: @seek_cooldown_base_ms
  def seek_cooldown_max_ms, do: @seek_cooldown_max_ms
  def seek_streak_reset_ms, do: @seek_streak_reset_ms
  def default_learned_l_ms, do: @default_learned_l_ms

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

  Guaranteed to be in `[0, @seek_cooldown_max_ms]` regardless of any
  timing weirdness. The hard upper clamp at the end defends against
  monotonic-time discontinuities (e.g. server restart with stale state
  in some path, or any future bug that puts `last_seek_at > now_ms`).
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

      cooldown
      |> Kernel.-(now_ms - state.last_seek_at)
      |> max(0)
      |> min(@seek_cooldown_max_ms)
    end
  end

  @doc """
  Process a drift report and decide whether to issue a seek command.

  ## Args
    * `state` — `%SyncDecision{}` for this user
    * `data` — drift / jitter / rtt / observed_l_ms from the report
    * `room` — `expected_position` (canonical playback position right
      now, in seconds) and `room_jitter_ms` (max peer noise floor)
    * `now_ms` — `System.monotonic_time(:millisecond)`
  """
  @spec evaluate(t(), drift_data(), room_data(), integer()) :: result()
  def evaluate(state, data, room, now_ms) do
    # Update L from client-reported sample (if present).
    state = maybe_update_l(state, data)

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

  # Compute seek target with overshoot. `learned_l_ms` is the
  # device-specific seek-processing latency the client measured for us
  # — by the time the seek lands, the canonical clock has advanced by
  # roughly that much, so we aim slightly ahead to compensate. JS adds
  # the one-way transit slop on top, so we don't include rtt here.
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
        last_seek_at: now_ms
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

  # Client measured L_processing for its own most recent sync seek and
  # included it in this drift report. EMA-smooth it into `learned_l_ms`
  # at @l_ema_alpha — the seeded default (@default_learned_l_ms) lets
  # the first sample blend immediately rather than fully replacing,
  # which damps cold-seek outliers (initial seek can be ~2× warm).
  defp maybe_update_l(state, data) do
    sample = Map.get(data, :observed_l_ms, 0) || 0

    if sample >= @l_observation_min_sample_ms and sample <= @l_observation_max_sample_ms do
      new_l = @l_ema_alpha * sample + (1 - @l_ema_alpha) * state.learned_l_ms

      require Logger
      user_short = data |> Map.get(:user_id, "?") |> to_string() |> String.slice(0..7)

      Logger.info(
        "[sync_decision] user=#{user_short} L-observe sample=#{sample}ms " <>
          "learned_L=#{Float.round(new_l * 1.0, 1)}ms"
      )

      %{state | learned_l_ms: new_l}
    else
      state
    end
  end

  defp clamp(n, lo, hi), do: n |> max(lo) |> min(hi)
end
