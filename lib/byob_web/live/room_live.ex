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
        sidebar_tab: :queue,
        url_preview: nil,
        url_preview_loading: false
      )

    if connected?(socket) do
      # Use a per-connection ID so each tab is a separate user.
      # In prod, you'd use the session user_id for single-session-per-user.
      user_id = socket.assigns.user_id <> ":" <> socket.id
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
          current_media: current_media
        )

      # Push full state to client hook for two-step join
      socket = push_event(socket, "sync:state", sync_state_payload(state, user_id))

      # Push sponsor segments if available
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
          preview = %{title: nil, thumbnail_url: nil, source_type: :extension_required, url: url}
          {:noreply, assign(socket, url_preview: preview, url_preview_loading: false)}

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

  def handle_event("username:change", %{"username" => new_username}, socket) do
    new_username = String.trim(new_username)

    if new_username != "" and String.length(new_username) <= 30 do
      RoomServer.rename_user(socket.assigns.room_pid, socket.assigns.user_id, new_username)

      socket =
        socket
        |> assign(username: new_username)
        |> push_event("store-username", %{username: new_username})

      {:noreply, socket}
    else
      {:noreply, socket}
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

    {:noreply,
     assign(socket,
       queue: queue,
       current_index: current_index,
       current_media: current_media,
       history: history
     )}
  end

  def handle_info({:sponsor_segments, data}, socket) do
    {:noreply, push_event(socket, "sponsor:segments", data)}
  end

  def handle_info({:video_changed, data}, socket) do
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

  def handle_info({:url_preview_result, meta}, socket) do
    preview = %{
      title: meta.title,
      thumbnail_url: meta.thumbnail_url,
      author_name: meta[:author_name],
      source_type: :youtube
    }

    {:noreply, assign(socket, url_preview: preview, url_preview_loading: false)}
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
    <div class="flex flex-col lg:flex-row gap-4">
      <%!-- Main content --%>
      <div class="flex-1 min-w-0">
        <%!-- Room header --%>
        <div class="mb-3 flex items-center gap-2">
          <div class="badge badge-neutral font-mono">{@room_id}</div>
          <button
            id="copy-url"
            phx-hook="CopyUrl"
            data-url={url(~p"/room/#{@room_id}")}
            class="btn btn-xs btn-ghost"
          >
            Copy Link
          </button>
        </div>

        <%!-- Player --%>
        <div
          id="player"
          phx-hook="VideoPlayer"
          phx-update="ignore"
          data-user-id={@user_id}
          data-current-index={@current_index}
          class="aspect-video bg-base-300 rounded-lg overflow-hidden mb-3"
        >
          <div class="flex items-center justify-center h-full text-base-content/40">
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
          <a
            href={extension_open_url(@current_media.url, @room_id)}
            target="_blank"
            class="btn btn-primary btn-sm"
          >
            Open in New Tab
          </a>
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
            <div class="w-20 h-12 bg-base-300 rounded flex-shrink-0 flex items-center justify-center">
              <span class="text-xs text-base-content/30">EXT</span>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium">External site</p>
              <p class="text-xs text-base-content/50">Requires extension to sync</p>
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
      <div class="lg:w-72 flex flex-col lg:h-[calc(100vh-5rem)]">
        <%!-- Queue/History card — fills available space --%>
        <div class="card bg-base-200 flex-1 min-h-0">
          <div class="card-body p-4 flex flex-col">
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
              <button
                :if={@current_media && @sidebar_tab == :queue}
                phx-click="queue:skip"
                class="btn btn-xs btn-ghost"
              >
                Skip
              </button>
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
                    <span :if={now_playing.title} class="block truncate text-sm font-medium">
                      {now_playing.title}
                    </span>
                    <span class="block truncate text-xs text-base-content/50">
                      {now_playing.url}
                    </span>
                  </div>
                  <button
                    phx-click="queue:remove"
                    phx-value-item_id={now_playing.id}
                    class="btn btn-xs btn-ghost btn-circle opacity-50 hover:opacity-100"
                  >
                    x
                  </button>
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
                      <span :if={item.title} class="block truncate text-sm">{item.title}</span>
                      <span class="block truncate text-xs text-base-content/50">{item.url}</span>
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
                  <span :if={entry.item.title} class="block truncate text-sm">
                    {entry.item.title}
                  </span>
                  <span class="block truncate text-xs text-base-content/50">
                    {entry.item.url}
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
            <ul class="space-y-2 mt-1">
              <li
                :for={{uid, user} <- @users}
                data-user-id={uid}
                class="flex items-center gap-2 text-sm"
              >
                <div class="w-2 h-2 rounded-full bg-success flex-shrink-0" />
                <span :if={uid != @user_id} class="truncate">{user.username}</span>
                <form
                  :if={uid == @user_id}
                  phx-submit="username:change"
                  class="flex gap-1 flex-1 min-w-0"
                >
                  <input
                    type="text"
                    name="username"
                    value={user.username}
                    class="input input-xs input-bordered flex-1 min-w-0"
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
      title: item.title
    }
  end

  defp serialize_item(item) when is_map(item) do
    %{
      id: item[:id] || item["id"],
      url: item[:url] || item["url"],
      source_type: to_string(item[:source_type] || item["source_type"]),
      source_id: item[:source_id] || item["source_id"],
      title: item[:title] || item["title"]
    }
  end
end
