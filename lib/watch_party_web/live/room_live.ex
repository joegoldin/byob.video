defmodule WatchPartyWeb.RoomLive do
  use WatchPartyWeb, :live_view

  alias WatchParty.{RoomManager, RoomServer}

  def mount(%{"id" => room_id}, _session, socket) do
    {:ok, pid} = RoomManager.ensure_room(room_id)

    socket = assign(socket, room_id: room_id, room_pid: pid, users: %{})

    if connected?(socket) do
      user_id = socket.assigns.user_id
      username = socket.assigns.username
      Phoenix.PubSub.subscribe(WatchParty.PubSub, "room:#{room_id}")
      {:ok, state} = RoomServer.join(pid, user_id, username)
      {:ok, assign(socket, users: state.users)}
    else
      {:ok, socket}
    end
  end

  def terminate(_reason, socket) do
    if Map.has_key?(socket.assigns, :user_id) and Map.has_key?(socket.assigns, :room_pid) do
      RoomServer.leave(socket.assigns.room_pid, socket.assigns.user_id)
    end

    :ok
  end

  def handle_info({:users_updated, users}, socket) do
    {:noreply, assign(socket, users: users)}
  end

  def handle_info(_msg, socket) do
    {:noreply, socket}
  end

  def render(assigns) do
    ~H"""
    <div class="flex gap-4">
      <div class="flex-1">
        <div class="mb-4 flex items-center gap-2">
          <span class="font-mono text-sm text-gray-500">Room: {@room_id}</span>
        </div>

        <div id="player" class="aspect-video bg-black rounded mb-4">
          <div class="flex items-center justify-center h-full text-gray-500">
            No video playing
          </div>
        </div>

        <form phx-submit="add_url" class="flex gap-2 mb-4">
          <input
            type="text"
            name="url"
            placeholder="Paste a video URL..."
            class="input input-bordered flex-1"
          />
          <button type="submit" name="mode" value="now" class="btn btn-primary">Play Now</button>
          <button type="submit" name="mode" value="queue" class="btn btn-secondary">
            Add to Queue
          </button>
        </form>
      </div>

      <div class="w-64">
        <h3 class="font-bold mb-2">
          Users ({map_size(@users)})
        </h3>
        <ul class="space-y-1">
          <li :for={{uid, user} <- @users} data-user-id={uid} class="text-sm">
            {user.username}
          </li>
        </ul>
      </div>
    </div>
    """
  end
end
