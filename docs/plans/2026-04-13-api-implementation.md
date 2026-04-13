# byob REST API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a JSON REST API for programmatic room management, with rate limiting and self-documenting endpoint page.

**Architecture:** New Phoenix controller (`ApiController`) wrapping existing `RoomServer` calls. ETS-based rate limiter plug. API key stored in RoomServer state and persisted. Settings modal shows the key.

**Tech Stack:** Phoenix controllers, Plug, ETS, existing RoomServer/RoomManager.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `lib/byob_web/plugs/api_auth.ex` | NEW — Extract API key from header/query, look up room, set assigns |
| `lib/byob_web/plugs/rate_limit.ex` | NEW — ETS sliding window rate limiter |
| `lib/byob_web/controllers/api_controller.ex` | NEW — All API endpoint handlers |
| `lib/byob_web/controllers/api_docs_html.ex` | NEW — Self-documenting HTML page |
| `lib/byob_web/router.ex` | MODIFY — Add API pipeline and routes |
| `lib/byob/room_server.ex` | MODIFY — Add `api_key` to state, `get_api_key/1` |
| `lib/byob/room_manager.ex` | MODIFY — Return api_key from `create_room/0` |
| `lib/byob_web/live/room_live.ex` | MODIFY — Show API key in settings modal |

---

## Task 1: Add `api_key` to RoomServer state

- [ ] In `lib/byob/room_server.ex`, add `api_key: nil` to the `defstruct`
- [ ] In `init/1`, generate the key: `api_key = :crypto.strong_rand_bytes(24) |> Base.url_encode64(padding: false)`
- [ ] Set it on the state: `%{state | api_key: api_key}` (only if `api_key` is nil — restored rooms keep their key)
- [ ] Add public function `def get_api_key(pid), do: GenServer.call(pid, :get_api_key)`
- [ ] Add handler: `def handle_call(:get_api_key, _from, state), do: {:reply, state.api_key, state}`
- [ ] Verify: `mix compile` passes
- [ ] Commit: "add api_key to RoomServer state"

## Task 2: Return api_key from RoomManager

- [ ] In `lib/byob/room_manager.ex`, change `create_room/0` to return `{:ok, room_id, api_key}`:
  ```elixir
  def create_room do
    # ... existing max_rooms check ...
    room_id = Nanoid.generate(8, @alphabet)
    {:ok, pid} = ensure_room(room_id)
    api_key = RoomServer.get_api_key(pid)
    {:ok, room_id, api_key}
  end
  ```
- [ ] Update `lib/byob_web/live/home_live.ex` to match new return: `{:ok, room_id, _api_key} ->`
- [ ] Verify: `mix compile` passes
- [ ] Commit: "return api_key from create_room"

## Task 3: Rate limiter plug

- [ ] Create `lib/byob_web/plugs/rate_limit.ex`:
  ```elixir
  defmodule ByobWeb.RateLimit do
    import Plug.Conn

    def init(opts), do: opts

    def call(conn, opts) do
      key = build_key(conn, opts)
      limit = Keyword.fetch!(opts, :limit)
      window = Keyword.get(opts, :window, 60)

      case check_rate(key, limit, window) do
        :ok -> conn
        {:error, retry_after} ->
          conn
          |> put_resp_header("retry-after", to_string(retry_after))
          |> put_resp_content_type("application/json")
          |> send_resp(429, Jason.encode!(%{error: "rate limit exceeded", retry_after: retry_after}))
          |> halt()
      end
    end

    defp build_key(conn, opts) do
      case Keyword.get(opts, :by, :ip) do
        :ip -> "rl:ip:#{:inet.ntoa(conn.remote_ip)}"
        :api_key -> "rl:key:#{conn.assigns[:api_key] || :inet.ntoa(conn.remote_ip)}"
      end
    end

    defp check_rate(key, limit, window) do
      now = System.monotonic_time(:second)
      table = ensure_table()

      case :ets.lookup(table, key) do
        [{^key, count, start}] when now - start < window ->
          if count >= limit do
            {:error, window - (now - start)}
          else
            :ets.update_counter(table, key, {2, 1})
            :ok
          end
        _ ->
          :ets.insert(table, {key, 1, now})
          :ok
      end
    end

    defp ensure_table do
      case :ets.whereis(:byob_rate_limit) do
        :undefined -> :ets.new(:byob_rate_limit, [:public, :named_table])
        tid -> tid
      end
    end
  end
  ```
- [ ] Verify: `mix compile` passes
- [ ] Commit: "add ETS-based rate limit plug"

## Task 4: API auth plug

- [ ] Create `lib/byob_web/plugs/api_auth.ex`:
  ```elixir
  defmodule ByobWeb.ApiAuth do
    import Plug.Conn
    alias Byob.{RoomManager, RoomServer}

    def init(opts), do: opts

    def call(conn, _opts) do
      room_id = conn.path_params["id"] || conn.params["id"]
      token = extract_token(conn)

      with true <- is_binary(room_id),
           true <- is_binary(token),
           {:ok, pid} <- RoomManager.ensure_room(room_id),
           api_key when api_key == token <- RoomServer.get_api_key(pid) do
        conn
        |> assign(:room_id, room_id)
        |> assign(:room_pid, pid)
        |> assign(:api_key, token)
      else
        _ ->
          conn
          |> put_resp_content_type("application/json")
          |> send_resp(401, Jason.encode!(%{error: "unauthorized"}))
          |> halt()
      end
    end

    defp extract_token(conn) do
      case get_req_header(conn, "authorization") do
        ["Bearer " <> token] -> token
        _ -> conn.params["api_key"]
      end
    end
  end
  ```
- [ ] Verify: `mix compile` passes
- [ ] Commit: "add API auth plug"

## Task 5: API controller

- [ ] Create `lib/byob_web/controllers/api_controller.ex`:
  ```elixir
  defmodule ByobWeb.ApiController do
    use ByobWeb, :controller
    alias Byob.{RoomManager, RoomServer}

    # POST /api/rooms (no auth)
    def create_room(conn, _params) do
      case RoomManager.create_room() do
        {:ok, room_id, api_key} ->
          url = ByobWeb.Endpoint.url() <> "/room/" <> room_id
          conn |> put_status(201) |> json(%{ok: true, data: %{room_id: room_id, url: url, api_key: api_key}})
        {:error, :max_capacity} ->
          conn |> put_status(503) |> json(%{error: "server at max capacity"})
      end
    end

    # GET /api/rooms/:id
    def show_room(conn, _params) do
      state = RoomServer.get_state(conn.assigns.room_pid)
      current = if state.current_index, do: Enum.at(state.queue, state.current_index)
      json(conn, %{ok: true, data: %{
        room_id: conn.assigns.room_id,
        play_state: state.play_state,
        current_time: state.current_time,
        current_video: current && serialize_item(current),
        user_count: map_size(state.users),
        queue_length: length(state.queue)
      }})
    end

    # GET /api/rooms/:id/queue
    def show_queue(conn, _params) do
      state = RoomServer.get_state(conn.assigns.room_pid)
      json(conn, %{ok: true, data: %{
        queue: Enum.map(state.queue, &serialize_item/1),
        current_index: state.current_index
      }})
    end

    # POST /api/rooms/:id/queue
    def add_to_queue(conn, %{"url" => url} = params) do
      mode = if params["mode"] == "now", do: :now, else: :queue
      api_user_id = api_user_id(conn)
      ensure_api_user(conn.assigns.room_pid, api_user_id)
      case RoomServer.add_to_queue(conn.assigns.room_pid, api_user_id, url, mode) do
        :ok -> json(conn, %{ok: true})
        {:error, reason} -> conn |> put_status(400) |> json(%{error: to_string(reason)})
      end
    end

    # DELETE /api/rooms/:id/queue/:item_id
    def remove_from_queue(conn, %{"item_id" => item_id}) do
      RoomServer.remove_from_queue(conn.assigns.room_pid, item_id)
      json(conn, %{ok: true})
    end

    # PUT /api/rooms/:id/queue/reorder
    def reorder_queue(conn, %{"from" => from, "to" => to}) do
      RoomServer.reorder_queue(conn.assigns.room_pid, from, to)
      json(conn, %{ok: true})
    end

    # POST /api/rooms/:id/skip
    def skip(conn, _params) do
      RoomServer.skip(conn.assigns.room_pid)
      json(conn, %{ok: true})
    end

    # POST /api/rooms/:id/play
    def play(conn, %{"position" => pos}) do
      api_user_id = api_user_id(conn)
      ensure_api_user(conn.assigns.room_pid, api_user_id)
      RoomServer.play(conn.assigns.room_pid, api_user_id, pos)
      json(conn, %{ok: true})
    end

    # POST /api/rooms/:id/pause
    def pause(conn, %{"position" => pos}) do
      api_user_id = api_user_id(conn)
      ensure_api_user(conn.assigns.room_pid, api_user_id)
      RoomServer.pause(conn.assigns.room_pid, api_user_id, pos)
      json(conn, %{ok: true})
    end

    # GET /api/rooms/:id/users
    def list_users(conn, _params) do
      state = RoomServer.get_state(conn.assigns.room_pid)
      users = Enum.map(state.users, fn {id, u} ->
        %{id: id, username: u.username, connected: u.connected}
      end)
      json(conn, %{ok: true, data: %{users: users}})
    end

    # PUT /api/rooms/:id/username
    def change_username(conn, %{"username" => username}) do
      api_user_id = api_user_id(conn)
      ensure_api_user(conn.assigns.room_pid, api_user_id)
      RoomServer.rename_user(conn.assigns.room_pid, api_user_id, String.slice(username, 0, 30))
      json(conn, %{ok: true})
    end

    defp api_user_id(conn), do: "api:#{String.slice(conn.assigns.api_key, 0, 8)}"

    defp ensure_api_user(pid, user_id) do
      state = RoomServer.get_state(pid)
      unless Map.has_key?(state.users, user_id) do
        RoomServer.join(pid, user_id, "API")
      end
    end

    defp serialize_item(item) do
      %{
        id: item.id,
        url: item.url,
        title: item.title,
        source_type: to_string(item.source_type),
        thumbnail_url: item.thumbnail_url
      }
    end
  end
  ```
- [ ] Verify: `mix compile` passes
- [ ] Commit: "add API controller with all endpoints"

## Task 6: Self-documenting `/api` page

- [ ] Create `lib/byob_web/controllers/api_docs_html.ex` with an `index` function that returns an HTML string documenting all endpoints with curl examples
- [ ] Add `def docs(conn, _params)` to ApiController that renders this HTML
- [ ] Verify: `mix compile` passes
- [ ] Commit: "add self-documenting /api page"

## Task 7: Router

- [ ] In `lib/byob_web/router.ex`, add:
  ```elixir
  pipeline :api do
    plug :accepts, ["json"]
  end

  # API docs (no auth, rate limited by IP)
  scope "/api", ByobWeb do
    pipe_through [:api]
    get "/", ApiController, :docs
    post "/rooms", ApiController, :create_room
  end

  # Authed API endpoints
  scope "/api", ByobWeb do
    pipe_through [:api, ByobWeb.ApiAuth]

    get "/rooms/:id", ApiController, :show_room
    get "/rooms/:id/queue", ApiController, :show_queue
    post "/rooms/:id/queue", ApiController, :add_to_queue
    delete "/rooms/:id/queue/:item_id", ApiController, :remove_from_queue
    put "/rooms/:id/queue/reorder", ApiController, :reorder_queue
    post "/rooms/:id/skip", ApiController, :skip
    post "/rooms/:id/play", ApiController, :play
    post "/rooms/:id/pause", ApiController, :pause
    get "/rooms/:id/users", ApiController, :list_users
    put "/rooms/:id/username", ApiController, :change_username
  end
  ```
- [ ] Add rate limiting plugs to the appropriate scopes
- [ ] Remove the existing commented-out API scope if present
- [ ] Verify: `mix compile` passes
- [ ] Commit: "add API routes"

## Task 8: Show API key in settings modal

- [ ] In `lib/byob_web/live/room_live.ex`, add `api_key: nil` to mount assigns
- [ ] On connected mount, fetch the key: `api_key = RoomServer.get_api_key(pid)` and assign it
- [ ] In the settings modal template, add a section between the About and SponsorBlock sections:
  ```heex
  <div class="mb-4 pb-4 border-b border-base-300">
    <h4 class="font-semibold text-sm mb-2">Room API Key</h4>
    <div class="flex items-center gap-2">
      <code class="text-xs bg-base-100 px-2 py-1 rounded flex-1 truncate">{@api_key}</code>
      <button onclick={"navigator.clipboard.writeText('#{@api_key}')"} class="btn btn-xs btn-ghost">Copy</button>
    </div>
    <a href="/api" target="_blank" class="text-xs link link-primary mt-1 block">API Documentation</a>
  </div>
  ```
- [ ] Verify: page loads, settings modal shows the key
- [ ] Commit: "show API key in settings modal"

## Task 9: Integration test

- [ ] Test the full flow manually:
  - `curl -X POST http://localhost:4000/api/rooms` → get room_id + api_key
  - `curl -H "Authorization: Bearer <key>" http://localhost:4000/api/rooms/<id>` → room info
  - `curl -X POST -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"url":"https://youtube.com/watch?v=dQw4w9WgXcQ","mode":"now"}' http://localhost:4000/api/rooms/<id>/queue` → add to queue
  - `curl -H "Authorization: Bearer <key>" http://localhost:4000/api/rooms/<id>/queue` → see queue
  - `curl -H "Authorization: Bearer <key>" http://localhost:4000/api/rooms/<id>/users` → see API user
  - Test rate limiting: rapid-fire requests until 429
  - Open `/api` in browser → see docs page
- [ ] Commit: "v1.1.0: REST API with rate limiting"

## Task 10: Version bump and tag

- [ ] `echo "1.1.0" > VERSION && just sync-version`
- [ ] Update CHANGELOG.md with v1.1.0 entry
- [ ] `git add -A && git commit && git tag v1.1.0`
