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

  @doc """
  Pick up to `total_target` candidates, split across the three sources
  (approximately evenly), excluding any `external_id` in
  `exclude_external_ids` (typically the live queue of the triggering room).

  * Roulette uses 12 (4 per source).
  * Voting uses 5 (~2 per source, rounds up).

  If one source is under-quota (empty DB, dedupe collisions, exclusions),
  backfill from sources that have surplus.

  Returns `{:ok, [candidate_map]}` or `{:error, :no_candidates}`.
  """
  def pick_candidates(exclude_external_ids \\ [], total_target \\ 12)
      when is_list(exclude_external_ids) and is_integer(total_target) and total_target > 0 do
    per_source = div(total_target + length(@sources) - 1, length(@sources))
    overfetch = per_source + 2

    per_source_rows =
      @sources
      |> Enum.map(fn source ->
        rows = Byob.Persistence.pick_pool_candidates(source, overfetch, exclude_external_ids)
        {source, rows}
      end)
      |> Enum.into(%{})

    initial = Enum.map(@sources, fn s -> {s, Enum.take(per_source_rows[s], per_source)} end)

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

    chosen =
      backfill(
        chosen,
        per_source_rows,
        MapSet.new(Enum.map(chosen, & &1.external_id)),
        total_target,
        per_source
      )

    case chosen do
      [] -> {:error, :no_candidates}
      list -> {:ok, Enum.take(list, total_target)}
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

  defp backfill(chosen, _per_source_rows, _seen, total_target, _per_source)
       when length(chosen) >= total_target,
       do: chosen

  defp backfill(chosen, per_source_rows, seen, total_target, per_source) do
    need = total_target - length(chosen)

    # Pull surplus rows (beyond the first `per_source`) from every source.
    surplus =
      per_source_rows
      |> Enum.flat_map(fn {source, rows} ->
        rows |> Enum.drop(per_source) |> Enum.map(&Map.put(&1, :source_bucket, source))
      end)

    # If still nothing in surplus, also allow dipping into other sources' top
    # rows that weren't already chosen (dedupe collisions can evict some).
    extras =
      per_source_rows
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

  defp valid_entry?(%{source_type: st, external_id: id, title: t, thumbnail_url: thumb} = e)
       when st in @sources and is_binary(id) and is_binary(t) and byte_size(id) > 0 and
              byte_size(t) > 0 and is_binary(thumb) and byte_size(thumb) > 0 do
    # Don't admit entries flagged non-embeddable. Sources that don't
    # request the `status` part default to `embeddable: true`, so this
    # only filters when we explicitly know the answer.
    Map.get(e, :embeddable, true) != false
  end

  defp valid_entry?(_), do: false
end
