defmodule ByobWeb.ExtensionChannel do
  use ByobWeb, :channel

  alias Byob.{RoomManager, RoomServer, SyncLog}

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
  def handle_in("video:play", %{"position" => position} = payload, socket) do
    uid = ext_tab_user_id(socket, payload)
    RoomServer.play(socket.assigns.room_pid, uid, position)
    SyncLog.ext_event(socket.assigns.room_id, "play", uid)
    {:noreply, socket}
  end

  def handle_in("video:pause", %{"position" => position} = payload, socket) do
    uid = ext_tab_user_id(socket, payload)
    RoomServer.pause(socket.assigns.room_pid, uid, position)
    SyncLog.ext_event(socket.assigns.room_id, "pause", uid)
    {:noreply, socket}
  end

  def handle_in("video:seek", %{"position" => position} = payload, socket) do
    uid = ext_tab_user_id(socket, payload)
    RoomServer.seek(socket.assigns.room_pid, uid, position)
    SyncLog.ext_event(socket.assigns.room_id, "seek", uid)
    {:noreply, socket}
  end

  def handle_in("video:ended", %{"index" => index}, socket) do
    RoomServer.video_ended(socket.assigns.room_pid, index)
    SyncLog.ext_event(socket.assigns.room_id, "ended", socket.assigns.user_id)
    {:noreply, socket}
  end

  def handle_in("video:ended", _payload, socket) do
    # Extension doesn't know the index — use server's current_index
    state = RoomServer.get_state(socket.assigns.room_pid)

    if state.current_index do
      RoomServer.video_ended(socket.assigns.room_pid, state.current_index)
    end

    {:noreply, socket}
  end

  def handle_in("video:all_closed", _payload, socket) do
    # All extension player windows closed — pause so next joiner syncs without autoplay
    state = RoomServer.get_state(socket.assigns.room_pid)

    if state.play_state == :playing do
      RoomServer.pause(socket.assigns.room_pid, socket.assigns.user_id, state.current_time)
    end

    {:noreply, socket}
  end

  def handle_in("video:state", payload, socket) do
    # Only broadcast playing state, or hooked notification
    # This prevents multiple paused clients from fighting over the placeholder
    is_playing = payload["playing"] || false
    is_hooked = payload["hooked"] || false

    is_buffering = payload["buffering"] || false

    if is_playing or is_hooked or is_buffering do
      Phoenix.PubSub.broadcast(
        Byob.PubSub,
        "room:#{socket.assigns.room_id}",
        {:extension_player_state,
         %{
           hooked: is_hooked,
           position: payload["position"] || 0,
           duration: payload["duration"] || 0,
           playing: is_playing,
           buffering: payload["buffering"] || false,
           user_id: socket.assigns.user_id
         }}
      )
    end

    {:noreply, socket}
  end

  def handle_in("video:media_info", payload, socket) do
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

  def handle_in("video:tab_opened", payload, socket) do
    tab_id = "#{socket.assigns.user_id}:#{payload["tab_id"]}"
    RoomServer.mark_tab_opened(socket.assigns.room_pid, tab_id, socket.assigns.user_id)
    {:noreply, socket}
  end

  def handle_in("video:tab_closed", payload, socket) do
    tab_id = "#{socket.assigns.user_id}:#{payload["tab_id"]}"
    RoomServer.clear_tab_opened(socket.assigns.room_pid, tab_id)
    {:noreply, socket}
  end

  def handle_in("video:ready", payload, socket) do
    # Prefix tab_id with ext user_id to make unique across browser instances
    tab_id = "#{socket.assigns.user_id}:#{payload["tab_id"]}"
    RoomServer.mark_tab_ready(socket.assigns.room_pid, tab_id, socket.assigns.user_id)
    {:noreply, socket}
  end

  def handle_in("video:unready", payload, socket) do
    tab_id = "#{socket.assigns.user_id}:#{payload["tab_id"]}"
    RoomServer.clear_ready_tab(socket.assigns.room_pid, tab_id)
    {:noreply, socket}
  end

  def handle_in("sync:request_state", _payload, socket) do
    state = RoomServer.get_state(socket.assigns.room_pid)

    {:reply,
     {:ok,
      %{
        play_state: Atom.to_string(state.play_state),
        current_time: state.current_time,
        server_time: System.monotonic_time(:millisecond)
      }}, socket}
  end

  def handle_in("sync:ping", %{"t1" => t1}, socket) do
    t2 = System.monotonic_time(:millisecond)
    t3 = System.monotonic_time(:millisecond)
    {:reply, {:ok, %{t1: t1, t2: t2, t3: t3}}, socket}
  end

  def handle_in("sync:rtt_report", %{"rtt" => rtt}, socket) when is_number(rtt) do
    RoomServer.report_rtt(socket.assigns.room_pid, socket.assigns.user_id, rtt)
    {:noreply, socket}
  end

  def handle_in(_event, _payload, socket) do
    {:noreply, socket}
  end

  @impl true
  def handle_info({:sync_play, data}, socket) do
    push(socket, "sync:play", data)
    {:noreply, socket}
  end

  def handle_info({:sync_pause, data}, socket) do
    push(socket, "sync:pause", data)
    {:noreply, socket}
  end

  def handle_info({:sync_seek, data}, socket) do
    push(socket, "sync:seek", data)
    {:noreply, socket}
  end

  def handle_info({:sync_correction, data}, socket) do
    push(socket, "sync:correction", data)
    {:noreply, socket}
  end

  def handle_info({:autoplay_countdown, data}, socket) do
    push(socket, "autoplay:countdown", data)
    {:noreply, socket}
  end

  def handle_info({:autoplay_countdown_cancelled, _data}, socket) do
    push(socket, "autoplay:cancelled", %{})
    {:noreply, socket}
  end

  def handle_info({:extension_player_state, %{buffering: true} = data}, socket) do
    # Relay buffering state to other extension clients so they can show overlay
    push(socket, "sync:buffering", %{user_id: data.user_id, buffering: true})
    {:noreply, socket}
  end

  def handle_info({:extension_player_state, %{buffering: false, user_id: uid}}, socket) do
    push(socket, "sync:buffering", %{user_id: uid, buffering: false})
    {:noreply, socket}
  end

  def handle_info({:extension_player_state, _data}, socket) do
    {:noreply, socket}
  end

  def handle_info({:ready_count, data}, socket) do
    push(socket, "ready:count", data)
    {:noreply, socket}
  end

  def handle_info({:queue_updated, %{queue: queue} = data}, socket) do
    serialized = %{data | queue: Enum.map(queue, &serialize_item/1)}
    push(socket, "queue:updated", serialized)
    {:noreply, socket}
  end

  def handle_info({:video_changed, %{media_item: item} = data}, socket) do
    push(socket, "video:change", %{data | media_item: serialize_item(item)})
    {:noreply, socket}
  end

  def handle_info({:users_updated, _users}, socket) do
    {:noreply, socket}
  end

  def handle_info({:sync_tolerance, data}, socket) do
    push(socket, "sync:tolerance", data)
    {:noreply, socket}
  end

  def handle_info({:sync_stats, _data}, socket) do
    # Stats are for the LiveView panel, not for extension clients
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
        has_tab = min(map_size(open_tabs), total)
        ready = min(map_size(ready_tabs), total)

        %{ready: ready, has_tab: has_tab, total: total}
      else
        nil
      end

    %{
      queue: Enum.map(state.queue, &serialize_item/1),
      current_index: state.current_index,
      play_state: Atom.to_string(state.play_state),
      current_time: state.current_time,
      server_time: System.monotonic_time(:millisecond),
      playback_rate: state.playback_rate,
      ready_count: ready_count
    }
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

  # Build a per-tab user_id for extension clients so two tabs in the same
  # browser (normal + incognito, sharing one SW/WebSocket) are treated as
  # separate users by the room server.
  defp ext_tab_user_id(socket, %{"tab_id" => tab_id}) when is_binary(tab_id) do
    "#{socket.assigns.user_id}:#{tab_id}"
  end

  defp ext_tab_user_id(socket, _payload), do: socket.assigns.user_id
end
