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
        current_index: nil,
        play_state: :paused,
        current_media: nil
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

    {:noreply,
     assign(socket,
       queue: queue,
       current_index: current_index,
       current_media: current_media
     )}
  end

  def handle_info({:video_changed, data}, socket) do
    socket =
      assign(socket,
        current_media: data.media_item,
        current_index: data.index,
        play_state: :playing
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
    <div class="flex gap-4">
      <div class="flex-1">
        <div class="mb-4 flex items-center gap-2">
          <span class="font-mono text-sm text-gray-500">Room: {@room_id}</span>
          <button
            id="copy-url"
            phx-hook="CopyUrl"
            data-url={url(~p"/room/#{@room_id}")}
            class="btn btn-xs btn-ghost"
          >
            Copy Link
          </button>
        </div>

        <div
          id="player"
          phx-hook="VideoPlayer"
          phx-update="ignore"
          data-user-id={@user_id}
          data-current-index={@current_index}
          class="aspect-video bg-black rounded mb-4"
        >
          <div class="flex items-center justify-center h-full text-gray-500">
            No video playing
          </div>
        </div>

        <div
          :if={@current_media && @current_media.source_type == :extension_required}
          class="mb-4 p-4 rounded bg-base-200"
        >
          <p class="text-sm mb-2">
            This video requires the WatchParty browser extension to sync.
          </p>
          <a
            href={extension_open_url(@current_media.url, @room_id)}
            target="_blank"
            class="btn btn-primary btn-sm"
          >
            Open in New Tab
          </a>
          <p class="text-xs text-gray-500 mt-2">
            Click play on the video for the extension to hook it.
          </p>
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

        <div :if={@current_media} class="mb-4">
          <button phx-click="queue:skip" class="btn btn-sm btn-outline">Skip</button>
        </div>

        <div :if={@queue != []} class="mb-4">
          <h3 class="font-bold mb-2">Queue</h3>
          <ul class="space-y-2">
            <li
              :for={{item, idx} <- Enum.with_index(@queue)}
              class={"flex items-center gap-2 p-2 rounded text-sm #{if idx == @current_index, do: "bg-primary/10 font-bold", else: ""}"}
            >
              <img
                :if={item.thumbnail_url}
                src={item.thumbnail_url}
                class="w-16 h-10 object-cover rounded flex-shrink-0"
              />
              <div :if={!item.thumbnail_url} class="w-16 h-10 bg-base-300 rounded flex-shrink-0" />
              <button
                phx-click="queue:play_index"
                phx-value-index={idx}
                class="flex-1 text-left truncate"
              >
                <span :if={item.title} class="block truncate">{item.title}</span>
                <span class="block truncate text-xs text-gray-500">{item.url}</span>
              </button>
              <button
                phx-click="queue:remove"
                phx-value-item_id={item.id}
                class="btn btn-xs btn-ghost"
              >
                x
              </button>
            </li>
          </ul>
        </div>
      </div>

      <div class="w-64">
        <h3 class="font-bold mb-2">
          Users ({map_size(@users)})
        </h3>
        <ul class="space-y-1">
          <li :for={{uid, user} <- @users} data-user-id={uid} class="text-sm flex items-center gap-1">
            <span :if={uid != @user_id}>{user.username}</span>
            <form :if={uid == @user_id} phx-submit="username:change" class="flex gap-1">
              <input
                type="text"
                name="username"
                value={user.username}
                class="input input-xs input-bordered w-28"
              />
              <button type="submit" class="btn btn-xs btn-ghost">ok</button>
            </form>
          </li>
        </ul>
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
