defmodule Byob.YouTube.Playlists do
  @moduledoc """
  Fetches a YouTube playlist's items (video id, title, thumbnail, channel,
  position) via the Data API v3 `playlistItems.list` endpoint.

  v1 fetches the first page only (max 50 items). The response includes a
  `truncated?` flag the UI can surface ("showing first 50 of N — paste
  individual videos to add the rest"). Paginating across hundreds of
  items would burn through quota fast, and most "watch a playlist together"
  use cases involve the first ~hour of content anyway.

  Mirrors `Byob.YouTube.Videos`'s shape: same API key check, same quota
  back-pressure, same ETS cache. Returns `{:error, reason}` so callers
  can fall back to single-video preview when no key / quota out / private
  playlist.
  """

  require Logger

  @api_url "https://www.googleapis.com/youtube/v3/playlistItems"
  @list_api_url "https://www.googleapis.com/youtube/v3/playlists"
  @cache_table :youtube_playlists_cache
  @cache_ttl_seconds 60 * 60
  @max_items 50

  @doc """
  Returns `{:ok, %{title, channel_title, items: [item, ...], truncated?: bool, total_count: int}}`
  or `{:error, reason}` on missing key, exhausted quota, network issue, or
  not-found / private playlist.

  Each `item` has `%{video_id, title, thumbnail_url, channel_title, position}`.
  """
  def fetch(playlist_id) when is_binary(playlist_id) do
    with :ok <- check_api_key(),
         :ok <- check_quota(),
         {:cache, :miss} <- {:cache, lookup_cache(playlist_id)} do
      do_fetch(playlist_id)
    else
      {:error, _} = err -> err
      {:cache, {:hit, result}} -> {:ok, result}
    end
  end

  def fetch(_), do: {:error, :invalid_id}

  defp check_api_key do
    case Application.get_env(:byob, :youtube_api_key) do
      nil -> {:error, :not_configured}
      "" -> {:error, :not_configured}
      _ -> :ok
    end
  end

  defp check_quota do
    case Application.get_env(:byob, :youtube_quota_exhausted) do
      {true, date} ->
        if date == Date.utc_today() do
          {:error, :quota_exhausted}
        else
          Application.delete_env(:byob, :youtube_quota_exhausted)
          :ok
        end

      _ ->
        :ok
    end
  end

  defp set_quota_exhausted do
    Application.put_env(:byob, :youtube_quota_exhausted, {true, Date.utc_today()})
  end

  defp lookup_cache(playlist_id) do
    case :ets.whereis(@cache_table) do
      :undefined ->
        :miss

      _ ->
        case :ets.lookup(@cache_table, playlist_id) do
          [{^playlist_id, result, inserted_at}] ->
            age = DateTime.diff(DateTime.utc_now(), inserted_at, :second)

            if age < @cache_ttl_seconds do
              {:hit, result}
            else
              :ets.delete(@cache_table, playlist_id)
              :miss
            end

          [] ->
            :miss
        end
    end
  end

  defp store_cache(playlist_id, result) do
    case :ets.whereis(@cache_table) do
      :undefined -> :ok
      _ -> :ets.insert(@cache_table, {playlist_id, result, DateTime.utc_now()})
    end
  end

  defp do_fetch(playlist_id) do
    api_key = Application.get_env(:byob, :youtube_api_key)

    items_params = [
      part: "snippet,contentDetails",
      playlistId: playlist_id,
      maxResults: @max_items,
      key: api_key
    ]

    list_params = [part: "snippet,contentDetails", id: playlist_id, key: api_key]

    with {:ok, items_resp} <- http_get(@api_url, items_params),
         {:ok, list_resp} <- http_get(@list_api_url, list_params) do
      handle_responses(items_resp, list_resp, playlist_id)
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp handle_responses(
         %{status: 200, body: %{"items" => items} = items_body},
         %{status: 200, body: %{"items" => [list_item | _]}},
         playlist_id
       ) do
    snippet = list_item["snippet"] || %{}
    details = list_item["contentDetails"] || %{}
    total = details["itemCount"] || length(items)

    parsed =
      items
      |> Enum.map(&parse_item/1)
      |> Enum.reject(&is_nil/1)

    next_token = items_body["nextPageToken"]

    result = %{
      playlist_id: playlist_id,
      title: snippet["title"],
      channel_title: snippet["channelTitle"],
      total_count: total,
      truncated?: is_binary(next_token) and next_token != "",
      items: parsed
    }

    store_cache(playlist_id, result)
    {:ok, result}
  end

  defp handle_responses(%{status: 404}, _, _), do: {:error, :not_found}
  defp handle_responses(_, %{status: 404}, _), do: {:error, :not_found}

  defp handle_responses(%{status: 403, body: body}, _, _) when is_map(body) do
    if quota_exceeded?(body) do
      set_quota_exhausted()
      {:error, :quota_exhausted}
    else
      {:error, {:http_error, 403, body}}
    end
  end

  defp handle_responses(_, %{status: 403, body: body}, _) when is_map(body) do
    if quota_exceeded?(body) do
      set_quota_exhausted()
      {:error, :quota_exhausted}
    else
      {:error, {:http_error, 403, body}}
    end
  end

  defp handle_responses(%{status: status}, _, _) when status != 200 do
    {:error, {:http_error, status}}
  end

  defp handle_responses(_, %{status: status}, _) when status != 200 do
    {:error, {:http_error, status}}
  end

  defp handle_responses(_, _, _), do: {:error, :unexpected_response}

  defp http_get(url, params) do
    Req.get(url, params: params, receive_timeout: 5_000)
  end

  defp quota_exceeded?(body) do
    reasons =
      body
      |> get_in(["error", "errors"])
      |> Kernel.||([])
      |> Enum.map(& &1["reason"])

    "quotaExceeded" in reasons or "dailyLimitExceeded" in reasons
  end

  defp parse_item(%{"snippet" => snippet, "contentDetails" => details}) do
    video_id = details["videoId"] || get_in(snippet, ["resourceId", "videoId"])
    if is_nil(video_id), do: nil, else: build_item(video_id, snippet)
  end

  defp parse_item(_), do: nil

  defp build_item(video_id, snippet) do
    thumbnails = snippet["thumbnails"] || %{}

    thumb =
      get_in(thumbnails, ["medium", "url"]) ||
        get_in(thumbnails, ["high", "url"]) ||
        get_in(thumbnails, ["default", "url"])

    %{
      video_id: video_id,
      title: snippet["title"],
      thumbnail_url: thumb,
      channel_title: snippet["videoOwnerChannelTitle"] || snippet["channelTitle"],
      position: snippet["position"] || 0
    }
  end
end
