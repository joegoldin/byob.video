defmodule WatchParty.OEmbedTest do
  use ExUnit.Case, async: true

  alias WatchParty.OEmbed

  describe "fetch_youtube/1" do
    @describetag :external
    test "fetches metadata for a valid YouTube URL" do
      {:ok, meta} = OEmbed.fetch_youtube("https://www.youtube.com/watch?v=dQw4w9WgXcQ")

      assert is_binary(meta.title)
      assert meta.title != ""
      assert is_binary(meta.thumbnail_url)
      assert meta.thumbnail_url =~ "ytimg.com"
    end

    test "returns error for invalid URL" do
      {:error, _} = OEmbed.fetch_youtube("https://www.youtube.com/watch?v=nonexistent99999")
    end
  end
end
