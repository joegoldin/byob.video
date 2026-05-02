defmodule Byob.MediaItem do
  defstruct [
    :id,
    :url,
    :source_type,
    :source_id,
    :title,
    :duration,
    :thumbnail_url,
    :published_at,
    :added_by,
    :added_by_name,
    :added_at,
    is_live: false
  ]

  @youtube_hosts ~w(youtube.com www.youtube.com m.youtube.com youtu.be)
  @vimeo_hosts ~w(vimeo.com www.vimeo.com player.vimeo.com)
  @twitch_hosts ~w(twitch.tv www.twitch.tv m.twitch.tv)

  @drm_hosts [
    {"netflix.com", "Netflix"},
    {"disneyplus.com", "Disney+"},
    {"max.com", "Max"},
    {"hbomax.com", "Max"},
    {"hulu.com", "Hulu"},
    {"primevideo.com", "Prime Video"},
    {"tv.apple.com", "Apple TV+"},
    {"peacocktv.com", "Peacock"},
    {"paramountplus.com", "Paramount+"}
  ]

  def parse_url(url) when is_binary(url) and url != "" do
    url = normalize_url(url)

    case URI.parse(url) do
      %URI{scheme: scheme, host: host} = uri
      when scheme in ["http", "https"] and is_binary(host) ->
        cond do
          self_reference?(host) ->
            {:error, :self_reference}

          service = drm_service(host) ->
            {:error, :drm_site, service}

          true ->
            {source_type, source_id} = classify(host, uri)
            is_live = live?(host, uri, source_type)

            {:ok,
             %__MODULE__{
               id: generate_id(),
               url: url,
               source_type: source_type,
               source_id: source_id,
               is_live: is_live
             }}
        end

      _ ->
        {:error, :invalid_url}
    end
  end

  def parse_url(_), do: {:error, :invalid_url}

  # Accept URLs pasted without a scheme (e.g. `www.youtube.com/watch?v=…`
  # or `youtube.com/watch?v=…`). The bare-hostname check requires a `.`
  # somewhere in the first path segment so we don't promote arbitrary
  # garbage like `not-a-url-at-all` into a fake `https://` URL — that
  # would defeat the {:error, :invalid_url} guard.
  defp normalize_url(url) do
    trimmed = String.trim(url)

    cond do
      String.starts_with?(trimmed, ["http://", "https://"]) ->
        trimmed

      Regex.match?(~r/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/, trimmed) ->
        "https://" <> trimmed

      true ->
        trimmed
    end
  end

  defp self_reference?(host) when is_binary(host) do
    host in self_hosts()
  end

  defp self_reference?(_), do: false

  defp self_hosts do
    endpoint_host =
      case Application.get_env(:byob, ByobWeb.Endpoint) do
        nil -> nil
        cfg -> get_in(cfg, [:url, :host])
      end

    ["byob.video", "www.byob.video", endpoint_host]
    |> Enum.reject(&is_nil/1)
  end

  defp drm_service(host) when is_binary(host) do
    Enum.find_value(@drm_hosts, fn {domain, name} ->
      if host == domain or String.ends_with?(host, "." <> domain), do: name
    end)
  end

  defp drm_service(_), do: nil

  @doc """
  Extracts the last `http(s)://` URL from a string, trimming trailing punctuation.
  Returns the URL or `nil`.
  """
  def extract_url(text) when is_binary(text) do
    # Non-greedy match with a lookahead so adjacent URLs with no separator
    # (e.g. `https://a.comhttps://b.com`) still split into two candidates and
    # the last one wins.
    case Regex.scan(~r{https?://\S+?(?=https?://|\s|$)}, text) do
      [] ->
        nil

      matches ->
        [url] = List.last(matches)
        Regex.replace(~r/[,.;:)\]}>"']+$/, url, "")
    end
  end

  def extract_url(_), do: nil

  @video_extensions ~w(.mp4 .webm .ogg .mov .mkv .avi .m4v)

  defp classify(host, uri) do
    cond do
      youtube_host?(host) -> {:youtube, extract_youtube_id(host, uri)}
      vimeo_host?(host) -> {:vimeo, extract_vimeo_id(host, uri)}
      direct_video_url?(uri) -> {:direct_url, nil}
      true -> {:extension_required, nil}
    end
  end

  defp direct_video_url?(%URI{path: path}) when is_binary(path) do
    ext = path |> String.downcase() |> Path.extname()
    ext in @video_extensions
  end

  defp direct_video_url?(_), do: false

  defp youtube_host?(host), do: host in @youtube_hosts
  defp vimeo_host?(host), do: host in @vimeo_hosts
  defp twitch_host?(host), do: host in @twitch_hosts

  # Best-effort live detection. False positives are mostly harmless
  # (the worst case is a non-live video that won't allow time-based
  # sync — user can re-add as a normal URL). False negatives mean
  # the player will fight live's "you can't seek there" reality.
  defp live?(host, %URI{path: path} = _uri, _source_type) when is_binary(path) do
    cond do
      # YouTube /live/<id> is a redirect alias for live (or scheduled
      # premiere) videos. Regular live broadcasts also live under
      # /watch?v=<id> — those we can't tell apart from VODs at parse
      # time, so leave them as not-live and let the user override
      # later if we ever add an "is live" toggle.
      youtube_host?(host) and Regex.match?(~r{^/live/}, path) -> true
      # Twitch: /<channel> is always a live channel page. /videos/<id>
      # is a VOD which DOES support seeking. Everything else (clips,
      # categories, etc.) we treat as live since extension-required
      # sync without seek is the safer default for them.
      twitch_host?(host) and not Regex.match?(~r{^/videos/}, path) -> true
      true -> false
    end
  end

  defp live?(_, _, _), do: false

  # Vimeo URLs: vimeo.com/123456789, player.vimeo.com/video/123456789
  defp extract_vimeo_id(_host, %URI{path: path}) when is_binary(path) do
    case Regex.run(~r{/(?:video/)?(\d+)}, path) do
      [_, id] -> id
      _ -> nil
    end
  end

  defp extract_vimeo_id(_, _), do: nil

  defp extract_youtube_id("youtu.be", %URI{path: "/" <> id}) do
    id |> String.split("?") |> hd()
  end

  defp extract_youtube_id(_host, %URI{path: path, query: query}) do
    cond do
      # /watch?v=ID
      path == "/watch" and is_binary(query) ->
        query |> URI.decode_query() |> Map.get("v")

      # /embed/ID, /shorts/ID, /live/ID
      match = Regex.run(~r{^/(?:embed|shorts|live)/([^/?]+)}, path || "") ->
        Enum.at(match, 1)

      true ->
        nil
    end
  end

  defp generate_id, do: :crypto.strong_rand_bytes(16) |> Base.url_encode64(padding: false)
end
