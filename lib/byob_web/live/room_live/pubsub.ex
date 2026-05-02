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

    socket = push_event(socket, Events.toast(), %{text: text})

    socket =
      if event in [Events.presence_joined(), Events.presence_left()] do
        push_event(socket, Events.notify(), %{text: text})
      else
        socket
      end

    {:noreply, socket}
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

    # play_state from the broadcast — :paused while the ready-then-play
    # handshake is in flight, then :playing arrives via :sync_play once
    # all peers report `video:loaded`. Fallback to :playing for safety
    # if the field isn't set (older servers / unrelated callers).
    play_state = Map.get(data, :play_state, :playing)

    socket =
      assign(socket,
        current_media: data.media_item,
        current_index: data.index,
        play_state: play_state,
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

  def handle_ready_count(data, socket) do
    # Direct user_id membership check — open_tabs is keyed by owner
    # LV peer user_id (server-side), and our @user_id is the same
    # canonical identifier. No usernames anywhere in the comparison
    # path: rename doesn't break it, the player div's frozen
    # data-username doesn't break it, the ext peer's stored username
    # doesn't break it.
    user_id = socket.assigns[:user_id]

    i_have_popup =
      is_binary(user_id) and
        is_list(Map.get(data, :users_with_open_tabs)) and
        Enum.member?(data.users_with_open_tabs, user_id)

    {:noreply, push_event(socket, Events.ready_count(), Map.put(data, :i_have_popup, i_have_popup))}
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
    # disconnected — otherwise the panel keeps showing stale rows after a
    # user closes their player tab. Owner is "everything before the LAST
    # `:`" in the key — LV per-tab user_ids are themselves `session:tab`,
    # so a naive split-by-first-colon would extract just "session" and
    # miss the @users key (`session:tab`), pruning every browser-side
    # drift-report row on every users_updated tick.
    stats = Map.get(socket.assigns, :sync_stats, %{})
    clients = Map.get(stats, :clients, %{})
    connected_ids = users |> Enum.filter(fn {_, u} -> u.connected end) |> Enum.map(fn {id, _} -> id end) |> MapSet.new()

    pruned =
      clients
      |> Enum.filter(fn {key, _} ->
        parts = String.split(key, ":")
        owner = parts |> Enum.drop(-1) |> Enum.join(":")
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
    # Dedup: the broadcasting log_activity that produced this entry
    # was called INSIDE the same RoomServer.join call whose return
    # snapshot the LV mount used to seed `socket.assigns.activity_log`.
    # `Phoenix.PubSub.subscribe` runs before the join, so we receive
    # the broadcast for our own join — and would otherwise prepend it
    # on top of an identical head from the snapshot. Same entry
    # (same action + same user + same DateTime) would never rationally
    # appear twice, so reject if it's already at the head.
    log =
      case socket.assigns.activity_log do
        [%{action: a, user: u, at: at} | _]
        when a == entry.action and u == entry.user and at == entry.at ->
          socket.assigns.activity_log

        _ ->
          Enum.take([entry | socket.assigns.activity_log], 50)
      end

    socket = assign(socket, activity_log: log)
    text = ByobWeb.RoomLive.Components.format_log_entry(entry)
    # Push toast — but NOT for :joined / :left, which the join handler
    # already broadcast a `room_presence` toast for ("joe joined the
    # room"). Without this skip we'd render two near-identical toasts
    # back to back.
    socket =
      if entry.action in [:joined, :left] do
        socket
      else
        push_event(socket, Events.toast(), %{text: text})
      end

    # Notification-worthy: queue churn + round winners. Excludes
    # play / pause / seek / renamed / round_cancelled — those fire
    # constantly during normal use and would spam the tab title.
    socket =
      if entry.action in [:added, :now_playing, :roulette_winner, :vote_winner] do
        push_event(socket, Events.notify(), %{text: text})
      else
        socket
      end

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
