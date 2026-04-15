defmodule ByobWeb.ApiController do
  use ByobWeb, :controller

  alias Byob.{RoomManager, RoomServer}

  # --- Public (no auth) ---

  def create_room(conn, _params) do
    case RoomManager.create_room() do
      {:ok, room_id, api_key} ->
        url = ByobWeb.Endpoint.url() <> "/room/#{room_id}"

        conn
        |> put_status(201)
        |> json(%{ok: true, data: %{room_id: room_id, url: url, api_key: api_key}})

      {:error, :max_capacity} ->
        conn
        |> put_status(503)
        |> json(%{error: "Server is at maximum capacity. Please try again later."})
    end
  end

  # --- Authenticated (room context in assigns) ---

  def show_room(conn, _params) do
    state = RoomServer.get_state(conn.assigns.room_pid)

    json(conn, %{
      ok: true,
      data: %{
        room_id: state.room_id,
        play_state: state.play_state,
        current_time: state.current_time,
        current_index: state.current_index,
        queue_length: length(state.queue),
        user_count: map_size(state.users)
      }
    })
  end

  def show_queue(conn, _params) do
    state = RoomServer.get_state(conn.assigns.room_pid)

    queue =
      Enum.map(state.queue, fn item ->
        %{
          id: item.id,
          url: item.url,
          title: item.title,
          source_type: item.source_type,
          added_by: item.added_by_name,
          thumbnail_url: item.thumbnail_url
        }
      end)

    json(conn, %{
      ok: true,
      data: %{queue: queue, current_index: state.current_index}
    })
  end

  def add_to_queue(conn, %{"url" => url} = params) do
    pid = conn.assigns.room_pid
    user_id = ensure_api_user(conn, pid)
    mode = if params["play_now"], do: :now, else: :queue

    case RoomServer.add_to_queue(pid, user_id, url, mode) do
      :ok ->
        json(conn, %{ok: true, data: %{message: "Added to queue."}})

      {:error, reason} ->
        conn
        |> put_status(422)
        |> json(%{error: "Failed to add to queue: #{reason}"})
    end
  end

  def remove_from_queue(conn, %{"item_id" => item_id}) do
    case RoomServer.remove_from_queue(conn.assigns.room_pid, item_id) do
      :ok -> json(conn, %{ok: true, data: %{message: "Removed from queue."}})
    end
  end

  def reorder_queue(conn, %{"from" => from, "to" => to}) do
    case RoomServer.reorder_queue(conn.assigns.room_pid, from, to) do
      :ok -> json(conn, %{ok: true, data: %{message: "Queue reordered."}})
    end
  end

  def skip(conn, _params) do
    case RoomServer.skip(conn.assigns.room_pid) do
      :ok -> json(conn, %{ok: true, data: %{message: "Skipped to next item."}})
    end
  end

  def play(conn, %{"position" => pos}) do
    pid = conn.assigns.room_pid
    user_id = ensure_api_user(conn, pid)

    case RoomServer.play(pid, user_id, pos / 1) do
      :ok ->
        json(conn, %{ok: true, data: %{message: "Playing."}})

      {:error, :rate_limited} ->
        conn |> put_status(429) |> json(%{error: "Rate limited. Slow down."})
    end
  end

  def pause(conn, %{"position" => pos}) do
    pid = conn.assigns.room_pid
    user_id = ensure_api_user(conn, pid)

    case RoomServer.pause(pid, user_id, pos / 1) do
      :ok ->
        json(conn, %{ok: true, data: %{message: "Paused."}})

      {:error, :rate_limited} ->
        conn |> put_status(429) |> json(%{error: "Rate limited. Slow down."})
    end
  end

  def list_users(conn, _params) do
    state = RoomServer.get_state(conn.assigns.room_pid)

    users =
      Enum.map(state.users, fn {id, user} ->
        %{id: id, username: user.username, connected: user.connected}
      end)

    json(conn, %{ok: true, data: %{users: users}})
  end

  def change_username(conn, %{"username" => username}) do
    pid = conn.assigns.room_pid
    user_id = ensure_api_user(conn, pid)
    RoomServer.rename_user(pid, user_id, username)
    json(conn, %{ok: true, data: %{message: "Username updated.", username: username}})
  end

  # --- Docs ---

  def docs(conn, _params) do
    base_url = ByobWeb.Endpoint.url()

    html(conn, docs_html(base_url))
  end

  # --- Helpers ---

  defp api_user_id(conn) do
    "api:" <> String.slice(conn.assigns.api_key, 0, 8)
  end

  defp ensure_api_user(conn, pid) do
    user_id = api_user_id(conn)
    state = RoomServer.get_state(pid)

    unless Map.has_key?(state.users, user_id) do
      RoomServer.join(pid, user_id, user_id)
    end

    user_id
  end

  defp docs_html(base_url) do
    """
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>byob.video API Documentation</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4e8; line-height: 1.6; }
        .container { max-width: 900px; margin: 0 auto; padding: 2rem; }
        h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #fff; }
        h2 { font-size: 1.4rem; margin: 2rem 0 1rem; color: #79c0ff; border-bottom: 1px solid #30363d; padding-bottom: 0.5rem; }
        .subtitle { color: #8b949e; margin-bottom: 2rem; }
        .endpoint { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1.2rem; margin-bottom: 1rem; }
        .endpoint-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
        .method { font-weight: 700; font-size: 0.8rem; padding: 2px 8px; border-radius: 4px; font-family: monospace; }
        .method-get { background: #1f6feb33; color: #58a6ff; }
        .method-post { background: #23863633; color: #3fb950; }
        .method-put { background: #9e6a0333; color: #d29922; }
        .method-delete { background: #f8514933; color: #f85149; }
        .path { font-family: monospace; font-size: 0.95rem; color: #fff; }
        .desc { color: #8b949e; font-size: 0.9rem; margin-bottom: 0.75rem; }
        .auth-badge { font-size: 0.75rem; padding: 1px 6px; border-radius: 3px; }
        .auth-required { background: #9e6a0333; color: #d29922; }
        .auth-none { background: #23863633; color: #3fb950; }
        pre { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 1rem; overflow-x: auto; font-size: 0.85rem; margin-top: 0.5rem; color: #c9d1d9; }
        code { font-family: 'SF Mono', Consolas, monospace; }
        .note { background: #1f6feb22; border-left: 3px solid #1f6feb; padding: 0.75rem 1rem; border-radius: 0 6px 6px 0; margin: 1rem 0; font-size: 0.9rem; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>byob.video REST API</h1>
        <p class="subtitle">Control watch party rooms programmatically.</p>

        <div class="note">
          <strong>Authentication:</strong> Create a room to get an API key. Pass it as <code>Authorization: Bearer &lt;api_key&gt;</code> header or <code>?api_key=&lt;key&gt;</code> query param for authenticated endpoints.
        </div>

        <h2>Room Management</h2>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="method method-post">POST</span>
            <span class="path">/api/rooms</span>
            <span class="auth-badge auth-none">No auth</span>
          </div>
          <div class="desc">Create a new room. Returns room ID, URL, and API key.</div>
          <pre><code>curl -X POST #{base_url}/api/rooms</code></pre>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="method method-get">GET</span>
            <span class="path">/api/rooms/:id</span>
            <span class="auth-badge auth-required">Auth required</span>
          </div>
          <div class="desc">Get room info: play state, current time, queue length, user count.</div>
          <pre><code>curl #{base_url}/api/rooms/ROOM_ID -H "Authorization: Bearer API_KEY"</code></pre>
        </div>

        <h2>Queue</h2>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="method method-get">GET</span>
            <span class="path">/api/rooms/:id/queue</span>
            <span class="auth-badge auth-required">Auth required</span>
          </div>
          <div class="desc">Get the full queue and current playing index.</div>
          <pre><code>curl #{base_url}/api/rooms/ROOM_ID/queue -H "Authorization: Bearer API_KEY"</code></pre>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="method method-post">POST</span>
            <span class="path">/api/rooms/:id/queue</span>
            <span class="auth-badge auth-required">Auth required</span>
          </div>
          <div class="desc">Add a URL to the queue. Pass <code>play_now: true</code> to play immediately.</div>
          <pre><code>curl -X POST #{base_url}/api/rooms/ROOM_ID/queue \\
      -H "Authorization: Bearer API_KEY" \\
      -H "Content-Type: application/json" \\
      -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'</code></pre>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="method method-delete">DELETE</span>
            <span class="path">/api/rooms/:id/queue/:item_id</span>
            <span class="auth-badge auth-required">Auth required</span>
          </div>
          <div class="desc">Remove an item from the queue by its item ID.</div>
          <pre><code>curl -X DELETE #{base_url}/api/rooms/ROOM_ID/queue/ITEM_ID \\
      -H "Authorization: Bearer API_KEY"</code></pre>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="method method-put">PUT</span>
            <span class="path">/api/rooms/:id/queue/reorder</span>
            <span class="auth-badge auth-required">Auth required</span>
          </div>
          <div class="desc">Reorder the queue. Move item at index <code>from</code> to index <code>to</code>.</div>
          <pre><code>curl -X PUT #{base_url}/api/rooms/ROOM_ID/queue/reorder \\
      -H "Authorization: Bearer API_KEY" \\
      -H "Content-Type: application/json" \\
      -d '{"from": 0, "to": 2}'</code></pre>
        </div>

        <h2>Playback</h2>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="method method-post">POST</span>
            <span class="path">/api/rooms/:id/skip</span>
            <span class="auth-badge auth-required">Auth required</span>
          </div>
          <div class="desc">Skip to the next item in the queue.</div>
          <pre><code>curl -X POST #{base_url}/api/rooms/ROOM_ID/skip -H "Authorization: Bearer API_KEY"</code></pre>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="method method-post">POST</span>
            <span class="path">/api/rooms/:id/play</span>
            <span class="auth-badge auth-required">Auth required</span>
          </div>
          <div class="desc">Resume playback at a given position (seconds).</div>
          <pre><code>curl -X POST #{base_url}/api/rooms/ROOM_ID/play \\
      -H "Authorization: Bearer API_KEY" \\
      -H "Content-Type: application/json" \\
      -d '{"position": 30.5}'</code></pre>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="method method-post">POST</span>
            <span class="path">/api/rooms/:id/pause</span>
            <span class="auth-badge auth-required">Auth required</span>
          </div>
          <div class="desc">Pause playback at a given position (seconds).</div>
          <pre><code>curl -X POST #{base_url}/api/rooms/ROOM_ID/pause \\
      -H "Authorization: Bearer API_KEY" \\
      -H "Content-Type: application/json" \\
      -d '{"position": 30.5}'</code></pre>
        </div>

        <h2>Users</h2>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="method method-get">GET</span>
            <span class="path">/api/rooms/:id/users</span>
            <span class="auth-badge auth-required">Auth required</span>
          </div>
          <div class="desc">List all users in the room.</div>
          <pre><code>curl #{base_url}/api/rooms/ROOM_ID/users -H "Authorization: Bearer API_KEY"</code></pre>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="method method-put">PUT</span>
            <span class="path">/api/rooms/:id/username</span>
            <span class="auth-badge auth-required">Auth required</span>
          </div>
          <div class="desc">Change the API user's display name in the room.</div>
          <pre><code>curl -X PUT #{base_url}/api/rooms/ROOM_ID/username \\
      -H "Authorization: Bearer API_KEY" \\
      -H "Content-Type: application/json" \\
      -d '{"username": "DJ Bot"}'</code></pre>
        </div>
      </div>
    </body>
    </html>
    """
  end
end
