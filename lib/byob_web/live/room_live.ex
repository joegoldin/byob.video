defmodule ByobWeb.RoomLive do
  use ByobWeb, :live_view

  alias Byob.{RoomManager, RoomServer}

  def mount(%{"id" => room_id}, _session, socket) do
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
      socket = assign(socket, user_id: user_id)
      Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")
      {:ok, state} = RoomServer.join(pid, user_id, username)

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
          sb_settings: state.sb_settings
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

      {:ok, socket}
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

  def handle_event("preview_url", %{"url" => url}, socket) do
    url = String.trim(url)

    if url == "" do
      {:noreply, assign(socket, url_preview: nil, url_preview_loading: false)}
    else
      case Byob.MediaItem.parse_url(url) do
        {:ok, %{source_type: :youtube}} ->
          socket = assign(socket, url_preview_loading: true, url_preview: nil)
          pid = self()

          Task.start(fn ->
            case Byob.OEmbed.fetch_youtube(url) do
              {:ok, meta} -> send(pid, {:url_preview_result, meta})
              _ -> send(pid, {:url_preview_result, nil})
            end
          end)

          {:noreply, socket}

        {:ok, %{source_type: :extension_required}} ->
          socket = assign(socket, url_preview_loading: true, url_preview: nil)
          me = self()

          Task.start(fn ->
            case Byob.OEmbed.fetch_opengraph(url) do
              {:ok, meta} ->
                send(me, {:url_preview_result, Map.put(meta, :source_type, :extension_required)})
              _ ->
                send(me, {:url_preview_result, %{title: nil, thumbnail_url: nil, source_type: :extension_required}})
            end
          end)

          {:noreply, socket}

        _ ->
          {:noreply, assign(socket, url_preview: nil, url_preview_loading: false)}
      end
    end
  end

  def handle_event("history:play", %{"url" => url}, socket) do
    RoomServer.add_to_queue(socket.assigns.room_pid, socket.assigns.user_id, url, :now)
    {:noreply, socket}
  end

  def handle_event("add_url", %{"url" => url, "mode" => mode}, socket) do
    mode_atom = if mode == "now", do: :now, else: :queue
    RoomServer.add_to_queue(socket.assigns.room_pid, socket.assigns.user_id, url, mode_atom)
    {:noreply, assign(socket, url_preview: nil, url_preview_loading: false)}
  end

  def handle_event("video:play", %{"position" => position}, socket) do
    RoomServer.play(socket.assigns.room_pid, socket.assigns.user_id, position)
    {:noreply, socket}
  end

  def handle_event("video:pause", %{"position" => position}, socket) do
    RoomServer.pause(socket.assigns.room_pid, socket.assigns.user_id, position)
    {:noreply, socket}
  end

  def handle_event("video:seek", %{"position" => position}, socket) do
    RoomServer.seek(socket.assigns.room_pid, socket.assigns.user_id, position)
    {:noreply, socket}
  end

  def handle_event("video:ended", %{"index" => index}, socket) do
    RoomServer.video_ended(socket.assigns.room_pid, index)
    {:noreply, socket}
  end

  def handle_event("queue:skip", _params, socket) do
    RoomServer.skip(socket.assigns.room_pid)
    {:noreply, socket}
  end

  def handle_event("queue:remove", %{"item_id" => item_id}, socket) do
    RoomServer.remove_from_queue(socket.assigns.room_pid, item_id)
    {:noreply, socket}
  end

  def handle_event("queue:play_index", %{"index" => index}, socket) do
    RoomServer.play_index(socket.assigns.room_pid, String.to_integer(index))
    {:noreply, socket}
  end

  def handle_event("switch_tab", %{"tab" => tab}, socket) do
    {:noreply, assign(socket, sidebar_tab: String.to_existing_atom(tab))}
  end

  def handle_event("sb:update", %{"category" => category, "action" => action}, socket) do
    RoomServer.update_sb_settings(socket.assigns.room_pid, category, action)
    {:noreply, socket}
  end

  def handle_event("username:edit", _params, socket) do
    {:noreply, assign(socket, editing_username: true)}
  end

  def handle_event("username:cancel", _params, socket) do
    {:noreply, assign(socket, editing_username: false)}
  end

  def handle_event("username:change", %{"username" => new_username}, socket) do
    new_username = String.trim(new_username)

    if new_username != "" and String.length(new_username) <= 30 do
      RoomServer.rename_user(socket.assigns.room_pid, socket.assigns.user_id, new_username)

      socket =
        socket
        |> assign(username: new_username, editing_username: false)
        |> push_event("store-username", %{username: new_username})

      {:noreply, socket}
    else
      {:noreply, assign(socket, editing_username: false)}
    end
  end

  def handle_event("sync:ping", %{"t1" => t1}, socket) do
    t2 = System.monotonic_time(:millisecond)
    t3 = System.monotonic_time(:millisecond)
    {:noreply, push_event(socket, "sync:pong", %{t1: t1, t2: t2, t3: t3})}
  end

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

    {:noreply, socket}
  end

  def handle_info({:sponsor_segments, data}, socket) do
    {:noreply, push_event(socket, "sponsor:segments", data)}
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

  def handle_info({:url_preview_result, nil}, socket) do
    {:noreply, assign(socket, url_preview: nil, url_preview_loading: false)}
  end

  def handle_info({:url_preview_result, nil}, socket) do
    {:noreply, assign(socket, url_preview: nil, url_preview_loading: false)}
  end

  def handle_info({:url_preview_result, meta}, socket) do
    preview = %{
      title: meta[:title],
      thumbnail_url: meta[:thumbnail_url],
      author_name: meta[:author_name],
      source_type: meta[:source_type] || :youtube
    }

    {:noreply, assign(socket, url_preview: preview, url_preview_loading: false)}
  end

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

  def handle_info(_msg, socket) do
    {:noreply, socket}
  end

  # Render

  def render(assigns) do
    ~H"""
    <%!-- Nav actions teleported to header --%>
    <div id="nav-teleport" phx-hook="TeleportToNav" class="hidden">
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
        class="btn btn-ghost btn-sm gap-1 text-base-content/60"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
        Copy Room Link
      </button>
    </div>

    <%!-- SponsorBlock settings modal --%>
    <dialog id="sb-settings-modal" class="modal">
      <div class="modal-box max-w-md">
        <h3 class="font-bold text-lg mb-1">SponsorBlock Settings</h3>
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
        <div class="modal-action">
          <form method="dialog">
            <button class="btn btn-sm">Close</button>
          </form>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>

    <div class="flex flex-col lg:flex-row gap-3 min-h-[calc(100vh-3.5rem)]">
      <%!-- Main content --%>
      <div class="flex-1 min-w-0 flex flex-col">

        <%!-- Player --%>
        <div
          id="player"
          phx-hook="VideoPlayer"
          phx-update="ignore"
          data-user-id={@user_id}
          data-current-index={@current_index}
          class="relative w-full bg-base-300 rounded-lg overflow-hidden mb-3"
          style="padding-bottom: 56.25%; height: 0; min-height: 300px;"
        >
          <div class="absolute inset-0 flex items-center justify-center text-base-content/40">
            Paste a URL below to start watching
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
            class="btn btn-primary btn-sm"
          >
            Open Player Window
          </button>
        </div>

        <%!-- URL input + preview --%>
        <form phx-submit="add_url" phx-change="preview_url" class="mb-4">
          <input
            type="text"
            name="url"
            placeholder="Paste a video URL..."
            class="input input-bordered w-full"
            autocomplete="off"
            phx-debounce="500"
          />

          <%!-- Loading placeholder --%>
          <div :if={@url_preview_loading} class="mt-2 flex items-center gap-3 p-3 rounded-lg bg-base-200 animate-pulse">
            <div class="w-20 h-12 bg-base-300 rounded flex-shrink-0" />
            <div class="flex-1 space-y-2">
              <div class="h-3 bg-base-300 rounded w-3/4" />
              <div class="h-2 bg-base-300 rounded w-1/2" />
            </div>
          </div>

          <%!-- YouTube preview with action buttons --%>
          <div
            :if={@url_preview && @url_preview.source_type == :youtube}
            class="mt-2 flex items-center gap-3 p-3 rounded-lg bg-base-200"
          >
            <img
              :if={@url_preview.thumbnail_url}
              src={@url_preview.thumbnail_url}
              class="w-20 h-12 object-cover rounded flex-shrink-0"
            />
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium truncate">{@url_preview.title}</p>
              <p :if={@url_preview.author_name} class="text-xs text-base-content/50">
                {@url_preview.author_name}
              </p>
            </div>
            <div class="flex gap-1 flex-shrink-0">
              <button type="submit" name="mode" value="now" class="btn btn-primary btn-sm">
                Play Now
              </button>
              <button type="submit" name="mode" value="queue" class="btn btn-outline btn-sm">
                Queue
              </button>
            </div>
          </div>

          <%!-- Extension-required preview with action buttons --%>
          <div
            :if={@url_preview && @url_preview.source_type == :extension_required}
            class="mt-2 flex items-center gap-3 p-3 rounded-lg bg-base-200"
          >
            <img
              :if={@url_preview.thumbnail_url}
              src={@url_preview.thumbnail_url}
              class="w-20 h-12 object-cover rounded flex-shrink-0"
            />
            <div
              :if={!@url_preview.thumbnail_url}
              class="w-20 h-12 bg-base-300 rounded flex-shrink-0 flex items-center justify-center"
            >
              <span class="text-xs text-base-content/30">EXT</span>
            </div>
            <div class="flex-1 min-w-0">
              <p :if={@url_preview.title} class="text-sm font-medium truncate">{@url_preview.title}</p>
              <p :if={!@url_preview.title} class="text-sm font-medium">External site</p>
              <%!-- Extension not installed warning (hidden by extension via data attribute) --%>
              <p class="text-xs text-warning byob-no-ext">
                <a href="https://github.com/joegoldin/byob.video" target="_blank" class="underline">
                  Extension required
                </a>
                to sync this site
              </p>
            </div>
            <div class="flex gap-1 flex-shrink-0">
              <button type="submit" name="mode" value="now" class="btn btn-primary btn-sm">
                Play Now
              </button>
              <button type="submit" name="mode" value="queue" class="btn btn-outline btn-sm">
                Queue
              </button>
            </div>
          </div>
        </form>
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
                    <span title={now_playing.url} class="block text-xs text-base-content/50 line-clamp-2">
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
                <ul class="space-y-1">
                  <li
                    :for={{item, idx} <- up_next}
                    class="flex items-center gap-2 p-2 rounded-lg text-sm hover:bg-base-300 transition-colors"
                  >
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
                      <span :if={item.title} title={item.title} class="block text-sm line-clamp-3">
                        {item.title}
                      </span>
                      <span title={item.url} class="block text-xs text-base-content/50 line-clamp-2">
                        {item.url}
                      </span>
                      <span :if={item.added_by_name} class="block text-xs text-base-content/40 mt-0.5">
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
                  <span :if={entry.item.title} title={entry.item.title} class="block text-sm line-clamp-3">
                    {entry.item.title}
                  </span>
                  <span title={entry.item.url} class="block text-xs text-base-content/50 line-clamp-2">
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

        <%!-- Users card — pinned at bottom --%>
        <div class="card bg-base-200 mt-4 mb-4 flex-shrink-0">
          <div class="card-body p-4">
            <h3 class="card-title text-sm">
              Users
              <span class="badge badge-sm">{map_size(@users)}</span>
            </h3>
            <ul class="space-y-2 mt-1 max-h-48 overflow-y-auto">
              <li
                :for={{uid, user} <- @users}
                data-user-id={uid}
                class="flex items-center gap-2 text-sm"
              >
                <div class={"w-2 h-2 rounded-full flex-shrink-0 #{if user.connected, do: "bg-success", else: "bg-base-content/20"}"}  />
                <%!-- Other users: just show name --%>
                <span :if={uid != @user_id} class="truncate">{user.username}</span>
                <%!-- Self: show name + edit, or edit form --%>
                <span
                  :if={uid == @user_id && !@editing_username}
                  class="truncate flex-1"
                >
                  {user.username}
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

  defp extension_open_url(url, room_id) do
    # Append watchparty params to the URL so the content script can detect it
    uri = URI.parse(url)
    params = URI.decode_query(uri.query || "")
    server_url = ByobWeb.Endpoint.url()

    params =
      Map.merge(params, %{
        "watchparty_room" => room_id,
        "watchparty_server" => server_url
      })

    %{uri | query: URI.encode_query(params)} |> URI.to_string()
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
