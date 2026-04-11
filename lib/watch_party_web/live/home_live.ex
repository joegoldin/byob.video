defmodule WatchPartyWeb.HomeLive do
  use WatchPartyWeb, :live_view

  def mount(_params, _session, socket) do
    {:ok, socket}
  end

  def handle_event("create_room", _params, socket) do
    {:ok, room_id} = WatchParty.RoomManager.create_room()
    {:noreply, push_navigate(socket, to: ~p"/room/#{room_id}")}
  end

  def render(assigns) do
    ~H"""
    <div class="flex items-center justify-center min-h-[60vh]">
      <div class="text-center">
        <h1 class="text-4xl font-bold mb-8">WatchParty</h1>
        <p class="text-lg mb-8 text-gray-600">Watch videos together in sync</p>
        <button phx-click="create_room" class="btn btn-primary btn-lg">
          Create Room
        </button>
      </div>
    </div>
    """
  end
end
