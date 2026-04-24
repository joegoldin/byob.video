defmodule Byob.RoomServer.Round do
  @moduledoc """
  Ephemeral state struct for a roulette or voting round. Lives on
  `Byob.RoomServer` state as the `:round` field.

  A round carries its own `id` so late messages (votes after expire, stale
  timer fires) can be safely rejected when the current round no longer
  matches.
  """

  import Bitwise, only: [<<<: 2]

  defstruct [
    :id,
    :mode,
    :started_by,
    :started_at,
    :expires_at,
    :candidates,
    :votes,
    :seed,
    :winner_external_id,
    :phase,
    :finalize_ref
  ]

  @vote_duration_ms 15_000
  # Roulette active phase covers: 3s loading overlay + ~3s card-to-slice
  # fly-in + small pause. After that the server broadcasts `:round_revealed`
  # (with the physics-determined winner) and the client animates the ball
  # for ~3.5s landing + 0.5s settle + 2.5s pie countdown = ~6.5s post-reveal.
  @roulette_duration_ms 6_500
  @reveal_delay_voting_ms 1_500
  @reveal_delay_roulette_ms 8_000
  # Must be >= POST_PREROLL_PAUSE + MAX_LANDING_MS + SETTLE_MS + FINALIZE_PIE_MS
  # in the JS hook (300 + 3600 + 500 + 2500 = 6900ms), plus network latency buffer.

  def vote_duration_ms, do: @vote_duration_ms
  def roulette_duration_ms, do: @roulette_duration_ms
  def reveal_delay_voting_ms, do: @reveal_delay_voting_ms
  def reveal_delay_roulette_ms, do: @reveal_delay_roulette_ms

  def new(mode, user_id, candidates) when mode in [:voting, :roulette] do
    now = System.monotonic_time(:millisecond)
    id = Base.url_encode64(:crypto.strong_rand_bytes(9), padding: false)

    duration =
      case mode do
        :voting -> @vote_duration_ms
        :roulette -> @roulette_duration_ms
      end

    %__MODULE__{
      id: id,
      mode: mode,
      started_by: user_id,
      started_at: now,
      expires_at: now + duration,
      candidates: candidates,
      votes: initial_votes(mode, candidates),
      seed: nil,
      winner_external_id: nil,
      phase: :active,
      finalize_ref: nil
    }
  end

  @doc "Record/replace a user's single vote. No-op if external_id isn't a candidate."
  def cast_vote(%__MODULE__{} = r, user_id, external_id) do
    if Enum.any?(r.candidates, &(&1.external_id == external_id)) do
      new_votes =
        r.votes
        |> Enum.into(%{}, fn {ext, set} -> {ext, MapSet.delete(set, user_id)} end)
        |> Map.update(external_id, MapSet.new([user_id]), &MapSet.put(&1, user_id))

      %{r | votes: new_votes}
    else
      r
    end
  end

  @doc "Total voters (unique user_ids that have cast at least one vote)."
  def total_voters(%__MODULE__{votes: votes}) do
    votes
    |> Map.values()
    |> Enum.reduce(MapSet.new(), &MapSet.union/2)
    |> MapSet.size()
  end

  @doc """
  Pick a winner based on mode + state.
    * :voting — highest-voted candidate; random tiebreak; `nil` if no votes
    * :roulette — `candidates[seed % length]`; generates seed if not set
  Returns {round_with_seed_and_winner, outcome} where outcome is
  :winner_chosen | :no_votes
  """
  def resolve(%__MODULE__{mode: :voting} = r) do
    tallies =
      Enum.map(r.candidates, fn c ->
        {c.external_id, MapSet.size(Map.get(r.votes, c.external_id, MapSet.new()))}
      end)

    max_votes = tallies |> Enum.map(&elem(&1, 1)) |> Enum.max(fn -> 0 end)

    cond do
      max_votes == 0 ->
        {%{r | phase: :revealing}, :no_votes}

      true ->
        winners =
          tallies |> Enum.filter(fn {_, v} -> v == max_votes end) |> Enum.map(&elem(&1, 0))

        winner = Enum.random(winners)
        {%{r | phase: :revealing, winner_external_id: winner}, :winner_chosen}
    end
  end

  def resolve(%__MODULE__{mode: :roulette} = r) do
    seed = :rand.uniform(1 <<< 32) - 1
    slice = simulate_landing_slice(seed, length(r.candidates))
    winner = Enum.at(r.candidates, slice).external_id
    {%{r | phase: :revealing, seed: seed, winner_external_id: winner}, :winner_chosen}
  end

  @doc """
  Deterministic roulette landing physics: given a 32-bit `seed` and the
  total `slice_count`, computes which slice the ball lands in.

  The ball starts at angle 0° (12 o'clock, counting clockwise), with an
  initial angular velocity `v0` and exponential decay constant `k`.
  Both are seeded from `seed` so every client running the same algorithm
  with the same seed reproduces the same landing slice:

      v0 = 540 + (seed mod 2^16) / 2^16 * 280  (deg/s)
      duration = 3.0 + (seed >> 16 mod 2^16) / 2^16 * 0.6  (s)
      k = 4.0 / duration

  Under exponential decay θ(t) = θ₀ + (v0/k)(1 - e^-kt), the ball's final
  resting angle (as t → ∞ with our t→T ≈ 98% decayed) is θ₀ + v0/k ≈
  `v0 * duration / 4 * (1 - e^-4)`. The JS client runs the identical
  formula against the same seed, so both sides converge on the same
  landing slice bit-for-bit.
  """
  def simulate_landing_slice(seed, slice_count)
      when is_integer(seed) and is_integer(slice_count) and slice_count > 0 do
    v0_frac = rem(seed, 65_536) / 65_536.0
    v0 = 540.0 + v0_frac * 280.0

    dur_frac = rem(div(seed, 65_536), 65_536) / 65_536.0
    duration = 3.0 + dur_frac * 0.6

    k = 4.0 / duration
    total_rotation = v0 / k * (1 - :math.exp(-4.0))

    slice_deg = 360.0 / slice_count
    wrapped = :math.fmod(total_rotation, 360.0)
    wrapped = if wrapped < 0, do: wrapped + 360.0, else: wrapped

    slice = trunc(wrapped / slice_deg)
    rem(slice, slice_count)
  end

  @doc "Candidate map by external_id (for quick lookup)."
  def candidate_by_id(%__MODULE__{candidates: cs}, external_id) do
    Enum.find(cs, &(&1.external_id == external_id))
  end

  @doc "Tallies map `%{external_id => count}` for voting."
  def tallies(%__MODULE__{votes: votes}) do
    Enum.into(votes, %{}, fn {ext, set} -> {ext, MapSet.size(set)} end)
  end

  @doc "Whether this round struct is still `:active` and not expired."
  def active?(%__MODULE__{phase: :active}), do: true
  def active?(_), do: false

  defp initial_votes(:voting, candidates) do
    Enum.into(candidates, %{}, fn c -> {c.external_id, MapSet.new()} end)
  end

  defp initial_votes(_, _), do: %{}
end
