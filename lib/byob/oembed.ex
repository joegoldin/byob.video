defmodule Byob.OEmbed do
  @youtube_oembed "https://www.youtube.com/oembed"

  @doc """
  Fetches oEmbed metadata for a YouTube URL. Returns {:ok, metadata} or {:error, reason}.
  Metadata map has :title, :thumbnail_url, :author_name keys.
  """
  def fetch_youtube(url) do
    case Req.get(@youtube_oembed, params: [url: url, format: "json"], receive_timeout: 5000) do
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

  @doc """
  Fetches OpenGraph metadata (og:title, og:image) from any URL.
  Falls back to <title> tag if no OG tags found.
  """
  def fetch_opengraph(url) do
    if internal_url?(url) do
      {:error, :blocked}
    else
      fetch_opengraph_unsafe(url)
    end
  end

  defp fetch_opengraph_unsafe(url) do
    case Req.get(url, redirect: true, max_redirects: 3, receive_timeout: 5000) do
      {:ok, %{status: 200, body: body}} when is_binary(body) ->
        title =
          extract_meta(body, "og:title") ||
            extract_meta(body, "twitter:title") ||
            extract_tag(body, "title")

        thumbnail =
          extract_meta(body, "og:image") ||
            extract_meta(body, "twitter:image")

        if title || thumbnail do
          {:ok, %{title: title, thumbnail_url: thumbnail, author_name: nil}}
        else
          {:error, :no_metadata}
        end

      _ ->
        {:error, :fetch_failed}
    end
  end

  defp internal_url?(url) do
    case URI.parse(url) do
      %{host: host} when is_binary(host) ->
        case :inet.getaddr(String.to_charlist(host), :inet) do
          {:ok, {127, _, _, _}} -> true
          {:ok, {10, _, _, _}} -> true
          {:ok, {172, b, _, _}} when b >= 16 and b <= 31 -> true
          {:ok, {192, 168, _, _}} -> true
          {:ok, {169, 254, _, _}} -> true
          {:ok, {0, _, _, _}} -> true
          _ -> false
        end

      _ ->
        true
    end
  end

  defp extract_meta(html, property) do
    # Match <meta property="og:title" content="..."> or <meta name="twitter:title" content="...">
    case Regex.run(
           ~r/<meta[^>]*(?:property|name)="#{Regex.escape(property)}"[^>]*content="([^"]*)"/,
           html
         ) do
      [_, value] ->
        value

      _ ->
        # Try reversed attribute order
        case Regex.run(
               ~r/<meta[^>]*content="([^"]*)"[^>]*(?:property|name)="#{Regex.escape(property)}"/,
               html
             ) do
          [_, value] -> value
          _ -> nil
        end
    end
  end

  defp extract_tag(html, tag) do
    case Regex.run(~r/<#{tag}[^>]*>([^<]+)<\/#{tag}>/i, html) do
      [_, value] -> String.trim(value)
      _ -> nil
    end
  end
end
