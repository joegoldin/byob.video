defmodule Byob.MediaItemTest do
  use ExUnit.Case, async: true

  alias Byob.MediaItem

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

    test "invalid URL returns error" do
      assert {:error, :invalid_url} = MediaItem.parse_url("not a url")
    end

    test "empty string returns error" do
      assert {:error, :invalid_url} = MediaItem.parse_url("")
    end

    test "javascript: scheme returns invalid_url" do
      assert {:error, :invalid_url} = MediaItem.parse_url("javascript:alert(1)")
    end

    test "data: scheme returns invalid_url" do
      assert {:error, :invalid_url} = MediaItem.parse_url("data:text/html,x")
    end

    test "file: scheme returns invalid_url" do
      assert {:error, :invalid_url} = MediaItem.parse_url("file:///etc/passwd")
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

  describe "parse_url/1 self-reference" do
    test "byob.video room link returns self_reference" do
      assert {:error, :self_reference} =
               MediaItem.parse_url("https://byob.video/room/abc")
    end

    test "www.byob.video returns self_reference" do
      assert {:error, :self_reference} = MediaItem.parse_url("https://www.byob.video")
    end

    test "runtime PHX_HOST returns self_reference" do
      host = Application.get_env(:byob, ByobWeb.Endpoint)[:url][:host]
      refute is_nil(host), "expected endpoint url host to be configured"
      assert {:error, :self_reference} = MediaItem.parse_url("https://#{host}/room/xyz")
    end
  end

  describe "parse_url/1 DRM sites" do
    test "netflix returns drm_site" do
      assert {:error, :drm_site, "Netflix"} =
               MediaItem.parse_url("https://www.netflix.com/watch/12345")
    end

    test "disney+ returns drm_site" do
      assert {:error, :drm_site, "Disney+"} =
               MediaItem.parse_url("https://www.disneyplus.com/video/xyz")
    end

    test "max returns drm_site" do
      assert {:error, :drm_site, "Max"} = MediaItem.parse_url("https://www.max.com/show/abc")
    end

    test "old hbomax domain returns drm_site" do
      assert {:error, :drm_site, "Max"} = MediaItem.parse_url("https://play.hbomax.com/feature/x")

      assert {:error, :drm_site, "Max"} =
               MediaItem.parse_url("https://hbomax.com/feature/x")
    end

    test "hulu returns drm_site" do
      assert {:error, :drm_site, "Hulu"} = MediaItem.parse_url("https://www.hulu.com/watch/1")
    end

    test "prime video returns drm_site" do
      assert {:error, :drm_site, "Prime Video"} =
               MediaItem.parse_url("https://www.primevideo.com/detail/x")
    end

    test "apple tv+ returns drm_site" do
      assert {:error, :drm_site, "Apple TV+"} =
               MediaItem.parse_url("https://tv.apple.com/show/x")
    end

    test "peacock returns drm_site" do
      assert {:error, :drm_site, "Peacock"} =
               MediaItem.parse_url("https://www.peacocktv.com/watch/x")
    end

    test "paramount+ returns drm_site" do
      assert {:error, :drm_site, "Paramount+"} =
               MediaItem.parse_url("https://www.paramountplus.com/shows/x")
    end
  end

  describe "extract_url/1" do
    test "empty string returns nil" do
      assert MediaItem.extract_url("") == nil
    end

    test "non-URL text returns nil" do
      assert MediaItem.extract_url("hello world") == nil
    end

    test "clean URL returns itself" do
      assert MediaItem.extract_url("https://youtu.be/abc") == "https://youtu.be/abc"
    end

    test "prefix text is stripped" do
      assert MediaItem.extract_url("hey watch this https://youtu.be/abc") ==
               "https://youtu.be/abc"
    end

    test "last URL wins when multiple are present" do
      assert MediaItem.extract_url("https://foo.com https://youtu.be/abc") ==
               "https://youtu.be/abc"
    end

    test "concatenated URLs with no separator still split on https://" do
      assert MediaItem.extract_url("https://youtu.be/b4QqU-RQZ4whttps://youtu.be/OTbDMSfhNmE") ==
               "https://youtu.be/OTbDMSfhNmE"
    end

    test "concatenated URLs mixing http and https" do
      assert MediaItem.extract_url("http://a.comhttps://b.com") == "https://b.com"
    end

    test "trailing comma is stripped" do
      assert MediaItem.extract_url("see https://youtu.be/abc, thanks") ==
               "https://youtu.be/abc"
    end

    test "trailing period is stripped" do
      assert MediaItem.extract_url("watch https://youtu.be/abc.") == "https://youtu.be/abc"
    end

    test "trailing paren is stripped" do
      assert MediaItem.extract_url("(https://youtu.be/abc)") == "https://youtu.be/abc"
    end

    test "http scheme works" do
      assert MediaItem.extract_url("http://example.com/x.mp4") == "http://example.com/x.mp4"
    end

    test "nil input returns nil" do
      assert MediaItem.extract_url(nil) == nil
    end
  end
end
