defmodule Byob.YouTube.CommentsTest do
  use ExUnit.Case, async: false

  alias Byob.YouTube.Comments

  # We run async: false because we mutate Application env and ETS.

  setup do
    # Clear relevant Application env before each test
    Application.delete_env(:byob, :youtube_api_key)
    Application.delete_env(:byob, :youtube_quota_exhausted)

    # Clear the ETS cache
    :ets.delete_all_objects(:youtube_comments_cache)

    :ok
  end

  describe "fetch/1 — configuration checks" do
    test "returns {:error, :not_configured} when no API key is set" do
      assert {:error, :not_configured} = Comments.fetch("dQw4w9WgXcQ")
    end

    test "returns {:error, :not_configured} when API key is empty string" do
      Application.put_env(:byob, :youtube_api_key, "")
      assert {:error, :not_configured} = Comments.fetch("dQw4w9WgXcQ")
    end
  end

  describe "fetch/1 — quota handling" do
    test "returns {:error, :quota_exhausted} when quota flag is set for today" do
      Application.put_env(:byob, :youtube_api_key, "test-key")
      Application.put_env(:byob, :youtube_quota_exhausted, {true, Date.utc_today()})

      assert {:error, :quota_exhausted} = Comments.fetch("dQw4w9WgXcQ")
    end

    test "ignores quota flag from yesterday (proceeds past quota check)" do
      Application.put_env(:byob, :youtube_api_key, "test-key")
      yesterday = Date.add(Date.utc_today(), -1)
      Application.put_env(:byob, :youtube_quota_exhausted, {true, yesterday})

      # It will proceed past quota check and try HTTP (which will fail since
      # the key is fake), but the point is it does NOT return :quota_exhausted.
      result = Comments.fetch("dQw4w9WgXcQ")
      assert {:error, reason} = result
      assert reason != :quota_exhausted

      # The stale flag should be cleared
      assert Application.get_env(:byob, :youtube_quota_exhausted) == nil
    end
  end

  describe "parse_response/1" do
    test "parses a typical API response" do
      body = %{
        "items" => [
          %{
            "snippet" => %{
              "topLevelComment" => %{
                "snippet" => %{
                  "authorDisplayName" => "Alice",
                  "authorProfileImageUrl" => "https://example.com/alice.jpg",
                  "textDisplay" => "Great video!",
                  "likeCount" => 42,
                  "publishedAt" => "2024-01-15T10:30:00Z"
                }
              },
              "totalReplyCount" => 3
            }
          },
          %{
            "snippet" => %{
              "topLevelComment" => %{
                "snippet" => %{
                  "authorDisplayName" => "Bob",
                  "authorProfileImageUrl" => "https://example.com/bob.jpg",
                  "textDisplay" => "Thanks for sharing",
                  "likeCount" => 7,
                  "publishedAt" => "2024-01-16T12:00:00Z"
                }
              },
              "totalReplyCount" => 0
            }
          }
        ],
        "nextPageToken" => "CDIQAA",
        "pageInfo" => %{"totalResults" => 150}
      }

      result = Comments.parse_response(body)

      assert length(result.comments) == 2
      assert result.next_page_token == "CDIQAA"
      assert result.total_count == 150

      [first, second] = result.comments
      assert first.author == "Alice"
      assert first.author_avatar == "https://example.com/alice.jpg"
      assert first.text == "Great video!"
      assert first.likes == 42
      assert first.published_at == "2024-01-15T10:30:00Z"
      assert first.reply_count == 3

      assert second.author == "Bob"
      assert second.likes == 7
      assert second.reply_count == 0
    end

    test "handles empty items list" do
      body = %{"items" => [], "pageInfo" => %{"totalResults" => 0}}

      result = Comments.parse_response(body)

      assert result.comments == []
      assert result.next_page_token == nil
      assert result.total_count == 0
    end

    test "handles missing fields gracefully" do
      body = %{
        "items" => [
          %{"snippet" => %{"topLevelComment" => %{"snippet" => %{}}}}
        ]
      }

      result = Comments.parse_response(body)
      assert length(result.comments) == 1

      [comment] = result.comments
      assert comment.author == nil
      assert comment.text == nil
      assert comment.likes == 0
      assert comment.reply_count == 0
    end
  end

  describe "ETS caching" do
    test "second fetch with same video_id hits cache" do
      Application.put_env(:byob, :youtube_api_key, "test-key")

      # Pre-populate cache
      cached_result = %{
        comments: [%{author: "Cached", text: "From cache"}],
        next_page_token: nil,
        total_count: 1
      }

      :ets.insert(
        :youtube_comments_cache,
        {{"test-video", nil}, cached_result, DateTime.utc_now()}
      )

      # fetch should return cached result without making any HTTP call
      assert {:ok, result} = Comments.fetch("test-video")
      assert result == cached_result
      assert [%{author: "Cached"}] = result.comments
    end

    test "expired cache entry is not returned" do
      Application.put_env(:byob, :youtube_api_key, "test-key")

      old_time = DateTime.add(DateTime.utc_now(), -20 * 60, :second)

      :ets.insert(
        :youtube_comments_cache,
        {{"test-video", nil}, %{comments: [], next_page_token: nil, total_count: 0}, old_time}
      )

      # Cache is expired, so it will try HTTP (and fail with fake key)
      result = Comments.fetch("test-video")
      assert {:error, _reason} = result
    end

    test "page_token is part of cache key" do
      Application.put_env(:byob, :youtube_api_key, "test-key")

      page1 = %{comments: [%{author: "Page1"}], next_page_token: "token2", total_count: 50}
      page2 = %{comments: [%{author: "Page2"}], next_page_token: nil, total_count: 50}

      now = DateTime.utc_now()
      :ets.insert(:youtube_comments_cache, {{"vid", nil}, page1, now})
      :ets.insert(:youtube_comments_cache, {{"vid", "token2"}, page2, now})

      assert {:ok, ^page1} = Comments.fetch("vid")
      assert {:ok, ^page2} = Comments.fetch("vid", page_token: "token2")
    end
  end
end
