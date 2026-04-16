defmodule Byob.Pool.Sources.Trending do
  @moduledoc """
  Fetches the current YouTube Trending list via the Data API v3
  `videos.list?chart=mostPopular` endpoint. Returns a list of `%{}`-shaped
  entries ready to feed into `Byob.Pool.upsert/1`.

  Falls back to an empty list when the API key is missing or the quota is
  out — the pool simply won't grow from this source until it's restored.
  """

  require Logger

  alias Byob.YouTube.Videos

  @api_url "https://www.googleapis.com/youtube/v3/videos"
  @region "US"
  @max_results 50

  @doc """
  One HTTP call, up to 50 entries. Returns `[]` on any error.
  """
  def fetch do
    case Application.get_env(:byob, :youtube_api_key) do
      key when is_binary(key) and byte_size(key) > 0 -> do_fetch(key)
      _ -> []
    end
  end

  defp do_fetch(api_key) do
    params = [
      part: "snippet,contentDetails",
      chart: "mostPopular",
      regionCode: @region,
      maxResults: @max_results,
      key: api_key
    ]

    case Videos.http_get(@api_url, params) do
      {:ok, %{status: 200, body: %{"items" => items}}} when is_list(items) ->
        items
        |> Enum.with_index()
        |> Enum.map(fn {item, rank} -> to_entry(item, rank) end)
        |> Enum.reject(&is_nil/1)

      {:ok, %{status: status}} ->
        Logger.warning("[pool/trending] HTTP #{status}")
        []

      {:error, reason} ->
        Logger.warning("[pool/trending] #{inspect(reason)}")
        []
    end
  end

  defp to_entry(%{"id" => id} = item, rank) when is_binary(id) do
    meta = Videos.parse_item(item) || %{}

    %{
      source_type: :trending,
      source_detail: @region,
      external_id: id,
      title: meta[:title] || "(untitled)",
      channel: meta[:author_name],
      duration_s: meta[:duration],
      thumbnail_url: meta[:thumbnail_url],
      score: rank
    }
  end

  defp to_entry(_, _), do: nil
end
