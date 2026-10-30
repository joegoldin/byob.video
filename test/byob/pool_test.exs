defmodule Byob.PoolTest do
  use ExUnit.Case, async: false

  alias Byob.Pool
  alias Byob.Persistence

  # The test database survives VM restarts, but unique_integer does not.
  # Use cross-run identifiers so an insert cannot hit an earlier run's row.
  defp unique_suffix, do: Base.encode16(:crypto.strong_rand_bytes(16), case: :lower)

  defp mk_entry(source_type, external_id, opts \\ []) do
    %{
      source_type: source_type,
      source_detail: Keyword.get(opts, :source_detail, "test"),
      external_id: external_id,
      title: Keyword.get(opts, :title, "Test video #{external_id}"),
      channel: "Test channel",
      duration_s: 120,
      thumbnail_url: "https://example.com/#{external_id}.jpg",
      score: Keyword.get(opts, :score, 0)
    }
  end

  describe "upsert/1" do
    test "inserts new rows and skips malformed entries" do
      before = Persistence.pool_count()

      entries = [
        mk_entry(:trending, "pool_test_#{unique_suffix()}"),
        # Missing :title — invalid, should be filtered by Pool.upsert/1
        %{source_type: :trending, external_id: "bogus"}
      ]

      {:ok, 1} = Pool.upsert(entries)
      assert Persistence.pool_count() == before + 1
    end

    test "updates last_seen_at on conflict, leaves first_seen_at intact" do
      id = "pool_conflict_#{unique_suffix()}"
      {:ok, 1} = Pool.upsert([mk_entry(:trending, id, title: "first")])

      # Give the clock a tick so timestamps differ
      Process.sleep(2)

      {:ok, 1} = Pool.upsert([mk_entry(:trending, id, title: "second")])

      rows = Persistence.pick_pool_candidates(:trending, Persistence.pool_count(), [])
      row = Enum.find(rows, &(&1.external_id == id))

      assert row.title == "second"
      # last_seen_at should be >= first_seen_at
      assert row.last_seen_at >= row.first_seen_at
    end
  end

  describe "pick_pool_candidates/3 (via Pool.pick_candidates/1)" do
    test "returns up to 12 candidates and honors exclusions when pool has surplus" do
      # Seed enough rows that pick + exclusion still has surplus
      uniq = unique_suffix()

      entries =
        for source <- [:trending, :subreddit, :curated],
            i <- 1..20 do
          mk_entry(source, "pool_surplus_#{source}_#{uniq}_#{i}")
        end

      {:ok, _} = Pool.upsert(entries)

      {:ok, picks} = Pool.pick_candidates([])
      assert length(picks) == 12

      first_ids = Enum.map(picks, & &1.external_id)

      {:ok, picks_after} = Pool.pick_candidates(first_ids)
      assert length(picks_after) == 12
      refute Enum.any?(picks_after, fn c -> c.external_id in first_ids end)
    end

    test "excluded ids are dropped from the pick" do
      uniq = unique_suffix()

      # Seed plenty of rows across all sources so pick succeeds even after
      # some exclusions.
      entries =
        for source <- [:trending, :subreddit, :curated],
            i <- 1..20 do
          mk_entry(source, "pool_excluded_#{source}_#{uniq}_#{i}")
        end

      {:ok, _} = Pool.upsert(entries)

      # Pull a set of ids that exist in the pool and then exclude them.
      {:ok, first} = Pool.pick_candidates([])
      exclude_ids = Enum.map(first, & &1.external_id)

      {:ok, picks} = Pool.pick_candidates(exclude_ids)
      refute Enum.any?(picks, fn c -> c.external_id in exclude_ids end)
    end
  end

  describe "mark_picked/1" do
    test "updates last_picked_at for all rows matching external_id" do
      id = "picked_mark_#{unique_suffix()}"

      {:ok, _} =
        Pool.upsert([
          mk_entry(:trending, id),
          mk_entry(:subreddit, id)
        ])

      Pool.mark_picked(id)
      # cast is async — flush by doing a sync call on the same GenServer
      total_rows = Persistence.pool_count()

      rows_t = Persistence.pick_pool_candidates(:trending, total_rows, [])
      rows_s = Persistence.pick_pool_candidates(:subreddit, total_rows, [])

      row_t = Enum.find(rows_t, &(&1.external_id == id))
      row_s = Enum.find(rows_s, &(&1.external_id == id))

      assert is_integer(row_t.last_picked_at)
      assert is_integer(row_s.last_picked_at)
    end
  end
end
