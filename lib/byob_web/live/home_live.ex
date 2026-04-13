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
        {:ok, room_id, _api_key} ->
          {:noreply, socket |> assign(room_creates: [now | recent]) |> push_navigate(to: ~p"/room/#{room_id}")}

        {:error, :max_capacity} ->
          {:noreply, put_flash(socket, :error, "Server is at maximum capacity. Please try again later.")}
      end
    end
  end

  def render(assigns) do
    ~H"""
    <div class="flex items-center justify-center min-h-[70vh]">
      <div class="card bg-base-200 shadow-xl p-10 text-center items-center max-w-lg">
        <div class="bg-base-100 rounded-xl p-3 mb-4">
          <img src={~p"/images/logo.svg"} class="w-64 h-64" />
        </div>
        <p class="text-base-content/60 mb-6">Watch videos together in sync. Free and open source.</p>

        <button phx-click="create_room" class="btn btn-primary btn-lg mb-6">
          Create Room
        </button>

        <div class="space-y-2 text-sm text-base-content/50 mb-6">
          <div class="flex items-center gap-2 justify-center">
            <svg class="w-4 h-4 flex-shrink-0 text-red-500" viewBox="0 0 24 24" fill="currentColor">
              <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
            </svg>
            <span>YouTube with <a href={Byob.Links.sponsor_block()} target="_blank" class="link link-primary">SponsorBlock</a></span>
          </div>
          <div class="flex items-center gap-2 justify-center">
            <svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none"/>
            </svg>
            <span>Direct video files (.mp4, .webm, .mkv)</span>
          </div>
          <div class="flex items-center gap-2 justify-center">
            <svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/>
            </svg>
            <span>Any site via <a onclick={Byob.Links.extension_js()} class="link link-primary cursor-pointer">browser extension</a></span>
          </div>
        </div>

      </div>
    </div>
    """
  end
end
