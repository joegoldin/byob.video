defmodule WatchPartyWeb.RoomLive do
  use WatchPartyWeb, :live_view

  alias WatchParty.{RoomManager, RoomServer}

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
        sidebar_tab: :queue
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
      Phoenix.PubSub.subscribe(WatchParty.PubSub, "room:#{room_id}")
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
      {:ok, push_event(socket, "sync:state", sync_state_payload(state))}
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

  def handle_event("add_url", %{"url" => url, "mode" => mode}, socket) do
    mode_atom = if mode == "now", do: :now, else: :queue
    RoomServer.add_to_queue(socket.assigns.room_pid, socket.assigns.user_id, url, mode_atom)
    {:noreply, socket}
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

        <%!-- URL input --%>
        <form phx-submit="add_url" class="flex gap-2 mb-4">
          <input
            type="text"
            name="url"
            placeholder="Paste a video URL..."
            class="input input-bordered flex-1"
            autocomplete="off"
          />
          <button type="submit" name="mode" value="now" class="btn btn-primary">
            Play Now
          </button>
          <button type="submit" name="mode" value="queue" class="btn btn-outline">
            Queue
          </button>
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
                  <span :if={@queue != []} class="badge badge-xs ml-1">{length(@queue)}</span>
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
            <ul
              :if={@sidebar_tab == :queue && @queue != []}
              class="space-y-2 overflow-y-auto flex-1"
            >
              <li
                :for={{item, idx} <- Enum.with_index(@queue)}
                class={"flex items-center gap-2 p-2 rounded-lg text-sm transition-colors #{if idx == @current_index, do: "bg-primary/10 ring-1 ring-primary/20", else: "hover:bg-base-300"}"}
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
                class="flex items-center gap-2 p-2 rounded-lg text-sm hover:bg-base-300 transition-colors"
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
        <div class="card bg-base-200 mt-4 flex-shrink-0">
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
    server_url = WatchPartyWeb.Endpoint.url()

    params =
      Map.merge(params, %{
        "watchparty_room" => room_id,
        "watchparty_server" => server_url
      })

    %{uri | query: URI.encode_query(params)} |> URI.to_string()
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

  defp serialize_media_item(%{media_item: item, index: index}) do
    %{media_item: serialize_item(item), index: index}
  end

  defp serialize_item(%WatchParty.MediaItem{} = item) do
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
