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
  @roulette_duration_ms 7_000
  @reveal_delay_voting_ms 1_500
  @reveal_delay_roulette_ms 6_500
  # Must be >= MAX_LANDING_MS + SETTLE_MS + FINALIZE_PIE_MS in the JS hook,
  # otherwise the server will finalize before the client finishes animating.

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
      Enum.map(r.candidates, fn c -> {c.external_id, MapSet.size(Map.get(r.votes, c.external_id, MapSet.new()))} end)

    max_votes = tallies |> Enum.map(&elem(&1, 1)) |> Enum.max(fn -> 0 end)

    cond do
      max_votes == 0 ->
        {%{r | phase: :revealing}, :no_votes}

      true ->
        winners = tallies |> Enum.filter(fn {_, v} -> v == max_votes end) |> Enum.map(&elem(&1, 0))
        winner = Enum.random(winners)
        {%{r | phase: :revealing, winner_external_id: winner}, :winner_chosen}
    end
  end

  def resolve(%__MODULE__{mode: :roulette} = r) do
    seed = :rand.uniform(1 <<< 32) - 1
    winner = Enum.at(r.candidates, rem(seed, length(r.candidates))).external_id
    {%{r | phase: :revealing, seed: seed, winner_external_id: winner}, :winner_chosen}
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
