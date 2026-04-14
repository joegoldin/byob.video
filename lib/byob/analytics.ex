defmodule Byob.Analytics do
  @moduledoc """
  Analytics wrapper for PostHog. All tracking goes through here.
  Never tracks from extension code — only from the web app.
  Does not track video URLs, titles, or usernames.
  """

  def enabled? do
    Application.get_env(:posthog, :enable, false)
  end

  def identify(user_id, properties \\ %{}) do
    if enabled?() do
      PostHog.capture("$identify", Map.merge(%{
        distinct_id: user_id,
        "$set": properties
      }, properties))
    end
  end

  def track(event, user_id, properties \\ %{}) do
    if enabled?() do
      PostHog.capture(event, Map.put(properties, :distinct_id, user_id))
    end
  end

  # Room events
  def room_created(user_id, room_id) do
    track("room_created", user_id, %{room_id: room_id})
  end

  def room_joined(user_id, room_id, has_extension: has_ext) do
    track("room_joined", user_id, %{room_id: room_id, has_extension: has_ext})
    identify(user_id, %{has_extension: has_ext})
  end

  def video_added(user_id, room_id, source_type) do
    track("video_added", user_id, %{room_id: room_id, source_type: to_string(source_type)})
  end

  def video_played(user_id, room_id) do
    track("video_played", user_id, %{room_id: room_id})
  end

  def video_paused(user_id, room_id) do
    track("video_paused", user_id, %{room_id: room_id})
  end

  def video_seeked(user_id, room_id) do
    track("video_seeked", user_id, %{room_id: room_id})
  end

  def queue_skipped(user_id, room_id) do
    track("queue_skipped", user_id, %{room_id: room_id})
  end

  def api_room_created(api_user_id, room_id) do
    track("api_room_created", api_user_id, %{room_id: room_id})
  end
end
