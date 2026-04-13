defmodule ByobWeb.HomeLive do
  use ByobWeb, :live_view

  @max_creates_per_minute 5

  def mount(_params, _session, socket) do
    {:ok, assign(socket, room_creates: [], create_error: nil)}
  end

  def handle_event("create_room", _params, socket) do
    now = System.monotonic_time(:second)
    recent = Enum.filter(socket.assigns.room_creates, &(&1 > now - 60))

    if length(recent) >= @max_creates_per_minute do
      {:noreply, put_flash(socket, :error, "Too many rooms created. Please wait a moment.")}
    else
      case Byob.RoomManager.create_room() do
        {:ok, room_id} ->
          {:noreply, socket |> assign(room_creates: [now | recent]) |> push_navigate(to: ~p"/room/#{room_id}")}

        {:error, :max_capacity} ->
          {:noreply, put_flash(socket, :error, "Server is at maximum capacity. Please try again later.")}
      end
    end
  end

  def render(assigns) do
    ~H"""
    <div class="flex items-center justify-center min-h-[70vh]">
      <div class="card bg-base-200 shadow-xl p-10 text-center">
        <h1 class="text-5xl font-bold mb-1">byob</h1>
        <p class="text-sm text-base-content/40 mb-1">bring your own binge</p>
        <p class="text-base-content/60 mb-8">Watch videos together in sync</p>
        <button phx-click="create_room" class="btn btn-primary btn-lg">
          Create Room
        </button>
      </div>
    </div>
    """
  end
end
