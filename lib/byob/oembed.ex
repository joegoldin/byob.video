defmodule Byob.OEmbed do
  @youtube_oembed "https://www.youtube.com/oembed"

  @doc """
  Fetches oEmbed metadata for a YouTube URL. Returns {:ok, metadata} or {:error, reason}.
  Metadata map has :title, :thumbnail_url, :author_name keys.
  """
  def fetch_youtube(url) do
    case Req.get(@youtube_oembed, params: [url: url, format: "json"]) do
      {:ok, %{status: 200, body: body}} when is_map(body) ->
        {:ok,
         %{
           title: body["title"],
           thumbnail_url: body["thumbnail_url"],
           author_name: body["author_name"]
         }}

      {:ok, %{status: status}} ->
        {:error, {:http_error, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end
end
