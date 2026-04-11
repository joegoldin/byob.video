defmodule WatchParty.MediaItemTest do
  use ExUnit.Case, async: true

  alias WatchParty.MediaItem

  describe "parse_url/1" do
    test "standard youtube.com/watch?v= URL" do
      assert {:ok, %MediaItem{source_type: :youtube, source_id: "dQw4w9WgXcQ"}} =
               MediaItem.parse_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    end

    test "youtu.be short URL" do
      assert {:ok, %MediaItem{source_type: :youtube, source_id: "dQw4w9WgXcQ"}} =
               MediaItem.parse_url("https://youtu.be/dQw4w9WgXcQ")
    end

    test "youtube.com/embed URL" do
      assert {:ok, %MediaItem{source_type: :youtube, source_id: "dQw4w9WgXcQ"}} =
               MediaItem.parse_url("https://www.youtube.com/embed/dQw4w9WgXcQ")
    end

    test "m.youtube.com URL" do
      assert {:ok, %MediaItem{source_type: :youtube, source_id: "dQw4w9WgXcQ"}} =
               MediaItem.parse_url("https://m.youtube.com/watch?v=dQw4w9WgXcQ")
    end

    test "youtube.com/shorts URL" do
      assert {:ok, %MediaItem{source_type: :youtube, source_id: "dQw4w9WgXcQ"}} =
               MediaItem.parse_url("https://youtube.com/shorts/dQw4w9WgXcQ")
    end

    test "youtube.com/live URL" do
      assert {:ok, %MediaItem{source_type: :youtube, source_id: "dQw4w9WgXcQ"}} =
               MediaItem.parse_url("https://youtube.com/live/dQw4w9WgXcQ")
    end

    test "youtube URL with extra query params" do
      assert {:ok, %MediaItem{source_type: :youtube, source_id: "dQw4w9WgXcQ"}} =
               MediaItem.parse_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLfoo&t=120")
    end

    test "youtube URL without www" do
      assert {:ok, %MediaItem{source_type: :youtube, source_id: "dQw4w9WgXcQ"}} =
               MediaItem.parse_url("https://youtube.com/watch?v=dQw4w9WgXcQ")
    end

    test "non-youtube URL returns extension_required" do
      assert {:ok, %MediaItem{source_type: :extension_required, source_id: nil}} =
               MediaItem.parse_url("https://crunchyroll.com/watch/some-episode")
    end

    test "another non-youtube URL" do
      assert {:ok, %MediaItem{source_type: :extension_required, source_id: nil}} =
               MediaItem.parse_url("https://www.netflix.com/watch/12345")
    end

    test "invalid URL returns error" do
      assert {:error, :invalid_url} = MediaItem.parse_url("not a url")
    end

    test "empty string returns error" do
      assert {:error, :invalid_url} = MediaItem.parse_url("")
    end

    test "parsed item has an id" do
      {:ok, item} = MediaItem.parse_url("https://youtu.be/dQw4w9WgXcQ")
      assert is_binary(item.id)
      assert byte_size(item.id) > 0
    end

    test "parsed item stores original URL" do
      url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      {:ok, item} = MediaItem.parse_url(url)
      assert item.url == url
    end
  end
end
