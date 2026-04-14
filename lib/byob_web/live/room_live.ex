defmodule ByobWeb.RoomLive do
  use ByobWeb, :live_view

  alias Byob.{RoomManager, RoomServer}
  alias ByobWeb.RoomLive.{Playback, Queue, UrlPreview}

  def mount(%{"id" => room_id}, _session, socket) do
    if not Regex.match?(~r/^[a-z0-9]{1,16}$/, room_id) do
      {:ok, push_navigate(socket, to: "/")}
    else
      mount_room(room_id, socket)
    end
  end

  defp mount_room(room_id, socket) do
    {:ok, pid} = RoomManager.ensure_room(room_id)

    socket =
      assign(socket,
        room_id: room_id,
        room_pid: pid,
        users: %{},
        queue: [],
        history: [],
        current_index: nil,
        play_state: :paused,
        current_media: nil,
        ext_player: nil,
        sidebar_tab: :queue,
        editing_username: false,
        url_preview: nil,
        url_preview_loading: false,
        preview_url: nil,
        url_focused: false,
        api_key: nil,
        activity_log: [],
        sb_settings: Byob.RoomServer.default_sb_settings()
      )

    if connected?(socket) do
      # Use stable per-tab ID from sessionStorage (survives reconnects, unique per tab)
      tab_id = get_connect_params(socket)["tab_id"] || socket.id
      user_id = socket.assigns.user_id <> ":" <> tab_id
      # Prefer localStorage username over session-generated one
      username =
        case get_connect_params(socket)["stored_username"] do
          nil -> socket.assigns.username
          "" -> socket.assigns.username
          stored -> stored
        end
      browser_id = get_connect_params(socket)["browser_id"] || socket.assigns.user_id
      has_extension = get_connect_params(socket)["has_extension"] == true
      socket = assign(socket, user_id: user_id, browser_id: browser_id)
      Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")
      {:ok, state} = RoomServer.join(pid, user_id, username)

      # Analytics — use browser_id as distinct_id (same person across tabs)
      Byob.Analytics.room_joined(browser_id, room_id, has_extension: has_extension)

      current_media =
        if state.current_index, do: Enum.at(state.queue, state.current_index), else: nil

      socket =
        assign(socket,
          users: state.users,
          queue: state.queue,
          history: state.history,
          current_index: state.current_index,
          play_state: state.play_state,
          current_media: current_media,
          sb_settings: state.sb_settings,
          activity_log: state.activity_log || [],
          api_key: RoomServer.get_api_key(pid)
        )

      # Push full state to client hook for two-step join
      socket = push_event(socket, "sync:state", sync_state_payload(state, user_id))

      # Push SB settings and sponsor segments
      socket = push_event(socket, "sb:settings", state.sb_settings)

      socket =
        if state.sponsor_segments != [] && current_media do
          push_event(socket, "sponsor:segments", %{
            segments: state.sponsor_segments,
            duration: current_media.duration || 0,
            video_id: current_media.source_id
          })
        else
          socket
        end

      # Push media info for extension placeholder
      socket =
        if current_media && current_media.source_type == :extension_required do
          push_event(socket, "ext:media-info", %{
            title: current_media.title,
            thumbnail_url: current_media.thumbnail_url,
            url: current_media.url
          })
        else
          socket
        end

      {:ok, attach_hook(socket, :ensure_pid, :handle_event, fn _event, _params, socket ->
        {:cont, ensure_room_pid(socket)}
      end)}
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

  # Client events

  def handle_event("url:focus", params, socket), do: UrlPreview.handle_url_focus(params, socket)
  def handle_event("url:blur", params, socket), do: UrlPreview.handle_url_blur(params, socket)
  def handle_event("preview_url", params, socket), do: UrlPreview.handle_preview_url(params, socket)

  def handle_event("history:play", params, socket), do: Queue.handle_history_play(params, socket)

  def handle_event("add_url", params, socket), do: UrlPreview.handle_add_url(params, socket)
  def handle_event("preview:play_now", params, socket), do: UrlPreview.handle_play_now(params, socket)
  def handle_event("preview:queue", params, socket), do: UrlPreview.handle_queue(params, socket)

  def handle_event("analytics:has_extension", params, socket), do: Playback.handle_has_extension(params, socket)
  def handle_event("video:play", params, socket), do: Playback.handle_play(params, socket)
  def handle_event("video:pause", params, socket), do: Playback.handle_pause(params, socket)
  def handle_event("video:seek", params, socket), do: Playback.handle_seek(params, socket)
  def handle_event("video:embed_blocked", params, socket), do: Playback.handle_embed_blocked(params, socket)
  def handle_event("video:ended", params, socket), do: Playback.handle_ended(params, socket)

  def handle_event("queue:skip", params, socket), do: Queue.handle_skip(params, socket)
  def handle_event("queue:remove", params, socket), do: Queue.handle_remove(params, socket)
  def handle_event("queue:play_index", params, socket), do: Queue.handle_play_index(params, socket)
  def handle_event("queue:reorder", params, socket), do: Queue.handle_reorder(params, socket)
  def handle_event("switch_tab", params, socket), do: Queue.handle_switch_tab(params, socket)
  def handle_event("sb:update", params, socket), do: Queue.handle_sb_update(params, socket)

  def handle_event("username:edit", _params, socket) do
    {:noreply, assign(socket, editing_username: true)}
  end

  def handle_event("username:cancel", _params, socket) do
    {:noreply, assign(socket, editing_username: false)}
  end

  def handle_event("username:change", %{"username" => new_username}, socket) do
    new_username = String.trim(new_username)

    state = RoomServer.get_state(socket.assigns.room_pid)
    name_taken = Enum.any?(state.users, fn {uid, u} ->
      u.username == new_username && !is_self_user(uid, socket.assigns.user_id)
    end)

    if new_username != "" and String.length(new_username) <= 30 and not name_taken do
      # Rename this tab's user
      RoomServer.rename_user(socket.assigns.room_pid, socket.assigns.user_id, new_username)
      # Also rename other tabs of the same user
      [base | _] = String.split(socket.assigns.user_id, ":", parts: 2)
      state = RoomServer.get_state(socket.assigns.room_pid)
      for {uid, _} <- state.users, uid != socket.assigns.user_id, String.starts_with?(uid, base <> ":") do
        RoomServer.rename_user(socket.assigns.room_pid, uid, new_username)
      end

      socket =
        socket
        |> assign(username: new_username, editing_username: false)
        |> push_event("store-username", %{username: new_username})

      {:noreply, socket}
    else
      {:noreply, assign(socket, editing_username: false)}
    end
  end

  def handle_event("sync:ping", params, socket), do: Playback.handle_sync_ping(params, socket)

  # PubSub messages from RoomServer

  def handle_info({:sync_play, data}, socket) do
    {:noreply, push_event(socket, "sync:play", data)}
  end

  def handle_info({:sync_pause, data}, socket) do
    {:noreply, push_event(socket, "sync:pause", data)}
  end

  def handle_info({:sync_seek, data}, socket) do
    {:noreply, push_event(socket, "sync:seek", data)}
  end

  def handle_info({:sync_correction, data}, socket) do
    {:noreply, push_event(socket, "sync:correction", data)}
  end

  def handle_info({:queue_updated, %{queue: queue, current_index: current_index}}, socket) do
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
        push_event(socket, "ext:media-info", %{
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
        push_event(socket, "media:metadata", %{
          title: current_media.title,
          thumbnail_url: current_media.thumbnail_url
        })
      else
        socket
      end

    {:noreply, socket}
  end

  def handle_info({:sponsor_segments, data}, socket) do
    {:noreply, push_event(socket, "sponsor:segments", data)}
  end

  def handle_info({:queue_ended, _}, socket) do
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

    {:noreply, push_event(socket, "queue:ended", %{})}
  end

  def handle_info({:video_changed, data}, socket) do
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
        history: history
      )

    {:noreply, push_event(socket, "video:change", serialize_media_item(data))}
  end

  def handle_info({:url_preview_result, result}, socket), do: UrlPreview.handle_preview_result(result, socket)

  def handle_info({:sb_settings_updated, sb_settings}, socket) do
    # Push updated settings to JS for the auto-skip logic
    {:noreply, socket |> assign(sb_settings: sb_settings) |> push_event("sb:settings", sb_settings)}
  end

  def handle_info({:extension_player_state, state}, socket) do
    current = socket.assigns.ext_player
    # Only update if: no current state, same user, or new state is playing
    should_update =
      current == nil ||
      state.playing ||
      state[:user_id] == current[:user_id]

    if should_update do
      {:noreply, socket |> assign(ext_player: state) |> push_event("ext:player-state", state)}
    else
      {:noreply, socket}
    end
  end

  def handle_info({:users_updated, users}, socket) do
    {:noreply, assign(socket, users: users)}
  end

  def handle_info({:activity_log_updated, log}, socket) do
    {:noreply, assign(socket, activity_log: Enum.take(log, 50))}
  end

  def handle_info({:activity_log_entry, entry}, socket) do
    log = Enum.take([entry | socket.assigns.activity_log], 50)
    socket = assign(socket, activity_log: log)
    # Push toast to client
    socket = push_event(socket, "toast", %{text: format_log_entry(entry)})
    {:noreply, socket}
  end

  def handle_info(_msg, socket) do
    {:noreply, socket}
  end

  # Render

  def render(assigns) do
    ~H"""
    <%!-- Room nav bar — replaces layout nav --%>
    <nav id="room-nav" phx-hook="ReplaceLayoutNav" class="navbar min-h-0 h-10 bg-base-200 border-b border-base-300 px-2 sm:px-4" style="margin: -0.5rem -1rem 0.5rem -1rem; width: calc(100% + 2rem);">
      <div class="flex-1 flex items-center gap-2">
        <a href="/" class="flex items-center gap-1.5 flex-shrink-0">
          <img src={~p"/images/favicon.svg"} class="w-5 h-5" />
          <span class="text-base font-bold tracking-tight">byob</span>
        </a>
        <button
          id="copy-url"
          onclick={"
            var btn = this;
            navigator.clipboard.writeText('#{url(~p"/room/#{@room_id}")}').then(function() {
              var svg = btn.querySelector('svg');
              btn.textContent = 'Copied!';
              if (svg) btn.prepend(svg);
              setTimeout(function() {
                btn.lastChild.textContent = ' Copy Room Link';
              }, 1500);
            });
          "}
          class="btn btn-ghost btn-sm gap-1 text-base-content/60 flex-shrink-0"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <span class="hidden sm:inline">Copy Room Link</span>
        </button>
        <div class="relative flex-1 min-w-0 max-w-[40vw]">
          <form phx-submit="add_url" phx-change="preview_url" id="url-form">
            <input
              type="text"
              name="url"
              placeholder="Paste a video URL..."
              class="input input-bordered input-xs w-full"
              autocomplete="off"
              phx-debounce="300"
              phx-focus="url:focus"
              phx-blur="url:blur"
            />
          </form>
          <%!-- Supported sites hint (shown on focus with empty input) --%>
          <div
            :if={@url_focused && !@url_preview_loading && !@url_preview}
            class="absolute top-full left-0 right-0 mt-1 bg-base-200 rounded-lg shadow-xl border border-base-300 z-50 p-3"
          >
            <p class="text-xs font-semibold text-base-content/60 mb-2">Paste a URL to watch together</p>
            <div class="space-y-1.5">
              <div class="flex items-center gap-2 text-xs text-base-content/50">
                <svg class="w-4 h-4 flex-shrink-0 text-red-500" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                </svg>
                <span>YouTube — synced playback with <a href={Byob.Links.sponsor_block()} target="_blank" class="link link-primary">SponsorBlock</a></span>
              </div>
              <div class="flex items-center gap-2 text-xs text-base-content/50">
                <svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/>
                  <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none"/>
                </svg>
                <span>Direct video files — .mp4, .webm, .ogg, .mov, .mkv</span>
              </div>
              <div class="flex items-center gap-2 text-xs text-base-content/50">
                <svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/>
                </svg>
                <span>Any site — via browser extension (Crunchyroll, etc.)</span>
              </div>
            </div>
          </div>
          <%!-- Preview dropdown --%>
          <div
            :if={@url_preview_loading || @url_preview}
            class="absolute top-full left-0 right-0 mt-1 bg-base-200 rounded-lg shadow-xl border border-base-300 z-50"
          >
            <div :if={@url_preview_loading} class="flex items-center gap-3 p-3 animate-pulse">
              <div class="w-16 h-10 bg-base-300 rounded flex-shrink-0" />
              <div class="flex-1 space-y-2">
                <div class="h-3 bg-base-300 rounded w-3/4" />
                <div class="h-2 bg-base-300 rounded w-1/2" />
              </div>
            </div>
            <div
              :if={@url_preview && @url_preview.source_type == :youtube}
              class="flex items-center gap-2 p-3"
            >
              <img
                :if={@url_preview.thumbnail_url}
                src={@url_preview.thumbnail_url}
                class="w-16 h-10 object-cover rounded flex-shrink-0"
              />
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium line-clamp-3">{@url_preview.title}</p>
                <p :if={@url_preview.author_name} class="text-xs text-base-content/50">
                  {@url_preview.author_name}
                </p>
              </div>
              <div class="flex gap-1 flex-shrink-0">
                <button type="button" phx-click="preview:play_now" class="btn btn-primary btn-xs">
                  Play Now
                </button>
                <button type="button" phx-click="preview:queue" class="btn btn-outline btn-xs">
                  Queue
                </button>
              </div>
            </div>
            <%!-- Direct URL preview --%>
            <div
              :if={@url_preview && @url_preview.source_type == :direct_url}
              class="flex items-center gap-2 p-3"
            >
              <div class="w-16 h-10 bg-base-300 rounded flex-shrink-0 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-base-content/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15.91 11.672a.375.375 0 010 .656l-5.603 3.113a.375.375 0 01-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112z" />
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <p :if={@url_preview.title} class="text-sm font-medium line-clamp-3">{@url_preview.title}</p>
                <p :if={!@url_preview.title} class="text-sm font-medium truncate">{@url_preview.url || "Direct video"}</p>
                <p class="text-xs text-base-content/50">Direct video file</p>
              </div>
              <div class="flex gap-1 flex-shrink-0">
                <button type="button" phx-click="preview:play_now" class="btn btn-primary btn-xs">
                  Play Now
                </button>
                <button type="button" phx-click="preview:queue" class="btn btn-outline btn-xs">
                  Queue
                </button>
              </div>
            </div>
            <%!-- Extension-required preview --%>
            <div
              :if={@url_preview && @url_preview.source_type == :extension_required}
              class="flex items-center gap-2 p-3"
            >
              <img
                :if={@url_preview.thumbnail_url}
                src={@url_preview.thumbnail_url}
                class="w-16 h-10 object-cover rounded flex-shrink-0"
              />
              <div
                :if={!@url_preview.thumbnail_url}
                class="w-16 h-10 bg-base-300 rounded flex-shrink-0 flex items-center justify-center"
              >
                <span class="text-xs text-base-content/30">EXT</span>
              </div>
              <div class="flex-1 min-w-0">
                <p :if={@url_preview.title} class="text-sm font-medium line-clamp-3">{@url_preview.title}</p>
                <p :if={!@url_preview.title} class="text-sm font-medium">External site</p>
                <p class="text-xs text-warning byob-no-ext">
                  <a href="https://github.com/joegoldin/byob.video" target="_blank" class="underline">
                    Extension required
                  </a>
                  to sync this site
                </p>
              </div>
              <div class="flex gap-1 flex-shrink-0">
                <button type="button" phx-click="preview:play_now" class="btn btn-primary btn-xs">
                  Play Now
                </button>
                <button type="button" phx-click="preview:queue" class="btn btn-outline btn-xs">
                  Queue
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="flex-none flex items-center gap-1">
        <button
          class="btn btn-ghost btn-xs btn-circle"
          onclick="document.getElementById('sb-settings-modal')?.showModal()"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <label class="swap swap-rotate btn btn-ghost btn-xs btn-circle">
          <input
            type="checkbox"
            id="theme-toggle-room"
            onchange="document.documentElement.setAttribute('data-theme', this.checked ? 'dark' : 'light'); localStorage.setItem('phx:theme', this.checked ? 'dark' : 'light')"
          />
          <svg class="swap-off h-4 w-4 fill-current" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <path d="M5.64,17l-.71.71a1,1,0,0,0,0,1.41,1,1,0,0,0,1.41,0l.71-.71A1,1,0,0,0,5.64,17ZM5,12a1,1,0,0,0-1-1H3a1,1,0,0,0,0,2H4A1,1,0,0,0,5,12Zm7-7a1,1,0,0,0,1-1V3a1,1,0,0,0-2,0V4A1,1,0,0,0,12,5ZM5.64,7.05a1,1,0,0,0,.7.29,1,1,0,0,0,.71-.29,1,1,0,0,0,0-1.41l-.71-.71A1,1,0,0,0,4.93,6.34Zm12,.29a1,1,0,0,0,.7-.29l.71-.71a1,1,0,1,0-1.41-1.41L17,5.64a1,1,0,0,0,0,1.41A1,1,0,0,0,17.66,7.34ZM21,11H20a1,1,0,0,0,0,2h1a1,1,0,0,0,0-2Zm-9,8a1,1,0,0,0-1,1v1a1,1,0,0,0,2,0V20A1,1,0,0,0,12,19ZM18.36,17A1,1,0,0,0,17,18.36l.71.71a1,1,0,0,0,1.41,0,1,1,0,0,0,0-1.41ZM12,6.5A5.5,5.5,0,1,0,17.5,12,5.51,5.51,0,0,0,12,6.5Zm0,9A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z" />
          </svg>
          <svg class="swap-on h-4 w-4 fill-current" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <path d="M21.64,13a1,1,0,0,0-1.05-.14,8.05,8.05,0,0,1-3.37.73A8.15,8.15,0,0,1,9.08,5.49a8.59,8.59,0,0,1,.25-2A1,1,0,0,0,8,2.36,10.14,10.14,0,1,0,22,14.05,1,1,0,0,0,21.64,13Zm-9.5,6.69A8.14,8.14,0,0,1,7.08,5.22v.27A10.15,10.15,0,0,0,17.22,15.63a9.79,9.79,0,0,0,2.1-.22A8.11,8.11,0,0,1,12.14,19.73Z" />
          </svg>
        </label>
      </div>
    </nav>

    <%!-- SponsorBlock settings modal --%>
    <dialog id="sb-settings-modal" class="modal">
      <div class="modal-box max-w-md relative">
        <form method="dialog">
          <button class="btn btn-sm btn-circle btn-ghost absolute right-3 top-3">✕</button>
        </form>
        <%!-- About section --%>
        <div class="flex flex-col items-center mb-4 p-3 bg-base-100 rounded-xl">
          <img src={~p"/images/logo.svg"} class="w-64 h-64" />
        </div>
        <div class="text-xs text-base-content/50 space-y-1 mb-4 pb-4 border-b border-base-300 text-center">
          <p>
            <a href={Byob.Links.source_code()} target="_blank" class="text-base-content/50 hover:text-base-content/70" title="Source on GitHub">
              <svg class="w-4 h-4 inline" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            </a>
            <span class="mx-1">&middot;</span>
            <a href={Byob.Links.privacy_policy()} target="_blank" class="link link-primary">Privacy</a>
            <span class="mx-1">&middot;</span>
            <a href="https://github.com/joegoldin/byob.video/blob/main/CHANGELOG.md" target="_blank" class="link link-primary">v{Application.spec(:byob, :vsn)}</a>
          </p>
        </div>

        <%!-- SponsorBlock settings --%>
        <h3 class="font-bold text-lg mb-1"><a href={Byob.Links.sponsor_block()} target="_blank" class="link">SponsorBlock</a> Settings</h3>
        <p class="text-xs text-base-content/50 mb-4">
          Settings apply to this room for all users.
        </p>
        <div class="space-y-2">
          <.sb_row
            :for={{cat, action} <- @sb_settings}
            category={cat}
            action={action}
          />
        </div>
        <%!-- Room API Key --%>
        <div :if={@api_key} class="mt-4 pt-4 border-t border-base-300">
          <h4 class="font-semibold text-sm mb-2">Room API Key</h4>
          <div class="flex items-center gap-2">
            <code class="text-xs bg-base-100 px-2 py-1 rounded flex-1 truncate select-all">{@api_key}</code>
            <button onclick={"navigator.clipboard.writeText('#{@api_key}')"} class="btn btn-xs btn-ghost">Copy</button>
          </div>
          <a href="/api" target="_blank" class="text-xs link link-primary mt-1 block">API Documentation</a>
        </div>
        <%!-- Attribution --%>
        <div class="mt-4 pt-4 border-t border-base-300 text-xs text-base-content/40 space-y-1">
          <p>
            <a href={Byob.Links.sponsor_block()} target="_blank" class="link link-primary">SponsorBlock</a>
            API by <a href="https://ajay.app" target="_blank" class="link link-primary">Ajay Ramachandran</a> (GPLv3)
          </p>
          <p>
            Built with
            <a href="https://phoenixframework.org" target="_blank" class="link link-primary">Phoenix</a>,
            <a href="https://daisyui.com" target="_blank" class="link link-primary">daisyUI</a>,
            and <a href="https://tailwindcss.com" target="_blank" class="link link-primary">Tailwind CSS</a>
          </p>
          <p>
            byob.video is <a href={Byob.Links.source_code()} target="_blank" class="link link-primary">open source</a> under MIT License
          </p>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>

    <div class="flex flex-col lg:flex-row gap-3 lg:min-h-[calc(100vh-3.5rem)]">
      <%!-- Main content --%>
      <div class="flex-1 min-w-0 flex flex-col">

        <%!-- Player wrapper: sizes the player to fit viewport while maintaining 16:9 --%>
        <div id="player-sizer" class="mb-3 flex justify-center" phx-update="ignore">
        <div
          id="player"
          phx-hook="VideoPlayer"
          data-user-id={@user_id}
          data-current-index={@current_index}
          class="relative bg-base-300 rounded-lg overflow-hidden"
        >
          <div class="absolute inset-0 flex items-center justify-center text-base-content/40">
            Paste a URL below to start watching
          </div>
        </div>
        </div>

        <%!-- Extension mode banner --%>
        <div
          :if={@current_media && @current_media.source_type == :extension_required}
          class="alert mb-3"
        >
          <div>
            <p class="text-sm font-medium">Extension required for this site</p>
            <p class="text-xs text-base-content/60">
              Click play on the video for the extension to hook it.
            </p>
          </div>
          <button
            phx-hook="ExtOpenBtn"
            id="ext-open-btn"
            data-url={@current_media.url}
            data-room-id={@room_id}
            data-server-url={ByobWeb.Endpoint.url()}
            data-token={ByobWeb.ExtensionSocket.generate_token(@room_id)}
            class="btn btn-primary btn-sm"
          >
            Open Player Window
          </button>
        </div>

      </div>

      <%!-- Sidebar: queue/history at top, users pinned at bottom --%>
      <div class="lg:w-72 flex flex-col lg:h-[calc(100vh-3.5rem)]">
        <%!-- Queue/History card — fills available space --%>
        <div class="card bg-base-200 flex-1 min-h-0 overflow-hidden">
          <div class="card-body p-4 flex flex-col overflow-hidden">
            <%!-- Tabs --%>
            <div class="flex items-center gap-1 mb-2">
              <div role="tablist" class="tabs tabs-box tabs-sm flex-1">
                <button
                  role="tab"
                  class={"tab #{if @sidebar_tab == :queue, do: "tab-active"}"}
                  phx-click="switch_tab"
                  phx-value-tab="queue"
                >
                  Queue
                  <span :if={@queue != []} class="badge badge-xs ml-1">{length(@queue) - (@current_index || 0)}</span>
                </button>
                <button
                  role="tab"
                  class={"tab #{if @sidebar_tab == :history, do: "tab-active"}"}
                  phx-click="switch_tab"
                  phx-value-tab="history"
                >
                  History
                  <span :if={@history != []} class="badge badge-xs ml-1">
                    {length(@history)}
                  </span>
                </button>
              </div>
            </div>

            <%!-- Queue list --%>
            <div
              :if={@sidebar_tab == :queue && @queue != []}
              class="overflow-y-auto flex-1 space-y-2"
            >
              <%!-- Now Playing --%>
              <div :if={@current_index != nil && Enum.at(@queue, @current_index)} class="mb-1">
                <div class="text-xs font-semibold text-primary uppercase tracking-wide mb-1">
                  Now Playing
                </div>
                <% now_playing = Enum.at(@queue, @current_index) %>
                <div class="flex items-center gap-2 p-2 rounded-lg bg-primary/10 ring-1 ring-primary/30 text-sm">
                  <img
                    :if={now_playing.thumbnail_url}
                    src={now_playing.thumbnail_url}
                    class="w-14 h-9 object-cover rounded flex-shrink-0"
                  />
                  <div
                    :if={!now_playing.thumbnail_url}
                    class="w-14 h-9 bg-base-300 rounded flex-shrink-0 flex items-center justify-center"
                  >
                    <span class="text-xs text-base-content/30">?</span>
                  </div>
                  <div class="flex-1 min-w-0">
                    <span
                      :if={now_playing.title}
                      title={now_playing.title}
                      class="block text-sm font-medium line-clamp-3"
                    >
                      {now_playing.title}
                    </span>
                    <span :if={show_url?(now_playing)} title={now_playing.url} class="block text-xs text-base-content/50 line-clamp-2">
                      {now_playing.url}
                    </span>
                    <span :if={now_playing.added_by_name} class="block text-xs text-base-content/40 mt-0.5">
                      {now_playing.added_by_name}
                      <time :if={format_time(now_playing.added_at)} datetime={format_time(now_playing.added_at)} phx-hook="LocalTime" id={"time-np-#{now_playing.id}"}></time>
                    </span>
                  </div>
                </div>
              </div>

              <%!-- Up Next --%>
              <% up_next =
                @queue
                |> Enum.with_index()
                |> Enum.filter(fn {_item, idx} -> idx > (@current_index || -1) end)
              %>
              <div :if={up_next != []}>
                <div class="text-xs font-semibold text-base-content/40 uppercase tracking-wide mb-1">
                  Up Next
                </div>
                <ul class="space-y-1" id="queue-sortable" phx-hook="DragSort">
                  <li
                    :for={{item, idx} <- up_next}
                    draggable="true"
                    data-queue-idx={idx}
                    data-url={item.url}
                    phx-hook="QueueContextMenu"
                    id={"queue-item-#{item.id}"}
                    class="flex items-center gap-2 p-2 rounded-lg text-sm hover:bg-base-300 transition-colors cursor-grab active:cursor-grabbing"
                  >
                    <span class="text-base-content/20 flex-shrink-0 text-xs select-none">⠿</span>
                    <img
                      :if={item.thumbnail_url}
                      src={item.thumbnail_url}
                      class="w-14 h-9 object-cover rounded flex-shrink-0"
                    />
                    <div
                      :if={!item.thumbnail_url}
                      class="w-14 h-9 bg-base-300 rounded flex-shrink-0 flex items-center justify-center"
                    >
                      <span class="text-xs text-base-content/30">?</span>
                    </div>
                    <button
                      phx-click="queue:play_index"
                      phx-value-index={idx}
                      class="flex-1 text-left min-w-0"
                    >
                      <span :if={item.title} title={item.title} class="block text-xs font-medium line-clamp-2">
                        {item.title}
                      </span>
                      <span :if={!item.title} class="block text-xs text-base-content/50 truncate">
                        {item.url}
                      </span>
                      <span :if={item.added_by_name} class="block text-[10px] text-base-content/40 mt-0.5">
                        {item.added_by_name}
                        <time :if={format_time(item.added_at)} datetime={format_time(item.added_at)} phx-hook="LocalTime" id={"time-q-#{item.id}"}></time>
                      </span>
                    </button>
                    <button
                      phx-click="queue:remove"
                      phx-value-item_id={item.id}
                      class="btn btn-xs btn-ghost btn-circle opacity-50 hover:opacity-100"
                    >
                      x
                    </button>
                  </li>
                </ul>
              </div>
            </div>
            <p
              :if={@sidebar_tab == :queue && @queue == []}
              class="text-sm text-base-content/40 flex-1 flex items-center justify-center"
            >
              No videos in queue
            </p>

            <%!-- History list --%>
            <ul
              :if={@sidebar_tab == :history && @history != []}
              class="space-y-2 overflow-y-auto flex-1"
            >
              <li
                :for={entry <- @history}
                phx-click="history:play"
                phx-value-url={entry.item.url}
                class="flex items-center gap-2 p-2 rounded-lg text-sm hover:bg-base-300 transition-colors cursor-pointer"
              >
                <img
                  :if={entry.item.thumbnail_url}
                  src={entry.item.thumbnail_url}
                  class="w-14 h-9 object-cover rounded flex-shrink-0"
                />
                <div
                  :if={!entry.item.thumbnail_url}
                  class="w-14 h-9 bg-base-300 rounded flex-shrink-0 flex items-center justify-center"
                >
                  <span class="text-xs text-base-content/30">?</span>
                </div>
                <div class="flex-1 min-w-0">
                  <span :if={entry.item.title} title={entry.item.title} class="block text-xs font-medium line-clamp-2">
                    {entry.item.title}
                  </span>
                  <span :if={!entry.item.title} class="block text-xs text-base-content/50 truncate">
                    {entry.item.url}
                  </span>
                  <span class="block text-xs text-base-content/40 mt-0.5">
                    {if entry.item.added_by_name, do: entry.item.added_by_name, else: ""}
                    <time :if={format_time(entry.played_at)} datetime={format_time(entry.played_at)} phx-hook="LocalTime" id={"time-h-#{entry.item.id}-#{System.unique_integer([:positive])}"}></time>
                  </span>
                </div>
              </li>
            </ul>
            <p
              :if={@sidebar_tab == :history && @history == []}
              class="text-sm text-base-content/40 flex-1 flex items-center justify-center"
            >
              No history yet
            </p>
          </div>
        </div>

        <%!-- Activity log --%>
        <div class="card bg-base-200 mt-2 flex-shrink-0">
          <div class="card-body p-3">
            <h3 class="card-title text-xs text-base-content/40">Activity</h3>
            <ul id="activity-log" phx-hook="ScrollBottom" class="space-y-0.5 mt-1 max-h-32 overflow-y-auto text-[11px] text-base-content/50 leading-relaxed">
              <li :for={entry <- Enum.reverse(Enum.take(@activity_log, 30))} class="flex gap-1">
                <span :if={entry.action == :joined} class="text-success/60 flex-shrink-0">+</span>
                <span :if={entry.action == :left} class="text-error/60 flex-shrink-0">-</span>
                <span :if={entry.action == :now_playing} class="text-primary/60 flex-shrink-0">&#9654;</span>
                <span :if={entry.action == :play} class="text-success/60 flex-shrink-0">&#9654;</span>
                <span :if={entry.action == :pause} class="text-warning/60 flex-shrink-0">&#10074;&#10074;</span>
                <span :if={entry.action == :added} class="text-primary/60 flex-shrink-0">+</span>
                <span :if={entry.action == :skipped} class="text-base-content/40 flex-shrink-0">&#9197;</span>
                <span :if={entry.action == :seeked} class="text-info/60 flex-shrink-0">&#8644;</span>
                <span :if={entry.action == :renamed} class="text-base-content/40 flex-shrink-0">&#9998;</span>
                <span class="flex-1 line-clamp-2">{format_log_entry(entry)}</span>
                <time
                  :if={entry.at}
                  datetime={DateTime.to_iso8601(entry.at)}
                  phx-hook="LocalTime"
                  id={"log-#{System.unique_integer([:positive])}"}
                  class="text-base-content/30 flex-shrink-0 whitespace-nowrap"
                ></time>
              </li>
              <li :if={@activity_log == []} class="text-base-content/30 italic">No activity yet</li>
            </ul>
          </div>
        </div>

        <%!-- Users card — pinned at bottom --%>
        <div class="card bg-base-200 mt-4 mb-4 flex-shrink-0">
          <div class="card-body p-4">
            <h3 class="card-title text-sm">
              Users
              <span class="badge badge-sm">{@users |> Enum.map(fn {_, u} -> u.username end) |> Enum.uniq() |> length()}</span>
            </h3>
            <ul class="space-y-2 mt-1 max-h-48 overflow-y-auto">
              <li
                :for={{uid, user} <- dedup_users(@users, @user_id)}
                data-user-id={uid}
                class="flex items-center gap-2 text-sm"
              >
                <div class={"w-2 h-2 rounded-full flex-shrink-0 #{if user.connected, do: "bg-success", else: "bg-base-content/20"}"}  />
                <%!-- Other users: just show name --%>
                <span :if={!is_self_user(uid, @user_id)} class="truncate">{user.username}</span>
                <%!-- Self: show name + tab indicator --%>
                <span
                  :if={is_self_user(uid, @user_id) && !@editing_username}
                  class="truncate flex-1"
                >
                  <span class="font-bold">{user.username}</span>
                  <span :if={uid == @user_id} class="text-base-content/40 font-normal">(you)</span>
                  <span :if={uid != @user_id} class="text-base-content/30 font-normal text-xs">(other tab)</span>
                </span>
                <button
                  :if={uid == @user_id && !@editing_username}
                  phx-click="username:edit"
                  class="btn btn-xs btn-ghost opacity-50 hover:opacity-100"
                >
                  edit
                </button>
                <form
                  :if={uid == @user_id && @editing_username}
                  phx-submit="username:change"
                  class="flex gap-1 flex-1 min-w-0"
                >
                  <input
                    type="text"
                    name="username"
                    value={user.username}
                    class="input input-xs input-bordered flex-1 min-w-0"
                    autofocus
                  />
                  <button type="submit" class="btn btn-xs btn-ghost">ok</button>
                </form>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
    """
  end

  # Components

  @sb_labels %{
    "sponsor" => {"Sponsor", "#00d400"},
    "selfpromo" => {"Self Promotion", "#ffff00"},
    "interaction" => {"Interaction", "#cc00ff"},
    "intro" => {"Intro", "#00ffff"},
    "outro" => {"Outro", "#0202ed"},
    "preview" => {"Preview/Recap", "#008fd6"},
    "music_offtopic" => {"Non-Music", "#ff9900"},
    "filler" => {"Filler/Tangent", "#7300FF"}
  }

  defp sb_row(assigns) do
    {label, color} = Map.get(@sb_labels, assigns.category, {assigns.category, "#888"})
    assigns = assign(assigns, label: label, color: color)

    ~H"""
    <div class="flex items-center gap-3">
      <div class="w-3 h-3 rounded-sm flex-shrink-0" style={"background: #{@color}"} />
      <span class="text-sm flex-1">{@label}</span>
      <form phx-change="sb:update" class="m-0">
        <input type="hidden" name="category" value={@category} />
        <select name="action" class="select select-xs select-bordered w-32">
          <option value="auto_skip" selected={@action == "auto_skip"}>Auto Skip</option>
          <option value="show_bar" selected={@action == "show_bar"}>Show in Bar</option>
          <option value="disabled" selected={@action == "disabled"}>Disabled</option>
        </select>
      </form>
    </div>
    """
  end

  # Private helpers

  defp format_log_entry(%{action: :joined, user: user}), do: "#{user} joined"
  defp format_log_entry(%{action: :left, user: user}), do: "#{user} left"
  defp format_log_entry(%{action: :now_playing, detail: detail}), do: "Now playing: #{detail}"
  defp format_log_entry(%{action: :play, user: user, detail: nil}), do: "#{user} resumed"
  defp format_log_entry(%{action: :play, user: user, detail: title}), do: "#{user} resumed #{title}"
  defp format_log_entry(%{action: :pause, user: user, detail: nil}), do: "#{user} paused"
  defp format_log_entry(%{action: :pause, user: user, detail: title}), do: "#{user} paused #{title}"
  defp format_log_entry(%{action: :added, user: user, detail: url}), do: "#{user} added #{url}"
  defp format_log_entry(%{action: :seeked, user: user, detail: detail}), do: "#{user} seeked #{detail}"
  defp format_log_entry(%{action: :skipped}), do: "Skipped to next"
  defp format_log_entry(%{action: :renamed, detail: detail}), do: "Renamed: #{detail}"
  defp format_log_entry(_), do: nil

  defp show_url?(item) do
    has_title = is_binary(item.title) and item.title != ""
    is_youtube = is_binary(item.url) and (String.contains?(item.url, "youtube.com") or String.contains?(item.url, "youtu.be"))
    not (has_title and is_youtube)
  end

  defp dedup_users(users, my_user_id) do
    # Group by username, pick best representative per name:
    # prefer self > connected > disconnected
    users
    |> Enum.sort_by(fn {id, u} ->
      {(if is_self_user(id, my_user_id), do: 0, else: 1),
       (if u.connected, do: 0, else: 1)}
    end)
    |> Enum.uniq_by(fn {_id, u} -> u.username end)
  end

  defp is_self_user(uid, my_user_id) do
    # user_ids are "session_id:tab_id" — same session = same person
    [my_base | _] = String.split(my_user_id, ":", parts: 2)
    String.starts_with?(uid, my_base <> ":")
  end

  defp ensure_room_pid(socket) do
    pid = socket.assigns[:room_pid]
    if pid && Process.alive?(pid) do
      socket
    else
      {:ok, new_pid} = RoomManager.ensure_room(socket.assigns.room_id)
      # Re-join the room with the new pid
      if socket.assigns[:user_id] do
        username = socket.assigns[:username] || "Guest"
        RoomServer.join(new_pid, socket.assigns.user_id, username)
        Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{socket.assigns.room_id}")
      end
      assign(socket, room_pid: new_pid)
    end
  end

  defp format_time(nil), do: nil
  defp format_time(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp format_time(_), do: nil

  defp sync_state_payload(state, user_id) do
    %{
      user_id: user_id,
      queue: Enum.map(state.queue, &serialize_item/1),
      current_index: state.current_index,
      play_state: Atom.to_string(state.play_state),
      current_time: state.current_time,
      server_time: state.server_time,
      playback_rate: state.playback_rate
    }
  end

  defp serialize_media_item(%{media_item: item, index: index}) do
    %{media_item: serialize_item(item), index: index}
  end

  defp serialize_item(%Byob.MediaItem{} = item) do
    %{
      id: item.id,
      url: item.url,
      source_type: Atom.to_string(item.source_type),
      source_id: item.source_id,
      title: item.title,
      thumbnail_url: item.thumbnail_url
    }
  end

  defp serialize_item(item) when is_map(item) do
    %{
      id: item[:id] || item["id"],
      url: item[:url] || item["url"],
      source_type: to_string(item[:source_type] || item["source_type"]),
      source_id: item[:source_id] || item["source_id"],
      title: item[:title] || item["title"],
      thumbnail_url: item[:thumbnail_url] || item["thumbnail_url"]
    }
  end
end
