defmodule ByobWeb.RoomLive.PubSub do
  @moduledoc """
  Handles PubSub messages broadcast by RoomServer to the RoomLive process.
  """

  import Phoenix.LiveView, only: [push_event: 3]
  import Phoenix.Component, only: [assign: 2]

  alias Byob.RoomServer

  def handle_sync_play(data, socket) do
    {:noreply, push_event(socket, "sync:play", data)}
  end

  def handle_sync_pause(data, socket) do
    {:noreply, push_event(socket, "sync:pause", data)}
  end

  def handle_sync_seek(data, socket) do
    {:noreply, push_event(socket, "sync:seek", data)}
  end

  def handle_sync_correction(data, socket) do
    {:noreply, push_event(socket, "sync:correction", data)}
  end

  def handle_queue_updated(%{queue: queue, current_index: current_index}, socket) do
    current_media = if current_index, do: Enum.at(queue, current_index), else: nil

    # Refresh history from RoomServer
    history =
      case RoomServer.get_state(socket.assigns.room_pid) do
        %{history: h} -> h
        _ -> socket.assigns.history
      end

    socket =
      assign(socket,
        queue: queue,
        current_index: current_index,
        current_media: current_media,
        history: history
      )

    # Push updated media info to JS for extension placeholder
    socket =
      if current_media && current_media.source_type == :extension_required do
        push_event(socket, "ext:media-info", %{
          title: current_media.title,
          thumbnail_url: current_media.thumbnail_url,
          url: current_media.url
        })
      else
        socket
      end

    # Push metadata to JS hook so it can update cached title/thumbnail
    socket =
      if current_media && (current_media.title || current_media.thumbnail_url) do
        push_event(socket, "media:metadata", %{
          title: current_media.title,
          thumbnail_url: current_media.thumbnail_url
        })
      else
        socket
      end

    {:noreply, socket}
  end

  def handle_sponsor_segments(data, socket) do
    {:noreply, push_event(socket, "sponsor:segments", data)}
  end

  def handle_queue_ended(_data, socket) do
    history =
      case RoomServer.get_state(socket.assigns.room_pid) do
        %{history: h} -> h
        _ -> socket.assigns.history
      end

    socket =
      assign(socket,
        play_state: :ended,
        current_index: nil,
        history: history
      )

    {:noreply, push_event(socket, "queue:ended", %{})}
  end

  def handle_video_changed(data, socket) do
    socket = assign(socket, ext_player: nil)

    history =
      case RoomServer.get_state(socket.assigns.room_pid) do
        %{history: h} -> h
        _ -> socket.assigns.history
      end

    socket =
      assign(socket,
        current_media: data.media_item,
        current_index: data.index,
        play_state: :playing,
        history: history,
        comments: nil,
        comments_video_id: nil,
        comments_next_page: nil,
        comments_total: nil
      )

    {:noreply, push_event(socket, "video:change", ByobWeb.RoomLive.serialize_media_item(data))}
  end

  def handle_sb_settings_updated(sb_settings, socket) do
    {:noreply, socket |> assign(sb_settings: sb_settings) |> push_event("sb:settings", sb_settings)}
  end

  def handle_extension_player_state(state, socket) do
    current = socket.assigns.ext_player

    # Only update if: no current state, same user, or new state is playing
    should_update =
      current == nil ||
        state.playing ||
        state[:user_id] == current[:user_id]

    if should_update do
      {:noreply, socket |> assign(ext_player: state) |> push_event("ext:player-state", state)}
    else
      {:noreply, socket}
    end
  end

  def handle_users_updated(users, socket) do
    {:noreply, assign(socket, users: users)}
  end

  def handle_activity_log_updated(log, socket) do
    {:noreply, assign(socket, activity_log: Enum.take(log, 50))}
  end

  def handle_activity_log_entry(entry, socket) do
    log = Enum.take([entry | socket.assigns.activity_log], 50)
    socket = assign(socket, activity_log: log)
    # Push toast to client
    socket = push_event(socket, "toast", %{text: ByobWeb.RoomLive.Components.format_log_entry(entry)})
    {:noreply, socket}
  end

  def handle_comments_updated(data, socket) do
    {:noreply,
     assign(socket,
       comments: data.comments,
       comments_next_page: data.next_page_token,
       comments_video_id: data.video_id,
       comments_total: data.total_count
     )}
  end
end
