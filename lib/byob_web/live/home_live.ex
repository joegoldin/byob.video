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
          Byob.Analytics.room_created(socket.assigns.user_id, room_id)

          {:noreply,
           socket
           |> assign(room_creates: [now | recent])
           |> push_navigate(to: ~p"/room/#{room_id}")}

        {:error, :max_capacity} ->
          {:noreply,
           put_flash(socket, :error, "Server is at maximum capacity. Please try again later.")}
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
              <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
            </svg>
            <span>
              YouTube with
              <a href={Byob.Links.sponsor_block()} target="_blank" class="link link-primary">
                SponsorBlock
              </a>
            </span>
          </div>
          <div class="flex items-center gap-2 justify-center">
            <svg class="w-4 h-4 flex-shrink-0 text-[#1ab7ea]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M23.977 6.416c-.105 2.338-1.739 5.543-4.894 9.609-3.268 4.247-6.026 6.37-8.29 6.37-1.409 0-2.578-1.294-3.553-3.881L5.322 11.4C4.603 8.816 3.834 7.522 3.01 7.522c-.179 0-.806.378-1.881 1.132L0 7.197c1.185-1.044 2.351-2.084 3.501-3.128C5.08 2.701 6.266 1.984 7.055 1.91c1.867-.178 3.016 1.1 3.447 3.838.465 2.953.789 4.789.971 5.507.539 2.45 1.131 3.674 1.776 3.674.502 0 1.256-.796 2.265-2.385 1.004-1.589 1.54-2.797 1.612-3.628.144-1.371-.395-2.061-1.614-2.061-.574 0-1.167.121-1.777.391 1.186-3.868 3.434-5.757 6.762-5.637 2.473.06 3.628 1.664 3.48 4.807z" />
            </svg>
            <span>Vimeo</span>
          </div>
          <div class="flex items-center gap-2 justify-center">
            <svg class="w-4 h-4 flex-shrink-0 text-[#9146FF]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
            </svg>
            <span>Twitch (live channels &amp; VODs)</span>
          </div>
          <div class="flex items-center gap-2 justify-center">
            <svg
              class="w-4 h-4 flex-shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle cx="12" cy="12" r="10" />
              <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
            </svg>
            <span>Direct video files (.mp4, .webm, .mkv)</span>
          </div>
          <div class="flex items-center gap-2 justify-center">
            <svg
              class="w-4 h-4 flex-shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
              />
            </svg>
            <span>
              Any site via
              <a onclick={Byob.Links.extension_js()} class="link link-primary cursor-pointer">
                browser extension
              </a>
            </span>
          </div>
        </div>
      </div>
    </div>
    """
  end
end
