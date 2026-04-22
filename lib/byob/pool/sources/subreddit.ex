defmodule Byob.Pool.Sources.Subreddit do
  @moduledoc """
  Pulls top-of-day posts from a hardcoded list of video-heavy subreddits,
  filters to YouTube links, and returns pool entries.

  Reddit's public JSON endpoints don't require auth; they do require a
  descriptive User-Agent (generic clients get 429'd). We don't fetch YT
  metadata (title/duration/thumbnail) here — we use reddit's `title` + the
  video ID, and rely on the enrichment path when the video later ends up
  in a round. For richness, we ALSO look up the video via `YouTube.Videos`
  if the API key is available — caches in ETS so repeated scrapes of the
  same ID don't cost quota.
  """

  require Logger

  alias Byob.YouTube.Videos

  @subreddits ~w(videos mealtimevideos deepintoyoutube listentothis)
  @limit 50
  @user_agent "byob.video/1.0 (+https://byob.video)"

  @doc "One HTTP call per subreddit; returns combined list of entries."
  def fetch do
    @subreddits
    |> Enum.flat_map(&fetch_subreddit/1)
  end

  defp fetch_subreddit(sub) do
    url = "https://www.reddit.com/r/#{sub}/top.json"
    params = [t: "day", limit: @limit]

    case Req.get(url,
           params: params,
           headers: [{"user-agent", @user_agent}],
           receive_timeout: 10_000
         ) do
      {:ok, %{status: 200, body: %{"data" => %{"children" => children}}}}
      when is_list(children) ->
        children
        |> Enum.map(fn %{"data" => d} -> d end)
        |> Enum.map(&to_entry(&1, sub))
        |> Enum.reject(&is_nil/1)
        |> enrich()

      {:ok, %{status: status}} ->
        Logger.warning("[pool/subreddit:#{sub}] HTTP #{status}")
        []

      {:error, reason} ->
        Logger.warning("[pool/subreddit:#{sub}] #{inspect(reason)}")
        []
    end
  end

  defp to_entry(%{"url" => url, "title" => title, "ups" => ups} = _post, sub)
       when is_binary(url) do
    case extract_yt_id(url) do
      nil ->
        nil

      video_id ->
        %{
          source_type: :subreddit,
          source_detail: sub,
          external_id: video_id,
          title: title || "(untitled)",
          channel: nil,
          duration_s: nil,
          thumbnail_url: "https://i.ytimg.com/vi/#{video_id}/hqdefault.jpg",
          score: ups
        }
    end
  end

  defp to_entry(_, _), do: nil

  # Enrich entries with YT metadata if available (duration, channel, better title).
  # If API key/quota missing, returns entries as-is.
  defp enrich(entries) do
    entries
    |> Enum.map(fn entry ->
      case Videos.fetch(entry.external_id) do
        {:ok, meta} ->
          if meta[:embeddable] == false do
            nil
          else
            %{
              entry
              | title: meta[:title] || entry.title,
                channel: meta[:author_name] || entry.channel,
                duration_s: meta[:duration] || entry.duration_s,
                thumbnail_url: meta[:thumbnail_url] || entry.thumbnail_url
            }
          end

        _ ->
          entry
      end
    end)
    |> Enum.reject(&is_nil/1)
  end

  # Match the patterns most common on reddit:
  #   youtube.com/watch?v=ID
  #   youtu.be/ID
  #   youtube.com/shorts/ID
  #   youtube.com/embed/ID
  #   youtube.com/v/ID
  @yt_host_pattern ~r|^(?:https?:)?//(?:www\.)?(?:m\.)?youtube\.com/|i
  @yt_short_pattern ~r|^(?:https?:)?//(?:www\.)?youtu\.be/|i

  def extract_yt_id(url) when is_binary(url) do
    cond do
      Regex.match?(@yt_short_pattern, url) ->
        match_short(url)

      Regex.match?(@yt_host_pattern, url) ->
        match_long(url)

      true ->
        nil
    end
  end

  def extract_yt_id(_), do: nil

  defp match_short(url) do
    case Regex.run(~r|youtu\.be/([A-Za-z0-9_-]{11})|, url) do
      [_, id] -> id
      _ -> nil
    end
  end

  defp match_long(url) do
    cond do
      id = run_capture(~r|[?&]v=([A-Za-z0-9_-]{11})|, url) ->
        id

      id = run_capture(~r|/shorts/([A-Za-z0-9_-]{11})|, url) ->
        id

      id = run_capture(~r|/embed/([A-Za-z0-9_-]{11})|, url) ->
        id

      id = run_capture(~r|/v/([A-Za-z0-9_-]{11})|, url) ->
        id

      true ->
        nil
    end
  end

  defp run_capture(re, url) do
    case Regex.run(re, url) do
      [_, id] -> id
      _ -> nil
    end
  end
end
