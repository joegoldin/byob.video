defmodule Byob.Pool do
  @moduledoc """
  Public API for the roulette/voting video pool.

  The pool is a server-wide bag of YouTube videos scraped from three sources
  (trending, subreddits, curated playlists). Rooms pick random candidates
  from the pool when a round starts.

  Weighted picking applies:
    * Freshness decay (14-day half-scale) — newer videos picked more often.
      Curated source is exempt.
    * Repeat decay (30-day half-scale) on `last_picked_at` — videos that have
      recently won a round in any room are picked much less often until enough
      time passes.
  """

  require Logger

  @sources [:trending, :subreddit, :curated]
  @per_source 4
  @total_target 12
  @overfetch 6

  @doc """
  Pick up to 6 candidates (2 per source), excluding any `external_id` in
  `exclude_external_ids` (typically the live queue of the triggering room).
  If one source is under-quota (empty DB, dedupe collisions, exclusions),
  backfill from sources that have surplus.

  Returns `{:ok, [candidate_map]}` or `{:error, :no_candidates}`.
  """
  def pick_candidates(exclude_external_ids \\ []) when is_list(exclude_external_ids) do
    per_source =
      @sources
      |> Enum.map(fn source ->
        rows = Byob.Persistence.pick_pool_candidates(source, @overfetch, exclude_external_ids)
        {source, rows}
      end)
      |> Enum.into(%{})

    initial = Enum.map(@sources, fn s -> {s, Enum.take(per_source[s], @per_source)} end)

    # Dedupe across sources by external_id — first occurrence wins.
    {chosen, _seen} =
      Enum.reduce(initial, {[], MapSet.new()}, fn {source, rows}, {acc, seen} ->
        {kept, seen} =
          Enum.reduce(rows, {[], seen}, fn row, {k, s} ->
            if MapSet.member?(s, row.external_id) do
              {k, s}
            else
              {[Map.put(row, :source_bucket, source) | k], MapSet.put(s, row.external_id)}
            end
          end)

        {acc ++ Enum.reverse(kept), seen}
      end)

    # Backfill if under target. Drain surplus rows from per_source that weren't
    # chosen, honoring the dedupe set.
    chosen = backfill(chosen, per_source, MapSet.new(Enum.map(chosen, & &1.external_id)))

    case chosen do
      [] -> {:error, :no_candidates}
      list -> {:ok, Enum.take(list, @total_target)}
    end
  end

  @doc """
  Bulk upsert. `entries` is a list of maps with keys:
  :source_type (atom), :source_detail (string or nil), :external_id (string),
  :title (string), :channel (string or nil), :duration_s (int or nil),
  :thumbnail_url (string or nil), :score (int or nil).
  """
  def upsert(entries) when is_list(entries) do
    entries = Enum.filter(entries, &valid_entry?/1)

    if entries == [] do
      {:ok, 0}
    else
      Byob.Persistence.upsert_pool_entries(entries)
    end
  end

  @doc """
  Mark a video as picked. Updates `last_picked_at` for every row with that
  external_id (the same YT vid may live under multiple source_types).
  """
  def mark_picked(external_id) when is_binary(external_id) do
    Byob.Persistence.mark_pool_picked(external_id)
  end

  # --- private ---

  defp backfill(chosen, _per_source, _seen) when length(chosen) >= @total_target, do: chosen

  defp backfill(chosen, per_source, seen) do
    need = @total_target - length(chosen)

    # Pull surplus rows (beyond the first @per_source) from every source, flatten,
    # and take from them until quota is met.
    surplus =
      per_source
      |> Enum.flat_map(fn {source, rows} ->
        rows |> Enum.drop(@per_source) |> Enum.map(&Map.put(&1, :source_bucket, source))
      end)

    # If still nothing in surplus, also allow dipping into other sources' top-2
    # that weren't already chosen (e.g. dedupe evicted one).
    extras =
      per_source
      |> Enum.flat_map(fn {source, rows} ->
        Enum.map(rows, &Map.put(&1, :source_bucket, source))
      end)

    combined = surplus ++ extras

    picked =
      combined
      |> Enum.reduce_while({[], seen}, fn row, {acc, s} ->
        cond do
          length(acc) >= need -> {:halt, {acc, s}}
          MapSet.member?(s, row.external_id) -> {:cont, {acc, s}}
          true -> {:cont, {[row | acc], MapSet.put(s, row.external_id)}}
        end
      end)
      |> elem(0)
      |> Enum.reverse()

    chosen ++ picked
  end

  defp valid_entry?(%{source_type: st, external_id: id, title: t})
       when st in @sources and is_binary(id) and is_binary(t) and byte_size(id) > 0 and
              byte_size(t) > 0,
       do: true

  defp valid_entry?(_), do: false
end
