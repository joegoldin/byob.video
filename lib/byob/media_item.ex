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
    :added_at
  ]

  @youtube_hosts ~w(youtube.com www.youtube.com m.youtube.com youtu.be)

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

            {:ok,
             %__MODULE__{
               id: generate_id(),
               url: url,
               source_type: source_type,
               source_id: source_id
             }}
        end

      _ ->
        {:error, :invalid_url}
    end
  end

  def parse_url(_), do: {:error, :invalid_url}

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
    case Regex.scan(~r{https?://\S+}, text) do
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
