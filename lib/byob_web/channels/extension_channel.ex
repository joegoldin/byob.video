defmodule ByobWeb.ExtensionChannel do
  use ByobWeb, :channel

  require Logger
  alias Byob.{Events, RoomManager, RoomServer, SyncLog}

  # Channel IN event names — module attributes because handle_in/3 patterns
  # require compile-time constants. Sourced from Byob.Events.
  @in_video_play Events.in_video_play()
  @in_video_pause Events.in_video_pause()
  @in_video_seek Events.in_video_seek()
  @in_video_ended Events.in_video_ended()
  @in_video_all_closed Events.in_video_all_closed()
  @in_video_state Events.in_video_state()
  @in_video_media_info Events.in_video_media_info()
  @in_video_tab_opened Events.in_video_tab_opened()
  @in_video_tab_closed Events.in_video_tab_closed()
  @in_video_ready Events.in_video_ready()
  @in_video_unready Events.in_video_unready()
  @in_video_drift Events.in_video_drift()
  @in_sync_ping Events.in_sync_ping()
  @in_sync_request_state Events.in_sync_request_state()
  @in_debug_log Events.in_debug_log()
  @in_video_update_url Events.in_video_update_url()

  @impl true
  def join("extension:" <> room_id, params, socket) do
    if not Regex.match?(~r/^[a-z0-9]{1,16}$/, room_id) do
      {:error, %{reason: "invalid room"}}
    else
      join_room(room_id, params, socket)
    end
  end

  defp join_room(room_id, params, socket) do
    {:ok, pid} = RoomManager.ensure_room(room_id)
    user_id = socket.assigns.user_id
    username = (params["username"] || "ExtensionUser") |> String.slice(0, 30)

    {:ok, state} = RoomServer.join(pid, user_id, username, is_extension: true)
    SyncLog.ext_join(room_id, user_id)
    Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")

    socket =
      socket
      |> assign(:room_id, room_id)
      |> assign(:room_pid, pid)

    {:ok, sync_state_payload(state), socket}
  end

  @impl true
  def handle_in(@in_video_play, %{"position" => position}, socket) do
    RoomServer.play(socket.assigns.room_pid, socket.assigns.user_id, position)
    SyncLog.ext_event(socket.assigns.room_id, "play", socket.assigns.user_id)
    {:noreply, socket}
  end

  def handle_in(@in_video_pause, %{"position" => position}, socket) do
    RoomServer.pause(socket.assigns.room_pid, socket.assigns.user_id, position)
    SyncLog.ext_event(socket.assigns.room_id, "pause", socket.assigns.user_id)
    {:noreply, socket}
  end

  def handle_in(@in_video_seek, %{"position" => position}, socket) do
    RoomServer.seek(socket.assigns.room_pid, socket.assigns.user_id, position)
    SyncLog.ext_event(socket.assigns.room_id, "seek", socket.assigns.user_id)
    {:noreply, socket}
  end

  def handle_in(@in_video_ended, %{"index" => index}, socket) do
    RoomServer.video_ended(socket.assigns.room_pid, index)
    SyncLog.ext_event(socket.assigns.room_id, "ended", socket.assigns.user_id)
    {:noreply, socket}
  end

  def handle_in(@in_video_ended, _payload, socket) do
    # Extension doesn't know the index — use server's current_index
    state = RoomServer.get_state(socket.assigns.room_pid)

    if state.current_index do
      RoomServer.video_ended(socket.assigns.room_pid, state.current_index)
    end

    {:noreply, socket}
  end

  def handle_in(@in_video_all_closed, _payload, socket) do
    # All extension player windows closed — pause so next joiner syncs
    # without autoplay. The ext_closed presence toast is handled by
    # `RoomServer.clear_tab_opened` when the user's last open_tab
    # disappears, so we don't emit it here (would duplicate on the
    # common "closed my only player tab" path).
    state = RoomServer.get_state(socket.assigns.room_pid)

    if state.play_state == :playing do
      RoomServer.pause(socket.assigns.room_pid, socket.assigns.user_id, state.current_time)
    end

    {:noreply, socket}
  end

  def handle_in(@in_video_state, payload, socket) do
    # Only broadcast playing state, or hooked notification
    # This prevents multiple paused clients from fighting over the placeholder
    is_playing = payload["playing"] || false
    is_hooked = payload["hooked"] || false

    client_pos = payload["position"] || 0
    tab_id = payload["tab_id"] || "?"

    if is_playing or is_hooked do
      Phoenix.PubSub.broadcast(
        Byob.PubSub,
        "room:#{socket.assigns.room_id}",
        {:extension_player_state,
         %{
           hooked: is_hooked,
           position: client_pos,
           duration: payload["duration"] || 0,
           playing: is_playing,
           user_id: socket.assigns.user_id
         }}
      )
    end

    # Compute drift for the sync stats panel (works while paused too)
    state = RoomServer.get_state(socket.assigns.room_pid)
    now = System.monotonic_time(:millisecond)

    server_pos =
      if state.play_state == :playing do
        elapsed = (now - Map.get(state, :last_sync_at, now)) / 1000
        state.current_time + elapsed
      else
        state.current_time
      end

    # Client reports its learned structural offset (render/decode latency).
    # Subtract it so reported drift reflects residual drift from baseline,
    # which is the signal that actually matters for mutual client sync.
    offset_ms = payload["offset_ms"] || 0
    raw_drift_ms = round((client_pos - server_pos) * 1000)
    drift_ms = raw_drift_ms - offset_ms

    username = get_in(state, [Access.key(:users), socket.assigns.user_id, Access.key(:username)])

    Phoenix.PubSub.broadcast(
      Byob.PubSub,
      "room:#{socket.assigns.room_id}",
      {:sync_client_stats,
       %{
         user_id: socket.assigns.user_id,
         tab_id: tab_id,
         username: username,
         drift_ms: drift_ms,
         raw_drift_ms: raw_drift_ms,
         offset_ms: offset_ms,
         server_position: Float.round(server_pos * 1.0, 1),
         play_state: if(is_playing, do: "playing", else: "paused")
       }}
    )

    {:noreply, socket}
  end

  def handle_in(@in_video_media_info, payload, socket) do
    # Update the current media item's title/thumbnail with scraped data
    title = payload["title"]
    thumbnail_url = payload["thumbnail_url"]

    if title || thumbnail_url do
      attrs = %{}
      attrs = if title, do: Map.put(attrs, :title, title), else: attrs
      attrs = if thumbnail_url, do: Map.put(attrs, :thumbnail_url, thumbnail_url), else: attrs
      RoomServer.update_current_media(socket.assigns.room_pid, attrs)
    end

    Phoenix.PubSub.broadcast(
      Byob.PubSub,
      "room:#{socket.assigns.room_id}",
      {:extension_media_info,
       %{
         title: title,
         thumbnail_url: thumbnail_url
       }}
    )

    {:noreply, socket}
  end

  def handle_in(@in_video_tab_opened, payload, socket) do
    tab_id = "#{socket.assigns.user_id}:#{payload["tab_id"]}"
    RoomServer.mark_tab_opened(socket.assigns.room_pid, tab_id, socket.assigns.user_id)
    {:noreply, socket}
  end

  def handle_in(@in_video_tab_closed, payload, socket) do
    tab_id = "#{socket.assigns.user_id}:#{payload["tab_id"]}"
    RoomServer.clear_tab_opened(socket.assigns.room_pid, tab_id)
    {:noreply, socket}
  end

  def handle_in(@in_video_ready, payload, socket) do
    # Prefix tab_id with ext user_id to make unique across browser instances
    tab_id = "#{socket.assigns.user_id}:#{payload["tab_id"]}"
    RoomServer.mark_tab_ready(socket.assigns.room_pid, tab_id, socket.assigns.user_id)
    {:noreply, socket}
  end

  def handle_in(@in_video_unready, payload, socket) do
    tab_id = "#{socket.assigns.user_id}:#{payload["tab_id"]}"
    RoomServer.clear_ready_tab(socket.assigns.room_pid, tab_id)
    {:noreply, socket}
  end

  def handle_in(@in_sync_request_state, _payload, socket) do
    state = RoomServer.get_state(socket.assigns.room_pid)
    now = System.monotonic_time(:millisecond)

    current_time =
      if state.play_state == :playing do
        elapsed = (now - Map.get(state, :last_sync_at, now)) / 1000
        state.current_time + elapsed
      else
        state.current_time
      end

    current = current_media(state)

    {:reply,
     {:ok,
      %{
        play_state: Atom.to_string(state.play_state),
        current_time: current_time,
        server_time: now,
        current_url: current && current.url,
        current_source_type: current && Atom.to_string(current.source_type),
        queue_size: length(state.queue)
      }}, socket}
  end

  def handle_in(@in_video_update_url, %{"url" => url}, socket) do
    RoomServer.update_current_url(socket.assigns.room_pid, socket.assigns.user_id, url)
    {:noreply, socket}
  end

  def handle_in(@in_video_drift, %{"drift_ms" => drift_ms} = payload, socket) do
    tab_id = payload["tab_id"] || "?"
    state = RoomServer.get_state(socket.assigns.room_pid)
    now = System.monotonic_time(:millisecond)

    pos =
      if state.play_state == :playing do
        elapsed = (now - Map.get(state, :last_sync_at, now)) / 1000
        state.current_time + elapsed
      else
        state.current_time
      end

    Phoenix.PubSub.broadcast(
      Byob.PubSub,
      "room:#{socket.assigns.room_id}",
      {:sync_client_stats,
       %{
         user_id: socket.assigns.user_id,
         tab_id: tab_id,
         drift_ms: drift_ms,
         server_position: Float.round(pos, 1),
         play_state: Atom.to_string(state.play_state)
       }}
    )

    {:noreply, socket}
  end

  def handle_in(@in_sync_ping, %{"t1" => t1}, socket) do
    t2 = System.monotonic_time(:millisecond)
    t3 = System.monotonic_time(:millisecond)
    {:reply, {:ok, %{t1: t1, t2: t2, t3: t3}}, socket}
  end

  def handle_in(@in_debug_log, %{"message" => message} = payload, socket) do
    room_id = socket.assigns.room_id
    tab_id = payload["tab_id"] || "?"
    user_id = socket.assigns.user_id |> String.slice(0..7)
    Logger.debug("[ext:debug] room=#{room_id} user=#{user_id} tab=#{tab_id} #{message}")
    {:noreply, socket}
  end

  def handle_in(_event, _payload, socket) do
    {:noreply, socket}
  end

  @impl true
  def handle_info({:sync_play, data}, socket) do
    push(socket, Events.sync_play(), data)
    {:noreply, socket}
  end

  def handle_info({:sync_pause, data}, socket) do
    push(socket, Events.sync_pause(), data)
    {:noreply, socket}
  end

  def handle_info({:sync_seek, data}, socket) do
    push(socket, Events.sync_seek(), data)
    {:noreply, socket}
  end

  def handle_info({:sync_correction, data}, socket) do
    push(socket, Events.sync_correction(), data)
    {:noreply, socket}
  end

  def handle_info({:autoplay_countdown, data}, socket) do
    push(socket, Events.autoplay_countdown(), data)
    {:noreply, socket}
  end

  def handle_info({:autoplay_countdown_cancelled, _data}, socket) do
    push(socket, Events.autoplay_cancelled(), %{})
    {:noreply, socket}
  end

  def handle_info({:ready_count, data}, socket) do
    push(socket, Events.ready_count(), data)
    {:noreply, socket}
  end

  def handle_info({:room_presence, data}, socket) do
    push(socket, Events.room_presence(), data)
    {:noreply, socket}
  end

  def handle_info({:queue_updated, %{queue: queue} = data}, socket) do
    serialized = %{data | queue: Enum.map(queue, &serialize_item/1)}
    push(socket, Events.queue_updated(), serialized)
    {:noreply, socket}
  end

  def handle_info({:video_changed, %{media_item: item} = data}, socket) do
    push(socket, Events.video_change(), %{data | media_item: serialize_item(item)})
    {:noreply, socket}
  end

  def handle_info({:queue_ended, _data}, socket) do
    push(socket, Events.queue_ended(), %{})
    {:noreply, socket}
  end

  def handle_info({:users_updated, _users}, socket) do
    {:noreply, socket}
  end

  def handle_info(_msg, socket) do
    {:noreply, socket}
  end

  @impl true
  def terminate(_reason, socket) do
    if socket.assigns[:room_pid] do
      RoomServer.leave(socket.assigns.room_pid, socket.assigns.user_id)
    end

    :ok
  end

  defp sync_state_payload(state) do
    connected = state.users |> Enum.filter(fn {_, u} -> u.connected end)
    has_ext = Enum.any?(connected, fn {_, u} -> Map.get(u, :is_extension, false) end)

    open_tabs = Map.get(state, :open_tabs, %{})
    ready_tabs = Map.get(state, :ready_tabs, %{})

    ready_count =
      if has_ext or map_size(open_tabs) > 0 do
        non_ext = connected |> Enum.reject(fn {_, u} -> Map.get(u, :is_extension, false) end)
        non_ext_usernames = non_ext |> Enum.map(fn {_, u} -> u.username end) |> Enum.uniq()
        total = length(non_ext_usernames)

        # open_tabs/ready_tabs are keyed by tab_id with ext_user_id as value.
        # Count unique owners (by username), not tabs — a single user with
        # top frame + player iframe would otherwise count as 2. Also filter
        # out stale owners that aren't currently connected.
        connected_ids =
          connected |> Enum.map(fn {id, _} -> id end) |> MapSet.new()

        resolve = fn owner_id ->
          if MapSet.member?(connected_ids, owner_id) do
            get_in(state, [Access.key(:users), owner_id, Access.key(:username)])
          else
            nil
          end
        end

        open_users =
          open_tabs |> Map.values() |> Enum.map(resolve)
          |> Enum.reject(&is_nil/1) |> Enum.uniq()

        ready_users =
          ready_tabs |> Map.values() |> Enum.map(resolve)
          |> Enum.reject(&is_nil/1) |> Enum.uniq()

        has_tab = min(length(open_users), total)
        ready = min(length(ready_users), has_tab)

        open_set = MapSet.new(open_users)
        ready_set = MapSet.new(ready_users)

        needs_open = Enum.reject(non_ext_usernames, &MapSet.member?(open_set, &1))

        needs_play =
          non_ext_usernames
          |> Enum.filter(&MapSet.member?(open_set, &1))
          |> Enum.reject(&MapSet.member?(ready_set, &1))

        %{
          ready: ready,
          has_tab: has_tab,
          total: total,
          needs_open: needs_open,
          needs_play: needs_play
        }
      else
        nil
      end

    now = System.monotonic_time(:millisecond)

    current_time =
      if state.play_state == :playing do
        elapsed = (now - Map.get(state, :last_sync_at, now)) / 1000
        state.current_time + elapsed
      else
        state.current_time
      end

    current = current_media(state)

    %{
      queue: Enum.map(state.queue, &serialize_item/1),
      current_index: state.current_index,
      play_state: Atom.to_string(state.play_state),
      current_time: current_time,
      server_time: now,
      playback_rate: state.playback_rate,
      ready_count: ready_count,
      current_url: current && current.url,
      current_source_type: current && Atom.to_string(current.source_type),
      queue_size: length(state.queue)
    }
  end

  defp current_media(state) do
    case state.current_index do
      nil -> nil
      idx -> Enum.at(state.queue, idx)
    end
  end

  defp serialize_item(%Byob.MediaItem{} = item) do
    %{
      id: item.id,
      url: item.url,
      source_type: Atom.to_string(item.source_type),
      source_id: item.source_id,
      title: item.title
    }
  end
end
