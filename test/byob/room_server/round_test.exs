defmodule Byob.RoomServer.RoundTest do
  use ExUnit.Case, async: true

  import Bitwise, only: [<<<: 2]

  alias Byob.RoomServer.Round

  defp candidates(n) do
    for i <- 1..n do
      %{
        external_id: "vid#{i}",
        title: "Video #{i}",
        channel: nil,
        duration_s: 60 * i,
        thumbnail_url: nil,
        source_type: :trending
      }
    end
  end

  describe "new/3" do
    test "creates an active voting round" do
      r = Round.new(:voting, "u1", candidates(6))
      assert r.mode == :voting
      assert r.phase == :active
      assert r.started_by == "u1"
      assert length(r.candidates) == 6
      assert map_size(r.votes) == 6
      assert r.expires_at - r.started_at == Round.vote_duration_ms()
    end

    test "creates an active roulette round" do
      r = Round.new(:roulette, "u1", candidates(6))
      assert r.mode == :roulette
      assert r.phase == :active
      assert r.votes == %{}
      assert r.seed == nil
      # Uses the module's configured roulette duration.
      assert r.expires_at - r.started_at == Round.roulette_duration_ms()
      assert Round.roulette_duration_ms() == 6_500
    end
  end

  describe "cast_vote/3" do
    setup do
      {:ok, round: Round.new(:voting, "u1", candidates(3))}
    end

    test "records a vote", %{round: r} do
      r = Round.cast_vote(r, "u1", "vid1")
      assert MapSet.member?(r.votes["vid1"], "u1")
      assert Round.tallies(r)["vid1"] == 1
    end

    test "replaces a previous vote by same user", %{round: r} do
      r = Round.cast_vote(r, "u1", "vid1")
      r = Round.cast_vote(r, "u1", "vid2")
      assert MapSet.size(r.votes["vid1"]) == 0
      assert MapSet.member?(r.votes["vid2"], "u1")
    end

    test "ignores vote for non-candidate", %{round: r} do
      r = Round.cast_vote(r, "u1", "nonexistent")
      assert Round.tallies(r) == %{"vid1" => 0, "vid2" => 0, "vid3" => 0}
    end

    test "tracks multiple voters independently", %{round: r} do
      r = Round.cast_vote(r, "u1", "vid1")
      r = Round.cast_vote(r, "u2", "vid1")
      r = Round.cast_vote(r, "u3", "vid2")
      assert Round.tallies(r) == %{"vid1" => 2, "vid2" => 1, "vid3" => 0}
      assert Round.total_voters(r) == 3
    end
  end

  describe "resolve/1 voting" do
    test "picks the candidate with most votes" do
      r =
        Round.new(:voting, "u1", candidates(3))
        |> Round.cast_vote("u1", "vid2")
        |> Round.cast_vote("u2", "vid2")
        |> Round.cast_vote("u3", "vid1")

      {r, outcome} = Round.resolve(r)
      assert outcome == :winner_chosen
      assert r.winner_external_id == "vid2"
      assert r.phase == :revealing
    end

    test "returns :no_votes when no one voted" do
      r = Round.new(:voting, "u1", candidates(3))
      {r, outcome} = Round.resolve(r)
      assert outcome == :no_votes
      assert r.winner_external_id == nil
    end

    test "random tiebreak picks one of the tied candidates" do
      r =
        Round.new(:voting, "u1", candidates(3))
        |> Round.cast_vote("u1", "vid1")
        |> Round.cast_vote("u2", "vid2")

      {r, outcome} = Round.resolve(r)
      assert outcome == :winner_chosen
      assert r.winner_external_id in ["vid1", "vid2"]
    end
  end

  describe "resolve/1 roulette" do
    test "assigns a seed and picks a winner deterministically from it" do
      r = Round.new(:roulette, "u1", candidates(6))
      {resolved, outcome} = Round.resolve(r)

      assert outcome == :winner_chosen
      assert is_integer(resolved.seed)
      # Winner is the physics simulation's landing slice for that seed
      expected_slice = Round.simulate_landing_slice(resolved.seed, 6)
      expected = Enum.at(r.candidates, expected_slice).external_id
      assert resolved.winner_external_id == expected
    end
  end

  describe "simulate_landing_slice/2" do
    test "is deterministic for a given seed" do
      seed = 1_234_567

      assert Round.simulate_landing_slice(seed, 12) ==
               Round.simulate_landing_slice(seed, 12)
    end

    test "returns an index in [0, slice_count)" do
      for _ <- 1..20 do
        seed = :rand.uniform(1 <<< 32) - 1
        s = Round.simulate_landing_slice(seed, 12)
        assert s >= 0 and s < 12
      end
    end

    test "different seeds produce different slices (mostly)" do
      seeds = for _ <- 1..50, do: :rand.uniform(1 <<< 32) - 1
      slices = Enum.map(seeds, &Round.simulate_landing_slice(&1, 12))
      # 50 seeds over 12 slices — expect more than 1 unique slice
      assert length(Enum.uniq(slices)) > 1
    end
  end
end
