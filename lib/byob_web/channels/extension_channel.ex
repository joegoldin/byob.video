defmodule ByobWeb.ExtensionChannel do
  use ByobWeb, :channel

  alias Byob.{RoomManager, RoomServer}

  @impl true
  def join("extension:" <> room_id, params, socket) do
    {:ok, pid} = RoomManager.ensure_room(room_id)
    user_id = socket.assigns.user_id
    username = params["username"] || "ExtensionUser"

    {:ok, state} = RoomServer.join(pid, user_id, username)
    Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")

    socket =
      socket
      |> assign(:room_id, room_id)
      |> assign(:room_pid, pid)

    {:ok, sync_state_payload(state), socket}
  end

  @impl true
  def handle_in("video:play", %{"position" => position}, socket) do
    RoomServer.play(socket.assigns.room_pid, socket.assigns.user_id, position)
    {:noreply, socket}
  end

  def handle_in("video:pause", %{"position" => position}, socket) do
    RoomServer.pause(socket.assigns.room_pid, socket.assigns.user_id, position)
    {:noreply, socket}
  end

  def handle_in("video:seek", %{"position" => position}, socket) do
    RoomServer.seek(socket.assigns.room_pid, socket.assigns.user_id, position)
    {:noreply, socket}
  end

  def handle_in("video:ended", %{"index" => index}, socket) do
    RoomServer.video_ended(socket.assigns.room_pid, index)
    {:noreply, socket}
  end

  def handle_in("video:state", payload, socket) do
    require Logger
    Logger.info("[ExtChannel] video:state received: #{inspect(payload)}")
    # Relay extension player state to room for placeholder display
    Phoenix.PubSub.broadcast(Byob.PubSub, "room:#{socket.assigns.room_id}",
      {:extension_player_state, %{
        hooked: payload["hooked"] || false,
        position: payload["position"] || 0,
        duration: payload["duration"] || 0,
        playing: payload["playing"] || false
      }})
    {:noreply, socket}
  end

  def handle_in("sync:ping", %{"t1" => t1}, socket) do
    t2 = System.monotonic_time(:millisecond)
    t3 = System.monotonic_time(:millisecond)
    {:reply, {:ok, %{t1: t1, t2: t2, t3: t3}}, socket}
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

  def handle_info({:queue_updated, data}, socket) do
    push(socket, "queue:updated", data)
    {:noreply, socket}
  end

  def handle_info({:video_changed, data}, socket) do
    push(socket, "video:change", data)
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
    %{
      queue: Enum.map(state.queue, &serialize_item/1),
      current_index: state.current_index,
      play_state: Atom.to_string(state.play_state),
      current_time: state.current_time,
      server_time: state.server_time,
      playback_rate: state.playback_rate
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
end
