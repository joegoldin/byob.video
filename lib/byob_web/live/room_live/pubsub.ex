defmodule ByobWeb.RoomLive.PubSub do
  @moduledoc """
  Handles PubSub messages broadcast by RoomServer to the RoomLive process.
  """

  import Phoenix.LiveView, only: [push_event: 3]
  import Phoenix.Component, only: [assign: 2]

  alias Byob.{Events, RoomServer}

  def handle_sync_play(data, socket) do
    {:noreply, push_event(socket, Events.sync_play(), data)}
  end

  def handle_sync_pause(data, socket) do
    {:noreply, push_event(socket, Events.sync_pause(), data)}
  end

  def handle_sync_seek(data, socket) do
    {:noreply, push_event(socket, Events.sync_seek(), data)}
  end

  def handle_sync_correction(data, socket) do
    {:noreply, push_event(socket, Events.sync_correction(), data)}
  end

  def handle_state_heartbeat(data, socket) do
    {:noreply, push_event(socket, Events.sync_heartbeat(), data)}
  end

  def handle_autoplay_countdown(data, socket) do
    {:noreply, push_event(socket, Events.sync_autoplay_countdown(), data)}
  end

  def handle_autoplay_cancelled(socket) do
    {:noreply, push_event(socket, Events.sync_autoplay_cancelled(), %{})}
  end

  def handle_room_presence(%{event: event, username: username}, socket) do
    text =
      cond do
        event == Events.presence_joined() -> "#{username} joined the room"
        event == Events.presence_ext_closed() -> "#{username} closed their player window"
        true -> "#{username} left the room"
      end

    {:noreply, push_event(socket, Events.toast(), %{text: text})}
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
        push_event(socket, Events.ext_media_info(), %{
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
        push_event(socket, Events.media_metadata(), %{
          title: current_media.title,
          thumbnail_url: current_media.thumbnail_url
        })
      else
        socket
      end

    {:noreply, socket}
  end

  def handle_sponsor_segments(data, socket) do
    {:noreply, push_event(socket, Events.sponsor_segments(), data)}
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

    {:noreply, push_event(socket, Events.queue_ended(), %{})}
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

    {:noreply, push_event(socket, Events.video_change(), ByobWeb.RoomLive.serialize_media_item(data))}
  end

  def handle_sb_settings_updated(sb_settings, socket) do
    {:noreply,
     socket |> assign(sb_settings: sb_settings) |> push_event(Events.sb_settings(), sb_settings)}
  end

  def handle_extension_media_info(info, socket) do
    {:noreply, push_event(socket, Events.ext_media_info(), info)}
  end

  def handle_extension_player_state(state, socket) do
    current = socket.assigns.ext_player

    # Only update if: no current state, same user, or new state is playing
    should_update =
      current == nil ||
        state.playing ||
        state[:user_id] == current[:user_id]

    if should_update do
      {:noreply, socket |> assign(ext_player: state) |> push_event(Events.ext_player_state(), state)}
    else
      {:noreply, socket}
    end
  end

  def handle_users_updated(users, socket) do
    # Also prune sync_stats entries whose owner disappeared or is marked
    # disconnected — otherwise the "Extension clients" panel keeps showing
    # stale rows after an extension user closes their player tab.
    stats = Map.get(socket.assigns, :sync_stats, %{})
    clients = Map.get(stats, :clients, %{})
    connected_ids = users |> Enum.filter(fn {_, u} -> u.connected end) |> Enum.map(fn {id, _} -> id end) |> MapSet.new()

    pruned =
      clients
      |> Enum.filter(fn {key, _} ->
        [owner | _] = String.split(key, ":", parts: 2)
        MapSet.member?(connected_ids, owner)
      end)
      |> Map.new()

    socket =
      if map_size(pruned) == map_size(clients) do
        assign(socket, users: users)
      else
        assign(socket, users: users, sync_stats: Map.put(stats, :clients, pruned))
      end

    {:noreply, socket}
  end

  def handle_activity_log_updated(log, socket) do
    {:noreply, assign(socket, activity_log: Enum.take(log, 50))}
  end

  def handle_activity_log_entry(entry, socket) do
    log = Enum.take([entry | socket.assigns.activity_log], 50)
    socket = assign(socket, activity_log: log)
    # Push toast to client
    socket =
      push_event(socket, Events.toast(), %{text: ByobWeb.RoomLive.Components.format_log_entry(entry)})

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
