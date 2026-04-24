defmodule ByobWeb.RoomLive.Playback do
  @moduledoc """
  Handles playback event handlers extracted from RoomLive.

  Covers: video:play, video:pause, video:seek, video:embed_blocked,
  video:ended (two clauses), analytics:has_extension, and sync:ping.
  """

  import Phoenix.LiveView, only: [push_event: 3]

  alias Byob.{Analytics, Events, RoomServer}

  def handle_play(%{"position" => position}, socket) do
    RoomServer.play(socket.assigns.room_pid, socket.assigns.user_id, position)
    {:noreply, socket}
  end

  def handle_pause(%{"position" => position}, socket) do
    RoomServer.pause(socket.assigns.room_pid, socket.assigns.user_id, position)
    {:noreply, socket}
  end

  def handle_seek(%{"position" => position}, socket) do
    RoomServer.seek(socket.assigns.room_pid, socket.assigns.user_id, position)
    {:noreply, socket}
  end

  def handle_embed_blocked(_params, socket) do
    Analytics.track(
      "video_embed_blocked",
      socket.assigns[:browser_id] || socket.assigns.user_id,
      %{
        room_id: socket.assigns.room_id,
        source_type: "youtube_restricted"
      }
    )

    {:noreply, socket}
  end

  def handle_ended(%{"index" => index}, socket) do
    RoomServer.video_ended(socket.assigns.room_pid, index)
    {:noreply, socket}
  end

  def handle_ended(_params, socket) do
    # Fallback without index — use skip but only once
    RoomServer.skip(socket.assigns.room_pid)
    {:noreply, socket}
  end

  def handle_has_extension(_params, socket) do
    Analytics.identify(socket.assigns[:browser_id] || socket.assigns.user_id, %{
      has_extension: true
    })

    {:noreply, socket}
  end

  def handle_sync_ping(%{"t1" => t1}, socket) do
    t2 = System.monotonic_time(:millisecond)
    t3 = System.monotonic_time(:millisecond)
    {:noreply, push_event(socket, Events.sync_pong(), %{t1: t1, t2: t2, t3: t3})}
  end
end
