# WatchParty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a another sync extension clone — ephemeral rooms with YouTube embedded sync and browser-extension sync for other sites.

**Architecture:** Phoenix 1.8.5 LiveView app, GenServer-per-room via DynamicSupervisor+Registry, sync over LiveView push_event, Chrome MV3 extension with dedicated Phoenix Channel for non-YouTube sites. No database.

**Tech Stack:** Elixir 1.18 / Phoenix 1.8.5 / LiveView 1.1 / esbuild / Tailwind+DaisyUI / Chrome MV3 extension

---

## File Structure

### Elixir (server)

```
lib/
  watch_party/
    application.ex              # supervision tree (PubSub, Registry, DynamicSupervisor, Endpoint)
    room_server.ex              # GenServer per room — canonical state, sync logic
    room_manager.ex             # ensure_room/1, create_room/0 — find-or-create via Registry
    media_item.ex               # struct + URL parser (youtube detection, source_type)
    username_generator.ex       # random human-readable username generation
  watch_party_web/
    endpoint.ex                 # (modified) add ExtensionSocket
    router.ex                   # (modified) routes for HomeLive, RoomLive
    channels/
      extension_socket.ex       # Phoenix.Socket for extension WebSocket connections
      extension_channel.ex      # Channel for extension:room_id — PubSub bridge to RoomServer
    plugs/
      session_identity.ex       # Plug that ensures user_id + username in session
    live/
      home_live.ex              # landing page, "Create Room" button
      room_live.ex              # room page — player, queue, user list, URL input
    components/
      core_components.ex        # (scaffold, modified as needed)
      layouts.ex                # (scaffold)
      layouts/root.html.heex    # (scaffold, modified — add YouTube IFrame API script)
```

### JavaScript (client — `assets/js/`)

```
assets/js/
  app.js                        # (scaffold, modified — register hooks)
  hooks/
    video_player.js             # YouTube IFrame API management + sync engine
    copy_url.js                 # clipboard copy hook
  sync/
    clock_sync.js               # NTP-style clock offset calculator
    reconcile.js                # drift correction loop (playbackRate + hard seek + hysteresis)
    suppression.js              # generation counter for event suppression
  lib/
    youtube_loader.js           # loads YouTube IFrame API script, returns promise
```

### Browser Extension (`extension/`)

```
extension/
  manifest.json                 # MV3 manifest
  background.js                 # service worker — holds ports + Phoenix Channel
  content.js                    # content script — MutationObserver, <video> hooks, port to SW
  lib/
    phoenix_channel.js          # minimal Phoenix Channel client for SW (phoenix.js or bundled subset)
```

### Tests

```
test/
  watch_party/
    room_server_test.exs        # GenServer unit tests (play/pause/seek/queue/join/leave)
    room_manager_test.exs       # ensure_room, create_room
    media_item_test.exs         # URL parsing — all YouTube variants + fallback
    username_generator_test.exs # generates readable names
  watch_party_web/
    live/
      home_live_test.exs        # create room, redirect
      room_live_test.exs        # join room, user list, URL submission
    channels/
      extension_channel_test.exs # join, sync events, PubSub relay
```

---

## Phase 0: Scaffold + Room Lifecycle

### 0.1 — Generate Phoenix project

- [ ] Run `mix phx.new watch_party --no-ecto --no-mailer --no-dashboard` in the project root
- [ ] Move generated files up so project root IS the phoenix app (not a subdirectory)
- [ ] Create `devenv.nix` with elixir, erlang, nodejs deps
- [ ] Run `mix setup` to install deps and build assets
- [ ] Run `mix test` — confirm scaffold tests pass
- [ ] Run `mix phx.server` — confirm it boots and loads in browser
- [ ] Commit: "scaffold phoenix 1.8.5 app"

### 0.2 — Add nanoid dependency

- [ ] Add `{:nanoid, "~> 2.1"}` to `mix.exs` deps
- [ ] Run `mix deps.get`
- [ ] Test in iex: `Nanoid.generate(8, "0123456789abcdefghijklmnopqrstuvwxyz")` returns 8-char string
- [ ] Commit: "add nanoid dep"

### 0.3 — Username generator

- [ ] Write test `test/watch_party/username_generator_test.exs`:
  - `generate/0` returns a string
  - result matches pattern `~r/^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/` (e.g. "SwiftHawk42")
  - two calls produce different results (with high probability)
- [ ] Run test — confirm it fails
- [ ] Implement `lib/watch_party/username_generator.ex`:
  - Two word lists (adjectives, animals), ~50 each — hardcoded
  - `generate/0`: random adjective + random animal + random 2-digit number, title-cased
- [ ] Run test — confirm it passes
- [ ] Commit: "add username generator"

### 0.4 — Session identity plug

- [ ] Write test `test/watch_party_web/plugs/session_identity_test.exs`:
  - Request with no session gets `user_id` (UUID) and `username` assigned
  - Request with existing session keeps same `user_id` and `username`
- [ ] Run test — confirm it fails
- [ ] Implement `lib/watch_party_web/plugs/session_identity.ex`:
  - `Plug` behaviour. In `call/2`: if `get_session(conn, :user_id)` is nil, generate UUID + username, put both in session
- [ ] Add plug to browser pipeline in `router.ex` (after `:fetch_session`)
- [ ] Run test — confirm it passes
- [ ] Commit: "add session identity plug"

### 0.5 — MediaItem struct + URL parser

- [ ] Write test `test/watch_party/media_item_test.exs`:
  - `MediaItem.parse_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ")` → `%MediaItem{source_type: :youtube, source_id: "dQw4w9WgXcQ"}`
  - Test all YouTube variants: `youtu.be/ID`, `youtube.com/embed/ID`, `m.youtube.com/watch?v=ID`, `youtube.com/shorts/ID`, `youtube.com/live/ID`
  - Test with extra query params (playlist, timestamp) — still extracts correct ID
  - `MediaItem.parse_url("https://crunchyroll.com/whatever")` → `%MediaItem{source_type: :extension_required, source_id: nil}`
  - Invalid URL returns `{:error, :invalid_url}`
- [ ] Run test — confirm it fails
- [ ] Implement `lib/watch_party/media_item.ex`:
  - Defstruct: `id`, `url`, `source_type`, `source_id`, `title`, `duration`, `thumbnail_url`, `added_by`, `added_at`
  - `parse_url/1`: `URI.parse` → match host against youtube patterns → extract video ID from path/query
  - Everything else → `:extension_required`
- [ ] Run test — confirm it passes
- [ ] Commit: "add MediaItem struct and URL parser"

### 0.6 — RoomServer GenServer

- [ ] Write test `test/watch_party/room_server_test.exs`:
  - `start_link(room_id: "test123")` starts a process
  - `join(pid, user_id, username)` adds user, returns current state
  - `leave(pid, user_id)` removes user
  - `get_state(pid)` returns full state map
  - State has correct initial values (empty queue, paused, time 0)
  - Double join same user_id is idempotent
  - Room stops after configurable empty timeout (use short timeout like 50ms in test)
- [ ] Run test — confirm it fails
- [ ] Implement `lib/watch_party/room_server.ex`:
  - GenServer with `start_link/1` taking `room_id` keyword. Named via `{:via, Registry, {WatchParty.RoomRegistry, room_id}}`
  - State struct as defined in design doc
  - `join/3`, `leave/2`, `get_state/1` as GenServer.call
  - `current_position/1` private function: computes position from `current_time` + elapsed if playing
  - Empty room cleanup: `Process.send_after` on leave when users map is empty, `Process.cancel_timer` on join
- [ ] Run test — confirm it passes
- [ ] Commit: "add RoomServer GenServer"

### 0.7 — RoomManager + Supervision tree

- [ ] Write test `test/watch_party/room_manager_test.exs`:
  - `create_room/0` returns `{:ok, room_id}` where room_id is 8-char alphanumeric
  - `ensure_room/1` with new room_id starts a RoomServer, returns `{:ok, pid}`
  - `ensure_room/1` with existing room_id returns the same pid
  - Concurrent `ensure_room/1` calls for same room_id don't crash (race handling)
- [ ] Run test — confirm it fails
- [ ] Implement `lib/watch_party/room_manager.ex`:
  - `create_room/0`: generate nanoid, call `ensure_room/1`, return `{:ok, room_id}`
  - `ensure_room/1`: Registry lookup first. If not found, `DynamicSupervisor.start_child`. Handle `{:error, {:already_started, pid}}` race.
- [ ] Add `Registry` and `DynamicSupervisor` to supervision tree in `application.ex`:
  - `{Registry, keys: :unique, name: WatchParty.RoomRegistry}`
  - `{DynamicSupervisor, name: WatchParty.RoomSupervisor, strategy: :one_for_one}`
- [ ] Run test — confirm it passes
- [ ] Run `mix test` — all tests pass
- [ ] Commit: "add RoomManager and supervision tree"

### 0.8 — HomeLive + RoomLive shells

- [ ] Write test `test/watch_party_web/live/home_live_test.exs`:
  - GET `/` renders "Create Room" button
  - Clicking "Create Room" redirects to `/room/:id` where `:id` is 8 chars
- [ ] Write test `test/watch_party_web/live/room_live_test.exs`:
  - GET `/room/testroom` renders room page with room ID displayed
  - User's username appears in the user list
  - Opening same room in two connections shows both usernames
  - Navigating to `/room/nonexistent` creates the room (ensure_room behavior)
- [ ] Run tests — confirm they fail
- [ ] Implement `lib/watch_party_web/live/home_live.ex`:
  - Simple LiveView. Renders heading + "Create Room" button.
  - `handle_event("create_room", ...)`: calls `RoomManager.create_room/0`, `push_navigate` to `/room/#{room_id}`
- [ ] Implement `lib/watch_party_web/live/room_live.ex` (shell):
  - `mount/3`: extract `room_id` from params, get `user_id`+`username` from session (via `connect_params` or `on_mount`), call `ensure_room`, call `RoomServer.join`, subscribe to PubSub `room:#{room_id}`, assign state
  - `render/1`: room ID display, user list from assigns, placeholder div for player, URL input form
  - `handle_info({:users_updated, users}, socket)`: update assigns
  - `terminate/2`: call `RoomServer.leave`
- [ ] Update `router.ex`:
  - `live "/", HomeLive`
  - `live "/room/:id", RoomLive`
- [ ] Remove scaffold `PageController` and related files (controller, view, template, test)
- [ ] Run tests — confirm they pass
- [ ] Run `mix phx.server` — manually verify: create room, see URL change, see username in list, open in second tab, see two users
- [ ] Commit: "add HomeLive and RoomLive shells with room lifecycle"

**Phase 0 walking skeleton**: Visit `/` → create room → see unique URL → open in second tab → both users visible → close tab → user disappears.

---

## Phase 1: YouTube Player + Sync Engine

### 1.1 — YouTube IFrame API loader (JS)

- [ ] Create `assets/js/lib/youtube_loader.js`:
  - Exports `loadYouTubeAPI()` → returns a Promise that resolves when `YT.Player` is available
  - If already loaded, resolve immediately
  - Otherwise, inject `<script src="https://www.youtube.com/iframe_api">` and resolve on `window.onYouTubeIframeAPIReady`
  - Handle double-call (singleton pattern)
- [ ] Commit: "add YouTube IFrame API loader"

### 1.2 — Clock sync module (JS)

- [ ] Create `assets/js/sync/clock_sync.js`:
  - Class `ClockSync` with constructor taking a `pushEvent` function and `handleEvent` callback registrar
  - `start()`: sends 5 ping probes 100ms apart. Each ping: `pushEvent("sync:ping", {t1: performance.now()})`
  - On pong: compute `rtt = t4 - t1`, `offset = ((t2 - t1) + (t3 - t4)) / 2`. Store sample.
  - After burst: compute median offset from lowest-75%-RTT samples. Store as `this.offset`.
  - `maintainSync()`: sends a ping every 30s, updates offset with new median
  - `serverNow()`: returns `performance.now() + this.offset` (server time estimate)
  - `isReady()`: returns true after initial burst completes
- [ ] Commit: "add clock sync module"

### 1.3 — Event suppression module (JS)

- [ ] Create `assets/js/sync/suppression.js`:
  - Class `Suppression` 
  - `suppress(expectedState)`: increments generation counter, sets expected terminal state, starts 3s safety timeout
  - `shouldSuppress(currentState)`: returns true if counter > 0. If `currentState === expectedState`, clears counter and timeout, returns true (one last swallow). Otherwise returns true (still suppressing).
  - `isActive()`: returns whether suppression is active
- [ ] Commit: "add event suppression module"

### 1.4 — Drift reconcile module (JS)

- [ ] Create `assets/js/sync/reconcile.js`:
  - Class `Reconcile` with constructor taking a player adapter `{getCurrentTime, seekTo, setPlaybackRate}`
  - `setServerState(position, serverTime, clockSync)`: stores expected server state
  - `start()`: starts 1s interval. Each tick:
    - Compute expected position: `serverPosition + (clockSync.serverNow() - serverTime) / 1000`
    - Compute drift: `localPosition - expectedPosition` (in ms)
    - Apply thresholds with hysteresis (100ms / 3000ms / 4000ms / 2000ms as per design)
  - `stop()`: clears interval, resets playbackRate to 1.0
  - Internal state tracks: `isRateCorrecting`, `lastHardSeekAt`
- [ ] Commit: "add drift reconcile module"

### 1.5 — VideoPlayer LiveView hook

- [ ] Create `assets/js/hooks/video_player.js`:
  - LiveView hook (`mounted`, `destroyed`)
  - On mount: initialize ClockSync, Suppression, Reconcile instances
  - Listen for `sync:state` push_event: buffer state, start clock sync burst, apply state when ready (two-step join)
  - Listen for `sync:play`, `sync:pause`, `sync:seek`: apply to player via suppression, update reconcile
  - Listen for `sync:pong`: forward to ClockSync
  - Listen for `sync:correction`: update reconcile expected state
  - Listen for `video:change`: load new video
  - YouTube mode:
    - Calls `loadYouTubeAPI()`, creates `YT.Player` in the hook's element
    - Wires `onStateChange`: if not suppressed, push `video:play`/`video:pause`/`video:seek` events to server
    - Wires `onReady`: apply buffered state if clock sync is done
  - Extension mode:
    - Renders play/pause button + seek bar (HTML controls, no YouTube player)
    - Push events relay through extension (Phase 3 wiring)
- [ ] Register hook in `assets/js/app.js`: add to `hooks` object passed to `LiveSocket`
- [ ] Commit: "add VideoPlayer LiveView hook"

### 1.6 — RoomServer sync logic

- [ ] Add to `test/watch_party/room_server_test.exs`:
  - `play(pid, user_id, position)` updates state to `:playing` at position, broadcasts via PubSub
  - `pause(pid, user_id, position)` updates state to `:paused`, broadcasts
  - `seek(pid, user_id, position)` updates position, broadcasts
  - `current_position/1` returns correct position during playback (accounting for elapsed time)
  - `add_to_queue(pid, user_id, url, :now)` parses URL, inserts after current, starts playing
  - `add_to_queue(pid, user_id, url, :queue)` appends to queue
- [ ] Run tests — confirm they fail
- [ ] Add to `lib/watch_party/room_server.ex`:
  - `play/3`, `pause/3`, `seek/3` as GenServer.call
  - Each updates `play_state`, `current_time`, `last_sync_at` and broadcasts `{:sync_play, ...}` etc via PubSub to `room:#{room_id}`
  - `add_to_queue/4`: parses URL with MediaItem, inserts into queue, broadcasts `{:queue_updated, ...}`
  - If mode is `:now` and nothing is playing, start playing the new item
  - Periodic sync correction: `Process.send_after(self(), :sync_correction, 5000)` when playing. Broadcasts `{:sync_correction, position, server_time}`. Reschedules itself. Cancelled on pause.
- [ ] Run tests — confirm they pass
- [ ] Commit: "add sync and queue logic to RoomServer"

### 1.7 — RoomLive sync wiring

- [ ] Add to `test/watch_party_web/live/room_live_test.exs`:
  - Submitting a YouTube URL via the form adds it to the room (verify by checking assigns or rendered queue)
  - Two connected LiveViews: play event from one triggers sync:play push_event to the other
- [ ] Run tests — confirm they fail
- [ ] Update `lib/watch_party_web/live/room_live.ex`:
  - `handle_event("add_url", %{"url" => url, "mode" => mode}, socket)`: calls `RoomServer.add_to_queue`, no need to push — PubSub handles it
  - `handle_event("video:play", payload, socket)`: calls `RoomServer.play`
  - `handle_event("video:pause", payload, socket)`: calls `RoomServer.pause`
  - `handle_event("video:seek", payload, socket)`: calls `RoomServer.seek`
  - `handle_event("video:ended", payload, socket)`: calls `RoomServer.video_ended`
  - `handle_event("sync:ping", %{"t1" => t1}, socket)`: capture t2 = monotonic, push_event "sync:pong" with {t1, t2, t3=monotonic}
  - `handle_event("queue:skip", _, socket)`: calls `RoomServer.skip`
  - `handle_event("queue:remove", %{"item_id" => id}, socket)`: calls `RoomServer.remove_from_queue`
  - `handle_event("queue:play_index", %{"index" => i}, socket)`: calls `RoomServer.play_index`
  - PubSub handlers (`handle_info`):
    - `{:sync_play, data}` → `push_event(socket, "sync:play", data)`
    - `{:sync_pause, data}` → `push_event(socket, "sync:pause", data)`
    - `{:sync_seek, data}` → `push_event(socket, "sync:seek", data)`
    - `{:sync_correction, data}` → `push_event(socket, "sync:correction", data)`
    - `{:queue_updated, data}` → update socket assigns for queue rendering + `push_event(socket, "queue:updated", data)`
    - `{:video_changed, data}` → `push_event(socket, "video:change", data)`
    - `{:users_updated, users}` → update assigns
  - On mount (connected): push_event `sync:state` with full room state snapshot from RoomServer
  - Update `render/1`: URL input form, queue list, player div with `phx-hook="VideoPlayer"` and data attributes for source_type/source_id
- [ ] Run tests — confirm they pass
- [ ] Commit: "wire RoomLive sync events"

### 1.8 — Manual integration test

- [ ] Run `mix phx.server`
- [ ] Open two browser tabs to same room
- [ ] Paste YouTube URL — both tabs load the player
- [ ] Play in tab A — tab B starts playing
- [ ] Seek in tab A — tab B seeks
- [ ] Pause in tab A — tab B pauses
- [ ] Open third tab mid-playback — joins at correct position
- [ ] Fix any issues found
- [ ] Commit: "phase 1 integration fixes"

**Phase 1 walking skeleton**: Two browsers synced on a YouTube video — play/pause/seek work, late joiner catches up.

---

## Phase 2: Queue System

### 2.1 — RoomServer queue operations

- [ ] Add to `test/watch_party/room_server_test.exs`:
  - `remove_from_queue/2` removes item by id, shifts current_index if needed
  - `skip/1` advances to next item, broadcasts video:change. At end of queue, sets play_state to :ended
  - `play_index/2` jumps to specific queue index, resets time to 0, broadcasts
  - `video_ended/2` with matching index advances queue. With stale index, no-ops
  - "Play Now" with items already in queue: inserts after current_index, jumps to it
- [ ] Run tests — confirm they fail
- [ ] Implement in `lib/watch_party/room_server.ex`:
  - `remove_from_queue/2`: find by item id, remove from list, adjust current_index if removed item was before current
  - `skip/1`: increment current_index if not at end. Reset current_time to 0, set play_state to :playing, broadcast video:change
  - `play_index/2`: set current_index, reset time, broadcast
  - `video_ended/2`: pattern match `%{current_index: ^index}` — advance or set :ended. Broadcast.
- [ ] Run tests — confirm they pass
- [ ] Commit: "add queue operations to RoomServer"

### 2.2 — Queue UI in RoomLive

- [ ] Update `lib/watch_party_web/live/room_live.ex` render:
  - Queue list below/beside player showing: thumbnail (if available), title/URL, "Remove" button per item, currently playing indicator
  - "Skip" button near player controls
  - Clicking a queue item calls `queue:play_index`
  - URL form has two submit buttons: "Play Now" and "Add to Queue"
- [ ] Update RoomLive event handlers for `queue:skip`, `queue:remove`, `queue:play_index` (already stubbed in 1.7)
- [ ] Run `mix test` — all passing
- [ ] Commit: "add queue UI"

### 2.3 — Queue integration test

- [ ] Run `mix phx.server`
- [ ] Add 3 YouTube URLs to queue
- [ ] Verify queue renders with all 3
- [ ] First video plays. Let it end (or use short video) — second auto-starts
- [ ] Click skip — jumps to third
- [ ] Remove an item — queue updates for all viewers
- [ ] Click on a specific queue item — plays it
- [ ] "Play Now" with existing queue — inserts and jumps correctly
- [ ] Fix any issues found
- [ ] Commit: "phase 2 integration fixes"

**Phase 2 walking skeleton**: Queue of 3 videos auto-advances, skip works, remove works, play-now inserts correctly.

---

## Phase 3: Browser Extension

### 3.1 — ExtensionSocket + ExtensionChannel (server side)

- [ ] Write test `test/watch_party_web/channels/extension_channel_test.exs`:
  - Join `extension:testroom` succeeds, returns room state
  - Push `video:play` → PubSub broadcast to `room:testroom`
  - Push `video:pause` → PubSub broadcast
  - Push `video:seek` → PubSub broadcast
  - Push `sync:ping` → receives `sync:pong` reply
  - PubSub message `{:sync_play, data}` on `room:testroom` → channel pushes `sync:play` to client
- [ ] Run tests — confirm they fail
- [ ] Implement `lib/watch_party_web/channels/extension_socket.ex`:
  - `Phoenix.Socket`, `channel "extension:*", WatchPartyWeb.ExtensionChannel`
  - `connect/3`: accept all connections (no auth for v0), assign a generated user_id
  - `id/1`: return `"extension:#{socket.assigns.user_id}"`
- [ ] Implement `lib/watch_party_web/channels/extension_channel.ex`:
  - `join/3`: ensure_room, join RoomServer, subscribe to PubSub topic `room:#{room_id}`
  - `handle_in` for each sync event: call RoomServer, same as RoomLive does
  - `handle_in("sync:ping", ...)`: reply with pong (t2/t3)
  - `handle_info` for each PubSub message: push to channel client
  - `terminate/2`: leave RoomServer
- [ ] Add socket to `endpoint.ex`: `socket "/extension", WatchPartyWeb.ExtensionSocket, websocket: true`
- [ ] Run tests — confirm they pass
- [ ] Commit: "add ExtensionSocket and ExtensionChannel"

### 3.2 — Extension manifest + content script skeleton

- [ ] Create `extension/` directory at project root
- [ ] Create `extension/manifest.json`:
  ```json
  {
    "manifest_version": 3,
    "name": "WatchParty Sync",
    "version": "0.1.0",
    "description": "Syncs video playback with WatchParty rooms",
    "permissions": ["storage"],
    "background": { "service_worker": "background.js" },
    "content_scripts": [{
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }],
    "icons": {}
  }
  ```
- [ ] Create `extension/content.js` skeleton:
  - On load: check `chrome.storage.local` for active room config `{room_id, server_url}`
  - If no config, do nothing (inert on non-tracked tabs)
  - If config present: open port to SW via `chrome.runtime.connect({ name: "watchparty" })`
  - Set up MutationObserver for `<video>` detection
  - On `<video>` found: hook `play`, `pause`, `seeked`, `timeupdate` events
  - Monkey-patch `HTMLElement.prototype.attachShadow` to intercept Shadow DOM roots and observe them too
  - Send state changes to SW via port: `port.postMessage({type: "video:play", position: ...})`
  - Listen for commands from SW via port: apply play/pause/seek to `<video>` with suppression (generation counter)
- [ ] Create `extension/background.js` skeleton:
  - Listen for port connections from content scripts
  - Track active ports by tab ID
  - Placeholder for Phoenix Channel connection (next step)
- [ ] Commit: "extension skeleton — manifest, content script, background SW"

### 3.3 — Phoenix Channel client for service worker

- [ ] Bundle a minimal Phoenix Channel client for use in the service worker. Options:
  - Copy `phoenix.js` from deps and import it in background.js (simplest)
  - Or use raw WebSocket with manual Channel join/heartbeat protocol (more control, less code)
- [ ] Decision: use `phoenix.js` from the Phoenix dep — it's well-tested and handles heartbeat/reconnect
- [ ] Create `extension/lib/phoenix.js`: copy from `deps/phoenix/priv/static/phoenix.mjs` (or reference it)
- [ ] Update `extension/background.js`:
  - Import Socket from phoenix.js
  - On receiving room config from content script: `new Socket(server_url + "/extension/websocket")`
  - Join channel `extension:${room_id}`
  - Route incoming channel events → post to content script port
  - Route content script port messages → push to channel
  - Handle disconnect/reconnect
- [ ] Manually test: load extension in Chrome, open a page, verify SW starts and content script injects
- [ ] Commit: "wire Phoenix Channel in extension service worker"

### 3.4 — Room UI for extension mode

- [ ] Update `lib/watch_party_web/live/room_live.ex`:
  - When current media item is `source_type: :extension_required`:
    - Show "Open in New Tab" button instead of YouTube player
    - Button click: pushEvent to JS hook which calls `window.open(url)` and writes `{room_id, server_url}` to a well-known element or uses postMessage to signal the extension
    - Actually: the cleaner approach is the "Open" button also sets `chrome.storage.local` via a small inline script or the extension detects the room page and auto-configures. Use the storage approach as per design doc.
  - Show "Waiting for player connection..." status until extension reports video hooked
  - Once connected: show basic play/pause button + seek slider that sends commands via RoomServer (same PubSub path as YouTube, but the extension channel is the one controlling the actual player)
- [ ] Listen for PubSub messages from extension channel indicating player state
- [ ] Commit: "add extension mode UI in RoomLive"

### 3.5 — Content script video hooking

- [ ] Refine `extension/content.js`:
  - MutationObserver: observe `document.documentElement` with `{ childList: true, subtree: true }`
  - Callback: check added nodes for `<video>` elements. Also check added nodes' children recursively (1 level for performance).
  - Shadow DOM: `const origAttachShadow = HTMLElement.prototype.attachShadow; HTMLElement.prototype.attachShadow = function(...args) { const root = origAttachShadow.apply(this, args); observer.observe(root, {childList: true, subtree: true}); return root; }`
  - On `<video>` found:
    - Hook `play`, `pause`, `seeked` events (with suppression)
    - Start 5s timeupdate reporting interval when playing
    - Report to SW: `{type: "video:hooked", duration: video.duration}`
    - Report state changes: `{type: "video:play", position: video.currentTime}` etc
  - On command from SW:
    - `{type: "command:play", position}` → `video.currentTime = position; video.play()`
    - `{type: "command:pause", position}` → `video.currentTime = position; video.pause()`
    - `{type: "command:seek", position}` → `video.currentTime = position`
- [ ] Commit: "content script video detection and hooking"

### 3.6 — Extension integration test against Crunchyroll

- [ ] Load extension in Chrome via `chrome://extensions` → Developer mode → Load unpacked
- [ ] Create a room, paste a Crunchyroll episode URL
- [ ] Click "Open in New Tab" — Crunchyroll opens
- [ ] Navigate to the episode, click play on the Crunchyroll player
- [ ] Verify extension detects the `<video>` element (check SW console for "video:hooked" message)
- [ ] In room UI: verify playback controls appear
- [ ] Open second browser with extension, join same room — both see sync
- [ ] Test play/pause/seek from room UI controls
- [ ] Fix any issues (Shadow DOM, CSP, timing)
- [ ] Commit: "extension integration tested with Crunchyroll"

**Phase 3 walking skeleton**: Extension hooks Crunchyroll's `<video>`, sync commands flow room UI → server → extension → player.

---

## Phase 4: Polish + Edge Cases

### 4.1 — Reconnection handling

- [ ] In `video_player.js` hook: listen for LiveView reconnect event (`phx:page-loading-stop` or hook's `reconnected()` callback)
- [ ] On reconnect: re-run clock sync burst, request fresh `sync:state` from server
- [ ] In `room_live.ex`: handle reconnect — push fresh `sync:state` on `mount` (LiveView already remounts on reconnect, so this should work naturally — verify)
- [ ] In `extension/background.js`: Phoenix Socket auto-reconnects. On reconnect, re-join channel and re-sync state
- [ ] Commit: "handle reconnection gracefully"

### 4.2 — Seek debounce (server-side)

- [ ] Add to RoomServer: track `last_seek_at` per user. Reject seeks within 500ms of last seek from same user. Return `{:error, :debounced}`.
- [ ] Test: rapid seeks from same user — only first is processed
- [ ] RoomLive/ExtensionChannel: handle `{:error, :debounced}` gracefully (no-op)
- [ ] Commit: "add server-side seek debounce"

### 4.3 — Basic rate limiting

- [ ] Add to RoomServer: simple per-user event counter. Max 20 events per user per 5 seconds. Reset counter every 5s with `Process.send_after`.
- [ ] On exceeding: log warning, ignore event, optionally push error to client
- [ ] Test: spam events — excess are dropped
- [ ] Commit: "add basic rate limiting"

### 4.4 — Username rename

- [ ] Add to RoomLive: small form/input next to current username in sidebar. `handle_event("username:change", ...)` → update session + call `RoomServer.rename_user/3` → broadcast users:updated
- [ ] Add `rename_user/3` to RoomServer (if not already there)
- [ ] Test: rename shows up for all connected users
- [ ] Commit: "add username rename"

### 4.5 — Copy room URL

- [ ] Create `assets/js/hooks/copy_url.js`:
  - Hook on a button element. On click: `navigator.clipboard.writeText(this.el.dataset.url)`. Flash "Copied!" text briefly.
- [ ] Add to RoomLive render: a button with `phx-hook="CopyUrl"` and `data-url={url(@socket, ~p"/room/#{@room_id}")}`
- [ ] Register hook in app.js
- [ ] Commit: "add copy room URL button"

### 4.6 — Basic layout with Tailwind

- [ ] Style the room page with Tailwind (already included by Phoenix 1.8.5):
  - Responsive-ish single column layout (not mobile-optimized, just not broken)
  - Player area: 16:9 container, full width
  - Below player: URL input bar with Play Now / Add to Queue buttons
  - Right sidebar (or below on narrow screens): user list + queue list
  - Room URL with copy button at top
- [ ] Style the home page: centered card with "Create Room" button
- [ ] Commit: "basic Tailwind layout"

### 4.7 — Final integration sweep

- [ ] Run `mix test` — all tests pass
- [ ] Full manual test:
  - Create room, share URL, two users join
  - YouTube: play/pause/seek sync, queue 3 videos, auto-advance, skip, remove, play-now, late joiner
  - Extension: open Crunchyroll URL, hook player, sync controls work
  - Rename username — both users see update
  - Copy URL — works
  - Kill network briefly — reconnects and re-syncs
- [ ] Fix any remaining issues
- [ ] Commit: "v0 complete"
- [ ] Tag: `git tag v0.0.1`

---

## Notes for Implementation

### LiveView session access
Phoenix 1.8 LiveView gets session data via `connect_params` or `on_mount`. The SessionIdentity plug puts `user_id` and `username` in the cookie session. In the LiveView `mount`, access via `socket |> get_connect_params()` or by passing through `session` parameter in the router's `live_session`.

Recommended: use `live_session` in router with `on_mount` hook that reads session:
```elixir
live_session :default, on_mount: [WatchPartyWeb.Hooks.AssignUser] do
  live "/", HomeLive
  live "/room/:id", RoomLive
end
```

### PubSub topic convention
All room events use topic `"room:#{room_id}"`. Both RoomLive and ExtensionChannel subscribe. RoomServer broadcasts to this topic.

### Extension ↔ Room UI communication
The extension content script and the room LiveView page are on different origins/tabs. Communication path:
1. Room UI stores room config in element data attributes (room_id, server_url)
2. Extension content script on room page reads these, sends to SW via port
3. SW connects Channel, relays events
4. When user clicks "Open" for extension URL, room UI writes config to a `<meta>` tag or uses `window.postMessage` to the extension content script on the room page
5. Content script on room page tells SW to expect a connection from the new tab
6. SW stores config in `chrome.storage.local` with the URL pattern
7. Content script on Crunchyroll tab reads config from storage, connects to SW

Simpler alternative: the "Open" button opens the URL with a query param like `?watchparty=ROOM_ID&server=URL`. Content script reads the query param. This avoids storage coordination entirely.

### YouTube embed container
The player div needs `phx-update="ignore"` to prevent LiveView from clobbering the YouTube iframe on re-renders. The hook manages the player entirely.

### Colocated hooks (Phoenix 1.8.5)
Phoenix 1.8.5 supports colocated hooks via the `phoenix-colocated` package. The scaffold imports `colocatedHooks` in app.js. Our custom hooks should be added alongside:
```javascript
import { hooks as colocatedHooks } from "phoenix-colocated/watch_party"
import VideoPlayer from "./hooks/video_player"
import CopyUrl from "./hooks/copy_url"

const liveSocket = new LiveSocket("/live", Socket, {
  hooks: { ...colocatedHooks, VideoPlayer, CopyUrl },
})
```
