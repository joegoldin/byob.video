# WatchParty Design — v0 MVP

## Overview

An open-source another sync extension clone. Users create ephemeral rooms with shareable URLs, paste video links, and watch in sync. YouTube plays embedded with native controls. All other sites (Crunchyroll as reference target) open in a popup via a Chrome extension that hooks the `<video>` element for sync.

**Stack**: Elixir/Phoenix, LiveView + JS hooks, GenServer-per-room, Chrome MV3 extension.

---

## Decided Architecture (from brainstorming)

These decisions override the original research spec where they conflict:

1. **LiveView `push_event`/`handleEvent` for room sync** — no separate RoomChannel. One WebSocket per client. The LiveView process subscribes to PubSub and relays sync events to the client via hooks.
2. **Dedicated `ExtensionChannel` for the browser extension** — the extension connects from outside the room page, so it needs its own Channel. Both LiveView and ExtensionChannel talk to the same RoomServer via PubSub.
3. **Port-based messaging in extension** — content scripts use `chrome.runtime.connect()` to keep the MV3 service worker alive, not `chrome.runtime.sendMessage()`.
4. **Generation counter for event suppression** — replaces the 200ms timeout. Suppress until expected terminal state is reached or 3s safety timeout.
5. **Two-step late joiner** — receive `sync:state` on join, buffer it, run 5-probe clock sync burst (~600ms), then apply state with corrected offset.
6. **`broadcast` + sender-ignore** — instead of `broadcast_from!`. All clients receive all events; sender checks `user_id` and ignores its own. Ensures server-corrected state is visible to everyone.
7. **No Phoenix Presence** — user list tracked in RoomServer state directly. Broadcast on join/leave/rename.
8. **Relaxed drift thresholds with hysteresis** — 100ms (do-nothing) / 3000ms (hard seek). Hysteresis: once rate-correcting, don't hard-seek until >4000ms; once hard-seeked, don't rate-correct until <2000ms.
9. **No Ecto, no database** — rooms are purely in-memory GenServer state. Rooms die on server restart. Persistence is a v0.1 concern.
10. **Idempotent queue advance** — `video:ended` handled by pattern-matching on `current_index`. First message advances; duplicates no-op.

---

## Features (v0)

1. **Room creation** — landing page with "Create Room" button. Generates nanoid (8-char alphanumeric) room ID, redirects to `/room/:id`.
2. **Random usernames** — generated on first visit (e.g. "SwiftHawk42"), stored in session cookie. Renamable from room UI. Visible in user list sidebar.
3. **URL input** — text input at top of room. Paste a URL, choose "Play Now" or "Add to Queue".
4. **YouTube embedded player** — detected by URL parser. Loads via IFrame API with native controls. Sync hooks via `onStateChange`.
5. **Extension-synced player** — non-YouTube URLs. Room shows "Open" button. User clicks → `window.open()` to the URL. Extension content script hooks `<video>` via MutationObserver. Room UI shows playback controls (play/pause/seek bar) that relay commands through the extension.
6. **Sync engine** — play/pause/seek broadcast to all viewers. NTP-style clock sync. Drift correction via playbackRate (100ms–3000ms) and hard seek (>3000ms).
7. **Queue** — ordered list of MediaItems. Autoplay next on video end. Skip button. Remove item. Click to play any item. "Play Now" inserts after current and jumps to it. "Add to Queue" appends to end.
8. **Room URL sharing** — copy button next to room URL. That's the invite mechanism.

---

## Architecture

### Supervision Tree

```
Application
 ├── Phoenix.PubSub (name: WatchParty.PubSub)
 ├── Registry (keys: :unique, name: WatchParty.RoomRegistry)
 ├── DynamicSupervisor (name: WatchParty.RoomSupervisor, strategy: :one_for_one)
 └── WatchPartyWeb.Endpoint
      ├── LiveView: RoomLive (room UI, YouTube sync via push_event)
      └── Channel: ExtensionChannel (extension sync via phoenix.js)
```

### Room Lifecycle

- `RoomManager.ensure_room/1`: Registry lookup → DynamicSupervisor.start_child if not found. Handles race with `{:error, {:already_started, _}}`.
- `RoomServer` GenServer with `restart: :transient`. Named via `{:via, Registry, {RoomRegistry, room_id}}`.
- On last user leave: `Process.send_after(self(), :check_empty, :timer.minutes(5))`. On new join: cancel timer. On `:check_empty` with 0 users: `{:stop, :normal, state}`.

### RoomServer State

```elixir
%{
  room_id: "k8f3m2x9",
  users: %{user_id => %{username: "SwiftHawk42", joined_at: monotonic_ms}},
  queue: [%MediaItem{}, ...],
  current_index: nil | non_neg_integer(),
  play_state: :paused | :playing | :ended,
  current_time: 0.0,           # seconds at last_sync_at
  last_sync_at: 0,             # System.monotonic_time(:millisecond)
  playback_rate: 1.0,
  host_id: user_id,            # room creator (informational for now)
  cleanup_ref: nil
}
```

`current_position/1` computes on demand: if playing, `current_time + (now - last_sync_at) / 1000`. If paused, `current_time`. Position stored as float seconds; consider integer milliseconds if float drift becomes an issue over long playback.

### MediaItem

```elixir
%MediaItem{
  id: uuid,
  url: "https://youtube.com/watch?v=...",
  source_type: :youtube | :extension_required,
  source_id: "dQw4w9WgXcQ" | nil,
  title: "Video Title",
  duration: nil,               # populated async via oEmbed/API where possible
  thumbnail_url: nil,
  added_by: user_id,
  added_at: DateTime.t()
}
```

### URL Parser

Extracts `source_type` and `source_id`. YouTube URL variants to handle:
- `youtube.com/watch?v=ID`
- `youtu.be/ID`
- `youtube.com/embed/ID`
- `m.youtube.com/watch?v=ID`
- `youtube.com/shorts/ID`
- `youtube.com/live/ID`
- With arbitrary query params, timestamps (`&t=`), playlists

Everything non-YouTube → `:extension_required`.

### Sync Protocol (LiveView ↔ Client)

**Client → Server (handleEvent → push):**

| Event | Payload |
|---|---|
| `video:play` | `{position}` |
| `video:pause` | `{position}` |
| `video:seek` | `{position}` |
| `video:ended` | `{index}` |
| `queue:add` | `{url, mode: "now" | "queue"}` |
| `queue:remove` | `{item_id}` |
| `queue:skip` | `{}` |
| `queue:play_index` | `{index}` |
| `username:change` | `{username}` |
| `sync:ping` | `{t1}` |

**Server → Client (push_event):**

| Event | Payload |
|---|---|
| `sync:state` | Full room snapshot (on join) |
| `sync:play` | `{time, server_time, user_id}` |
| `sync:pause` | `{time, server_time, user_id}` |
| `sync:seek` | `{time, server_time, user_id}` |
| `sync:correction` | `{expected_time, server_time}` (every 5s during playback) |
| `queue:updated` | `{queue, current_index}` |
| `video:change` | `{media_item, index}` |
| `users:updated` | `{users}` |
| `sync:pong` | `{t1, t2, t3}` |

### Sync Protocol (Extension ↔ Server)

Extension uses a dedicated Phoenix Channel (`extension:room_id`). Same event names and payloads as above, but transported over standard Channel push/receive instead of LiveView events. The ExtensionChannel process subscribes to the same PubSub topic as the LiveView processes for that room.

### Clock Sync

NTP-style over LiveView events (or Channel for extension). Client sends `sync:ping` with `t1 = performance.now()`. Server replies with `{t1, t2, t3}` where t2/t3 are `System.monotonic_time(:millisecond)`. Client computes RTT and offset. 5 probes on join (100ms apart), then every 30s during playback. Median of lowest-75%-RTT samples. No EMA — just median.

### Drift Correction

Client-side reconcile loop runs every 1s during playback:

```
drift = (localPosition - expectedServerPosition) in ms

if |drift| < 100ms       → do nothing
if 100ms ≤ |drift| < 3000ms → set playbackRate to 0.95 (ahead) or 1.05 (behind)
if |drift| ≥ 3000ms      → hard seek to expected position

Hysteresis:
  - While rate-correcting, only hard-seek if drift exceeds 4000ms
  - After a hard seek, don't start rate-correcting until drift drops below 2000ms
```

### Event Suppression (Generation Counter)

```javascript
// On applying remote command:
this.syncGen++;
this.expectedState = 'playing'; // or 'paused'
this.suppressUntilGen = this.syncGen;
this.suppressTimeout = setTimeout(() => { this.suppressUntilGen = 0; }, 3000);

// In state change handler:
if (this.suppressUntilGen > 0) {
  if (reachedExpectedState) {
    this.suppressUntilGen = 0;
    clearTimeout(this.suppressTimeout);
  }
  return; // swallow
}
// else: real user action, broadcast
```

---

## Browser Extension (Chrome MV3)

### Architecture

```
Content Script (per tab)
  ├── MutationObserver → detects <video> elements
  ├── Hooks play/pause/seeked/timeupdate on <video>
  ├── chrome.runtime.connect() → persistent port to SW
  └── Receives commands from SW, applies to <video>

Service Worker (background)
  ├── Holds port connections from content scripts
  ├── Phoenix Channel WebSocket to server (ExtensionChannel)
  └── Routes sync events between content scripts and server
```

### manifest.json (key parts)

```json
{
  "manifest_version": 3,
  "permissions": ["activeTab", "storage"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_start"
  }]
}
```

### Content Script

- On load: `chrome.runtime.connect({ name: "watchparty" })` — keeps SW alive.
- MutationObserver on `document.documentElement` with `{ childList: true, subtree: true }` for `<video>` detection.
- Shadow DOM handling: monkey-patch `HTMLElement.prototype.attachShadow` to observe shadow roots.
- On `<video>` found: hook `play`, `pause`, `seeked` events. Send state changes over port.
- On command from port: apply to `<video>` (with generation counter suppression).
- Periodic timecheck every 5s when playing (for drift correction data).

### Service Worker

- Listens for port connections from content scripts.
- When a content script reports a room connection (user clicked "Open" from room UI which includes room_id in the URL or via extension storage), opens Phoenix Channel to `extension:room_id`.
- Routes events bidirectionally: content script ↔ Channel.
- SW stays alive as long as ≥1 content script port is open.
- If no ports and no Channel activity for 30s, SW dies naturally (correct behavior).

### Room UI Integration

When user pastes a non-YouTube URL:
1. Room UI shows the URL title (if resolvable) with an "Open" button.
2. Clicking "Open" stores `{room_id, server_url}` to `chrome.storage.local` and opens the URL in a new tab.
3. Content script on the new tab reads storage, tells SW to connect to the room.
4. Room UI shows "Waiting for player..." until the extension reports a `<video>` hooked, then shows sync controls (play/pause/seek bar).

---

## LiveView Structure

### Pages

- `WatchPartyWeb.HomeLive` — landing page. "Create Room" button. Generates room_id, redirects.
- `WatchPartyWeb.RoomLive` — the room. Mounts VideoPlayer hook. Subscribes to PubSub topic `room:{room_id}`. Calls RoomServer for state mutations.

### RoomLive Responsibilities

- On mount: `ensure_room`, register user in RoomServer, subscribe to PubSub `room:{room_id}`, push `sync:state` to client hook.
- Renders: video player area (`phx-hook="VideoPlayer"` with `phx-update="ignore"`), URL input form, queue list, user list sidebar, room URL with copy button.
- Handles LiveView events from client (play/pause/seek/queue actions) → calls RoomServer → RoomServer broadcasts via PubSub → LiveView `handle_info` receives → `push_event` to client.
- Handles `sync:ping`/`sync:pong` for clock sync with minimal processing between t2/t3.

### JS Hooks

- `VideoPlayer` — manages YouTube IFrame API or extension-mode controls. Contains sync engine (clock sync, reconcile loop, generation counter).
- `CopyUrl` — click to copy room URL to clipboard.
- `QueueItem` — (if needed for drag-and-drop in v0.2; for v0, queue actions are regular LiveView form events).

---

## User Identity

- On first visit (any page): generate random username, store in session cookie (`Plug.Session`).
- Generate a `user_id` (UUID) at the same time, also in session.
- Both persist across page refreshes but not across browsers/devices.
- Rename: LiveView form event → updates session + RoomServer user map → broadcast `users:updated`.

---

## Build Phases

### Phase 0: Scaffold + Room Lifecycle
Phoenix app, RoomServer/Manager/Supervisor, Registry, landing page, room page shell with user list.

### Phase 1: YouTube Player + Sync
URL parser, YouTube IFrame hook, sync engine (clock sync, generation counter, reconcile, late joiner), LiveView push_event wiring.

### Phase 2: Queue
Queue data structure, add/remove/skip/play-index, auto-advance, queue UI.

### Phase 3: Browser Extension
Content script, service worker, ExtensionChannel, room UI for extension mode, tested against Crunchyroll.

### Phase 4: Polish
Reconnection re-sync, seek debounce, rate limiting, username rename, copy URL, basic Tailwind layout.

Phases 1 and 3 are parallelizable (independent player types, shared room infrastructure).

---

## Version Roadmap

**v0** — everything above.

**v0.1** — Firefox extension port, room persistence across restarts (`:dets`).

**v0.2** — buffering coordination (pause-all), playback rate sync (1.5x together), drag-and-drop queue, SponsorBlock.
