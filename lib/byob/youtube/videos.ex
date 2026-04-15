defmodule Byob.YouTube.Videos do
  @moduledoc """
  Fetches YouTube video metadata (duration, published date, title, thumbnail,
  channel) via the Data API v3 `videos.list` endpoint.

  Falls back gracefully when the API key is missing or quota is exhausted —
  callers should treat `{:error, _}` as "enrich with oEmbed or skip".
  """

  require Logger

  @api_url "https://www.googleapis.com/youtube/v3/videos"
  @cache_table :youtube_videos_cache
  @cache_ttl_seconds 24 * 60 * 60

  @doc """
  Fetch metadata for a YouTube video.

  Returns `{:ok, %{title, author_name, thumbnail_url, duration, published_at}}`
  or `{:error, reason}`.
  """
  def fetch(video_id) when is_binary(video_id) do
    with :ok <- check_api_key(),
         :ok <- check_quota(),
         {:cache, :miss} <- {:cache, lookup_cache(video_id)} do
      do_fetch(video_id)
    else
      {:error, _} = err -> err
      {:cache, {:hit, result}} -> {:ok, result}
    end
  end

  def fetch(_), do: {:error, :invalid_id}

  # --- API key / quota ---

  defp check_api_key do
    case Application.get_env(:byob, :youtube_api_key) do
      nil -> {:error, :not_configured}
      "" -> {:error, :not_configured}
      _key -> :ok
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

  # --- ETS cache ---

  defp lookup_cache(video_id) do
    case :ets.whereis(@cache_table) do
      :undefined ->
        :miss

      _ ->
        case :ets.lookup(@cache_table, video_id) do
          [{^video_id, result, inserted_at}] ->
            age = DateTime.diff(DateTime.utc_now(), inserted_at, :second)

            if age < @cache_ttl_seconds do
              {:hit, result}
            else
              :ets.delete(@cache_table, video_id)
              :miss
            end

          [] ->
            :miss
        end
    end
  end

  defp store_cache(video_id, result) do
    case :ets.whereis(@cache_table) do
      :undefined -> :ok
      _ -> :ets.insert(@cache_table, {video_id, result, DateTime.utc_now()})
    end
  end

  # --- HTTP ---

  defp do_fetch(video_id) do
    api_key = Application.get_env(:byob, :youtube_api_key)

    params = [part: "snippet,contentDetails", id: video_id, key: api_key]

    case http_get(@api_url, params) do
      {:ok, %{status: 200, body: %{"items" => [item | _]}}} ->
        result = parse_item(item)
        store_cache(video_id, result)
        {:ok, result}

      {:ok, %{status: 200, body: %{"items" => []}}} ->
        {:error, :not_found}

      {:ok, %{status: 403, body: body}} when is_map(body) ->
        if quota_exceeded?(body) do
          set_quota_exhausted()
          {:error, :quota_exhausted}
        else
          {:error, {:http_error, 403, body}}
        end

      {:ok, %{status: status}} ->
        {:error, {:http_error, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc false
  def http_get(url, params) do
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

  # --- Response parsing ---

  @doc false
  def parse_item(%{"snippet" => snippet, "contentDetails" => details}) do
    thumbnails = snippet["thumbnails"] || %{}

    thumb =
      get_in(thumbnails, ["maxres", "url"]) ||
        get_in(thumbnails, ["high", "url"]) ||
        get_in(thumbnails, ["medium", "url"]) ||
        get_in(thumbnails, ["default", "url"])

    %{
      title: snippet["title"],
      author_name: snippet["channelTitle"],
      thumbnail_url: thumb,
      duration: parse_iso_duration(details["duration"]),
      published_at: snippet["publishedAt"]
    }
  end

  def parse_item(_), do: nil

  @doc """
  Parse an ISO 8601 duration string (e.g. `"PT1H23M45S"`) into total seconds.
  Returns `nil` for unparseable input.
  """
  def parse_iso_duration("PT" <> rest) when byte_size(rest) > 0 do
    Regex.scan(~r/(\d+)([HMS])/, rest)
    |> Enum.reduce(0, fn [_, num, unit], acc ->
      n = String.to_integer(num)

      acc +
        case unit do
          "H" -> n * 3600
          "M" -> n * 60
          "S" -> n
        end
    end)
    |> case do
      0 -> nil
      n -> n
    end
  end

  def parse_iso_duration(_), do: nil
end
