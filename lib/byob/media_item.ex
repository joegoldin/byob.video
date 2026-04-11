defmodule Byob.MediaItem do
  defstruct [:id, :url, :source_type, :source_id, :title, :duration, :thumbnail_url, :added_by, :added_at]

  @youtube_hosts ~w(youtube.com www.youtube.com m.youtube.com youtu.be)

  def parse_url(url) when is_binary(url) and url != "" do
    case URI.parse(url) do
      %URI{scheme: scheme, host: host} when scheme in ["http", "https"] and is_binary(host) ->
        {source_type, source_id} = classify(host, URI.parse(url))

        {:ok,
         %__MODULE__{
           id: generate_id(),
           url: url,
           source_type: source_type,
           source_id: source_id
         }}

      _ ->
        {:error, :invalid_url}
    end
  end

  def parse_url(_), do: {:error, :invalid_url}

  defp classify(host, uri) do
    if youtube_host?(host) do
      {:youtube, extract_youtube_id(host, uri)}
    else
      {:extension_required, nil}
    end
  end

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
