defmodule Byob.YouTube.Comments do
  @moduledoc """
  Fetches YouTube comment threads via the Data API v3, with ETS caching
  and daily quota-exhaustion tracking.
  """

  require Logger

  @api_url "https://www.googleapis.com/youtube/v3/commentThreads"
  @cache_table :youtube_comments_cache
  @cache_ttl_seconds 15 * 60

  @doc """
  Fetch top-level comment threads for a YouTube video.

  Options:
    - `:page_token` — pagination token from a previous response

  Returns `{:ok, %{comments: [...], next_page_token: token | nil, total_count: integer}}`
  or `{:error, reason}`.
  """
  def fetch(video_id, opts \\ []) do
    page_token = opts[:page_token]

    with :ok <- check_api_key(),
         :ok <- check_quota(),
         {:cache, :miss} <- {:cache, lookup_cache(video_id, page_token)} do
      do_fetch(video_id, page_token)
    else
      {:error, _} = err -> err
      {:cache, {:hit, result}} -> {:ok, result}
    end
  end

  # --- API key ---

  defp check_api_key do
    case Application.get_env(:byob, :youtube_api_key) do
      nil -> {:error, :not_configured}
      "" -> {:error, :not_configured}
      _key -> :ok
    end
  end

  # --- Quota flag ---

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

  defp cache_key(video_id, page_token), do: {video_id, page_token}

  defp lookup_cache(video_id, page_token) do
    key = cache_key(video_id, page_token)

    case :ets.lookup(@cache_table, key) do
      [{^key, result, inserted_at}] ->
        age = DateTime.diff(DateTime.utc_now(), inserted_at, :second)

        if age < @cache_ttl_seconds do
          {:hit, result}
        else
          :ets.delete(@cache_table, key)
          :miss
        end

      [] ->
        :miss
    end
  end

  defp store_cache(video_id, page_token, result) do
    key = cache_key(video_id, page_token)
    :ets.insert(@cache_table, {key, result, DateTime.utc_now()})
  end

  # --- HTTP ---

  defp do_fetch(video_id, page_token) do
    api_key = Application.get_env(:byob, :youtube_api_key)

    params =
      [
        part: "snippet",
        videoId: video_id,
        order: "relevance",
        maxResults: 20,
        textFormat: "plainText",
        key: api_key
      ]
      |> maybe_add_page_token(page_token)

    case http_get(@api_url, params) do
      {:ok, %{status: 200, body: body}} when is_map(body) ->
        result = parse_response(body)
        store_cache(video_id, page_token, result)
        {:ok, result}

      {:ok, %{status: 403, body: body}} when is_map(body) ->
        if quota_exceeded?(body) do
          set_quota_exhausted()
          {:error, :quota_exhausted}
        else
          {:error, {:http_error, 403, body}}
        end

      {:ok, %{status: 404}} ->
        {:ok, empty_result()}

      {:ok, %{status: status, body: body}} ->
        if comments_disabled?(status, body) do
          {:ok, empty_result()}
        else
          {:error, {:http_error, status}}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp maybe_add_page_token(params, nil), do: params
  defp maybe_add_page_token(params, token), do: params ++ [pageToken: token]

  # Extracted for testability — can be overridden in tests via Mox or similar.
  @doc false
  def http_get(url, params) do
    Req.get(url, params: params, receive_timeout: 10_000)
  end

  # --- Response parsing ---

  @doc false
  def parse_response(body) do
    items = body["items"] || []

    comments =
      Enum.map(items, fn item ->
        snippet = get_in(item, ["snippet", "topLevelComment", "snippet"]) || %{}

        %{
          author: snippet["authorDisplayName"],
          author_avatar: snippet["authorProfileImageUrl"],
          text: snippet["textDisplay"],
          likes: snippet["likeCount"] || 0,
          published_at: snippet["publishedAt"],
          reply_count: get_in(item, ["snippet", "totalReplyCount"]) || 0
        }
      end)

    %{
      comments: comments,
      next_page_token: body["nextPageToken"],
      total_count: get_in(body, ["pageInfo", "totalResults"]) || 0
    }
  end

  defp empty_result do
    %{comments: [], next_page_token: nil, total_count: 0}
  end

  defp quota_exceeded?(body) do
    errors = get_in(body, ["error", "errors"]) || []
    Enum.any?(errors, fn e -> e["reason"] == "quotaExceeded" end)
  end

  defp comments_disabled?(status, body) when status in [400, 403] do
    errors = get_in(body, ["error", "errors"]) || []
    Enum.any?(errors, fn e -> e["reason"] == "commentsDisabled" end)
  end

  defp comments_disabled?(_status, _body), do: false
end
