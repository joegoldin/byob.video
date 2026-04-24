defmodule Byob.Pool.Sources.Curated do
  @moduledoc """
  Expands a hardcoded list of YouTube playlist IDs via the Data API v3
  `playlistItems.list` endpoint into individual video entries.

  Playlists change slowly, so this source is scraped on a much longer
  cadence than the others (daily rather than hourly). A single playlist
  can be hundreds of items, so this runs a pagination loop.

  To add/remove curated playlists, edit `@curated_playlists` below.
  """

  require Logger

  alias Byob.YouTube.Videos

  @api_url "https://www.googleapis.com/youtube/v3/playlistItems"

  @curated_playlists [
    "PLmur3Z0Afau5t4kKbwmCsrXUiyUoZBQ5m",
    "PLmur3Z0Afau4xMQrGmNI20OUu1_jBWRIo",
    "PLmur3Z0Afau6t-ab7uUZZnAtWZuLyMW9r",
    "PLmur3Z0Afau4wSl9By0h8qIgOBbN9Zmhd",
    "PLEbAHi3fZpuEyBOPtr158TY-FW7P1l4Fg",
    "PL8hhMHBxIcj2slXZOJHs8_lESmVDIR0U9",
    "PLDIpOnnnyGLC9-1hn4lcNlrWDF2ktOtTp",
    "PLFz4Zf531DCDlhwNQLk64yJwofKHyu9jo",
    "PLGGr2yYc6y6QINtXVgc5BUw8qeb44dI48",
    "PLdUGA0NFIvcCrfMeI_iuaEP0iyGPnbryJ",
    "PLcLtbK8Nf64InyudI1rnYwwRbCr08yup_",
    "PLDWYWQX-Q1O6gpctyJS9SlQBIPnuXuuWQ"
  ]

  def playlists, do: @curated_playlists

  @doc "Returns combined entries across all curated playlists. `[]` on any error per playlist."
  def fetch do
    case Application.get_env(:byob, :youtube_api_key) do
      key when is_binary(key) and byte_size(key) > 0 ->
        @curated_playlists
        |> Enum.flat_map(&fetch_playlist(&1, key))

      _ ->
        []
    end
  end

  @doc "Fetches one playlist. Exposed for ad-hoc use."
  def fetch_playlist(playlist_id, api_key) do
    do_page(playlist_id, api_key, nil, [])
  end

  defp do_page(playlist_id, api_key, page_token, acc) do
    base_params = [
      part: "snippet,contentDetails",
      playlistId: playlist_id,
      maxResults: 50,
      key: api_key
    ]

    params =
      if page_token, do: base_params ++ [pageToken: page_token], else: base_params

    case Videos.http_get(@api_url, params) do
      {:ok, %{status: 200, body: %{"items" => items, "nextPageToken" => next_token}}}
      when is_list(items) ->
        new_entries =
          items
          |> Enum.map(&to_entry(&1, playlist_id))
          |> Enum.reject(&is_nil/1)

        do_page(playlist_id, api_key, next_token, acc ++ new_entries)

      {:ok, %{status: 200, body: %{"items" => items}}} when is_list(items) ->
        # Last page (no nextPageToken).
        new_entries =
          items
          |> Enum.map(&to_entry(&1, playlist_id))
          |> Enum.reject(&is_nil/1)

        acc ++ new_entries

      {:ok, %{status: status}} ->
        Logger.warning("[pool/curated:#{playlist_id}] HTTP #{status}")
        acc

      {:error, reason} ->
        Logger.warning("[pool/curated:#{playlist_id}] #{inspect(reason)}")
        acc
    end
  end

  defp to_entry(item, playlist_id) do
    snippet = item["snippet"] || %{}
    details = item["contentDetails"] || %{}
    video_id = details["videoId"] || snippet["resourceId"]["videoId"]

    if is_binary(video_id) do
      thumbnails = snippet["thumbnails"] || %{}

      thumb =
        get_in(thumbnails, ["maxres", "url"]) ||
          get_in(thumbnails, ["high", "url"]) ||
          get_in(thumbnails, ["medium", "url"]) ||
          get_in(thumbnails, ["default", "url"]) ||
          "https://i.ytimg.com/vi/#{video_id}/hqdefault.jpg"

      %{
        source_type: :curated,
        source_detail: playlist_id,
        external_id: video_id,
        title: snippet["title"] || "(untitled)",
        channel: snippet["videoOwnerChannelTitle"] || snippet["channelTitle"],
        duration_s: nil,
        thumbnail_url: thumb,
        score: nil
      }
    else
      nil
    end
  end
end
