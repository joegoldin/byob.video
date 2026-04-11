# Technical specification for an Elixir/Phoenix watch-party clone

**The reference impl's popup-sync approach for non-embeddable sites requires a browser extension — this is not optional, it's a hard constraint imposed by the same-origin policy.** Every investigation confirms that the reference impl uses a Chrome/Firefox extension with content scripts injected via `manifest.json` `matches: ["<all_urls>"]` to access `<video>` elements on Netflix, Crunchyroll, et al. The "no extension, popup + injected scripts" approach described in your requirements is impossible for cross-origin DRM-protected sites. This spec addresses that reality head-on and provides the best viable architecture for each tier of video source.

---

## The cross-origin problem is unsolvable without an extension

This needs to be confronted before anything else. When `window.open("https://crunchyroll.com/watch/...")` creates a popup, the opener gets a `WindowProxy` reference. Due to same-origin policy, the opener can **only** access: `window.closed`, `window.close()`, `window.focus()`, `window.postMessage()` (requires the target to listen — Crunchyroll doesn't), and `window.location` (write-only). There is **zero DOM access** — no `querySelector('video')`, no event listeners, no `currentTime` manipulation. Netflix and Crunchyroll additionally set `Cross-Origin-Opener-Policy: same-origin`, which severs even the `window.opener` relationship entirely, making `postMessage` impossible in both directions.

The approaches that don't work:

- **Proxy with script injection**: Your server fetches the Netflix page, rewrites HTML, injects sync JS, serves from your domain. This gives same-origin DOM access, but **Widevine DRM refuses to decrypt content served from an unauthorized origin**. The CDM validates the page origin against the license server. DRM-protected video will not play. Additionally, Netflix/Crunchyroll SPAs with complex routing, service workers, CORS preflight, and CSP headers break catastrophically under URL rewriting.
- **Bookmarklet injection**: `javascript:void(document.head.appendChild(...))` — modern streaming sites set `Content-Security-Policy: script-src` directives that block execution of injected external scripts. This approach fails silently on every major DRM platform.
- **`about:blank` popup with iframe**: Opening `about:blank`, writing HTML with an iframe pointing to Netflix — the iframe is still cross-origin and its DOM is inaccessible.

The approaches that **do** work:

- **Browser extension** (what w2g actually does): Content scripts specified in `manifest.json` run in the page's execution context with full DOM access. The extension's background service worker maintains a WebSocket to your sync server. This is the only way to control `<video>` elements on third-party DRM sites.
- **Virtual/remote browser** (Hyperbeam/n.eko model): Run headless Chromium on a server, stream viewport via WebRTC. Sidesteps cross-origin entirely — there's only one browser instance. Expensive but works with everything including DRM. Kosmi.io proves this works with an Elixir backend.
- **Screen sharing via `getDisplayMedia()`**: One user shares their tab/screen, others watch the WebRTC stream. No sync needed (single source). Quality depends on uploader bandwidth. Some browsers black-screen DRM content.

**Recommended architecture**: A **three-tier player system** — embedded players for YouTube/Vimeo/Twitch (Tier 1), a lightweight companion browser extension for DRM sites (Tier 2), and WebRTC screen sharing as a universal fallback (Tier 3). The spec below covers all three tiers, but the extension is minimal — far simpler than Teleparty or w2g's extension.

---

## How the reference impl's W2gSync actually works

The reference impl's architecture has two tiers. For embeddable platforms (YouTube, Vimeo, Dailymotion, SoundCloud), it embeds the official player iframe on its own page and syncs via the platform's JavaScript API — straightforward same-origin control. For non-embeddable sites, the **W2gSync browser extension** is mandatory.

The W2gSync flow: A user pastes a Netflix URL into the w2g room. The reference impl detects the URL is non-embeddable and activates the W2gSync player mode, showing a placeholder with an "Open" button. Each room member clicks "Open" — the extension calls `window.open()` navigating **directly to the original Netflix URL** (not a proxy). The extension's content script, declared with `"matches": ["<all_urls>"]` and `"run_at": "document_start"`, is injected by the browser into the Netflix page. The content script deploys a `MutationObserver` on `document.documentElement` with `{ childList: true, subtree: true }` to watch for `<video>` elements appearing in the DOM.

This is why w2g shows "click play to register the player" — Netflix/Crunchyroll are SPAs where the `<video>` element doesn't exist in the initial DOM. It's created only after the user navigates to content and the player initializes. Once the `MutationObserver` detects a `<video>` element, the content script hooks `play`, `pause`, `seeked`, and `timeupdate` events on the `HTMLMediaElement`. It injects a small toolbar overlay at the bottom of the popup. The content script communicates with the extension's background/service worker via `chrome.runtime.sendMessage()`, and the background script maintains a WebSocket connection to w2g's sync server. Sync commands flow: `video element → content script → background worker → w2g server → all peers' background workers → their content scripts → their video elements`. Every user needs their own streaming subscription and must be logged in.

The reference impl also offers a "Link Video" feature that uses the Screen Capture API (`getDisplayMedia()`) to display the popup's content inline in the main room — but this is local capture only, not streamed to other users.

---

## Three-tier player architecture

### Tier 1: Embedded players (YouTube, Vimeo, Twitch, Dailymotion, SoundCloud)

These platforms provide official iframe embed APIs with full programmatic control. The player iframe lives on your page — same-origin for your sync JavaScript. No extension needed.

**Embeddability matrix:**

| Platform | Embeddable | API quality | Sync feasibility | Notes |
|---|---|---|---|---|
| YouTube | ✅ | Full IFrame API | Excellent | `controls: 1` shows native controls while allowing programmatic sync |
| Vimeo | ✅ | Full Player SDK | Excellent | Promise-based API; owner can disable embedding |
| Twitch | ✅ | Interactive embed | Good for VODs, limited for live | `parent` param required; `seek()` only works on VODs |
| Dailymotion | ✅ | Player Embed SDK | Good | Must use Player Embed Script method, not raw iframe |
| SoundCloud | ✅ | Widget API | Good | Callback-based; positions in milliseconds |
| Spotify | ⚠️ | Limited | Poor | Primarily podcasts; music is 30s preview for non-logged-in; unreliable programmatic control |

### Tier 2: Extension-synced players (Netflix, Crunchyroll, Disney+, HBO Max, Prime Video, Hulu, Peacock, Paramount+, Apple TV+)

All major subscription streaming services use `X-Frame-Options: DENY`, Widevine/FairPlay/PlayReady DRM with Verified Media Path, and have no public player API. **A browser extension with content script is the only mechanism that works.** The extension can be minimal — ~200 lines of JS total across content script and background worker.

### Tier 3: Screen sharing fallback

For any source that doesn't fit Tier 1 or Tier 2, or for users who refuse to install the extension, `getDisplayMedia()` + WebRTC streams one user's tab to all participants. Phoenix Channels handles signaling; `ex_webrtc` or raw browser WebRTC APIs handle the media transport.

---

## Player abstraction layer

All three tiers must conform to a unified interface so the sync engine doesn't care which player type is active:

```typescript
interface SyncablePlayer {
  load(mediaId: string, startTime?: number): Promise<void>;
  destroy(): void;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(seconds: number): Promise<void>;
  getCurrentTime(): Promise<number>;
  getDuration(): Promise<number>;
  isPaused(): Promise<boolean>;
  isBuffering(): Promise<boolean>;
  getPlaybackRate(): Promise<number>;
  setPlaybackRate(rate: number): Promise<void>;
  on(event: SyncEvent, handler: (data: SyncEventData) => void): void;
  off(event: SyncEvent, handler: Function): void;
  readonly playerType: 'youtube' | 'vimeo' | 'twitch' | 'dailymotion' 
                      | 'soundcloud' | 'html5_extension' | 'screen_share';
  readonly supportsSeek: boolean;
  readonly supportsPlaybackRate: boolean;
}

type SyncEvent = 'play' | 'pause' | 'seek' | 'buffering' 
              | 'bufferEnd' | 'ended' | 'timeUpdate' | 'error' | 'ready';

interface SyncEventData {
  currentTime: number;
  duration: number;
  paused: boolean;
  source: 'local' | 'remote'; // distinguishes user action from sync command
}
```

**Critical pattern — the suppress flag**: Every adapter implementation must maintain a `_suppressEvents: boolean` flag. Set `true` before executing remote sync commands, `false` after. Without this, you get infinite loops: receive remote play → call `play()` → fires `play` event → broadcasts play → receive remote play → ∞. The YouTube adapter wraps `onStateChange`, the Vimeo adapter wraps event callbacks, and the extension adapter wraps `HTMLMediaElement` event listeners — all checking `_suppressEvents` before forwarding events to the sync engine.

**YouTube adapter specifics**: `getCurrentTime()` returns the actual playback position, not the seek target. After `seekTo()`, there's a brief window where it returns the pre-seek value. `seekTo(seconds, true)` — always pass `allowSeekAhead=true` for sync to ensure accuracy beyond buffered data. There's a **50–200ms latency** between calling `playVideo()` and the `PLAYING` state firing. Different browsers fire different state sequences — Chrome emits duplicate pause events; Firefox cycles through buffering→play→buffering→play. The adapter must debounce and normalize these.

**Extension adapter specifics**: Communication flows through `chrome.runtime.sendMessage()` to the background worker's WebSocket. The `getCurrentTime()` call is async (message round-trip), so the interface is Promise-based. The content script uses this `MutationObserver` pattern:

```javascript
function detectVideoElements() {
  document.querySelectorAll('video').forEach(hookVideo);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.tagName === 'VIDEO') hookVideo(node);
        node.querySelectorAll?.('video').forEach(hookVideo);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function hookVideo(video) {
  if (video.dataset.syncHooked) return;
  video.dataset.syncHooked = 'true';
  video.addEventListener('play', () => sendSync({ type: 'play', time: video.currentTime }));
  video.addEventListener('pause', () => sendSync({ type: 'pause', time: video.currentTime }));
  video.addEventListener('seeked', () => sendSync({ type: 'seek', time: video.currentTime }));
  setInterval(() => {
    if (!video.paused) sendSync({ type: 'timecheck', time: video.currentTime });
  }, 5000);
}
```

Some players (especially web-component-based ones) place `<video>` inside Shadow DOM. `document.querySelector` cannot see inside shadow roots. The content script should monkey-patch `HTMLElement.prototype.attachShadow` to observe shadow roots as they're created, or recursively walk `element.shadowRoot?.querySelector('video')` on candidate elements. A `MutationObserver` does **not** cross shadow boundaries — attach separate observers to each shadow root.

---

## Clock synchronization and drift correction

### NTP-style offset calculation

The goal is not UTC agreement — it's a stable offset so clients can compute "where the video should be right now" relative to the server's canonical timeline. Use `performance.now()` on the client (monotonic, microsecond precision, unaffected by system clock adjustments) and `System.monotonic_time(:millisecond)` on the server.

**Client-side algorithm:**

```javascript
class ClockSync {
  constructor(channel) {
    this.channel = channel;
    this.offset = 0;
    this.PROBE_COUNT = 5;
    this.PROBE_DELAY_MS = 1000;
    this.SYNC_INTERVAL = 30000; // re-sync every 30s during playback
  }

  async performSync() {
    const samples = [];
    for (let i = 0; i < this.PROBE_COUNT; i++) {
      const sample = await this.sendProbe();
      if (sample) samples.push(sample);
      await new Promise(r => setTimeout(r, this.PROBE_DELAY_MS));
    }
    if (!samples.length) return;
    // Sort by RTT, discard top 25% (outliers), take median offset
    samples.sort((a, b) => a.rtt - b.rtt);
    const filtered = samples.slice(0, Math.ceil(samples.length * 0.75));
    const newOffset = filtered[Math.floor(filtered.length / 2)].offset;
    // EMA smoothing (α=0.3)
    this.offset = this.offset === 0 ? newOffset : 0.3 * newOffset + 0.7 * this.offset;
  }

  sendProbe() {
    return new Promise((resolve) => {
      const t1 = performance.now();
      this.channel.push("sync:ping", { t1 })
        .receive("ok", (resp) => {
          const t4 = performance.now();
          const rtt = (t4 - t1) - (resp.t3 - resp.t2);
          const offset = ((resp.t2 - t1) + (resp.t3 - t4)) / 2;
          resolve({ rtt, offset });
        })
        .receive("timeout", () => resolve(null));
    });
  }

  now() { return performance.now() + this.offset; }
}
```

**Server-side handler:**

```elixir
def handle_in("sync:ping", %{"t1" => t1}, socket) do
  t2 = System.monotonic_time(:millisecond)
  t3 = System.monotonic_time(:millisecond) # minimal processing between t2/t3
  {:reply, {:ok, %{t1: t1, t2: t2, t3: t3}}, socket}
end
```

Initial join should burst **5 probes at 100ms intervals** for fast offset establishment. During playback, re-sync every **30 seconds** with standard 1s-spaced probes. When paused, back off to every **5 minutes**.

### Drift correction tiers

The server maintains canonical play state. Clients independently calculate drift and apply tiered correction:

| Drift | Action | UX impact |
|---|---|---|
| **< 50ms** | No action | Imperceptible |
| **50ms–2000ms** | Adjust `playbackRate` ±5% | Usually imperceptible; 0.95x/1.05x for catch-up |
| **> 2000ms** | Hard seek | Visible jump, but necessary |

These thresholds are drawn from **Jellyfin SyncPlay's production defaults**: `sync_max_delay_speed: 50ms`, `sync_max_delay_skip: 300ms`, `sync_method_thresh: 2000ms`. For browser-based players with less precise control than native mpv, the more lenient 50ms/2000ms works well.

```javascript
reconcile() {
  if (!this.serverState || this.isBuffering) return;
  const serverNow = this.clock.now();
  let targetPosition;
  if (this.serverState.state === 'playing') {
    const elapsed = (serverNow - this.serverState.last_update_at) / 1000;
    targetPosition = this.serverState.position + elapsed;
  } else {
    targetPosition = this.serverState.position;
  }
  const drift = (this.player.getCurrentTime() - targetPosition) * 1000; // ms
  const absDrift = Math.abs(drift);
  
  if (absDrift < 50) {
    if (this.correctionActive) { this.player.setPlaybackRate(1.0); this.correctionActive = false; }
  } else if (absDrift < 2000) {
    this.correctionActive = true;
    this.player.setPlaybackRate(drift > 0 ? 0.95 : 1.05);
  } else {
    this.player.seekTo(targetPosition);
    this.player.setPlaybackRate(1.0);
    this.correctionActive = false;
  }
}
```

### How the reference implementations compare

**Syncplay** (most mature sync algorithm): Server-authoritative with client-side correction. Uses RTT-based timestamp echoing with `PING_MOVING_AVERAGE_WEIGHT` for smoothing. Has a clever `ignoringOnTheFly` mechanism — when a user triggers a state change, an incrementing counter prevents the originator from re-processing their own change as it bounces back from the server. The server determines the "slowest" client and faster clients slow down to match.

**CyTube**: Server-authoritative with a virtual countdown timer. Server ticks position forward during playback and broadcasts `mediaUpdate` events. Clients compare local position against server position. Uses **hard-seek only** (no playbackRate adjustment) with a configurable threshold defaulting to ~2 seconds. Simple but works for embedded players where `playbackRate` control may be unavailable.

**Jellyfin SyncPlay**: Server-authoritative with **time-scheduled commands** — rather than "play now", the server tells clients *when* to execute (a future timestamp), shifting the problem from network latency to time synchronization. Two-tier correction: speed adjustment for 50–2000ms drift, hard seek above. Max 3 consecutive speed adjustments before fallback to seek. Max 5 total sync attempts before disabling sync (prevents thrashing on bad connections).

**Teleparty (Netflix Party)**: Leader-based (host-authoritative). No sophisticated NTP-style clock sync — relies on the simplification that all clients stream from the same CDN and have roughly aligned clocks. Small offsets adjusted by brief pausing or playback rate changes. Closed source.

**The reference impl**: Server-authoritative, any-user-can-control. Simple event broadcast for play/pause/seek. **No playbackRate-based correction.** Community reports sync accuracy of "hundreds of milliseconds to full seconds" — users have requested NTP-style compensation. This is the bar to clear.

### Recommended sync protocol

Use a **hybrid event-based + continuous** model:

- **Events** for user actions (play/pause/seek): Immediate broadcast, low latency. Client sends action → server updates canonical state → server broadcasts to all peers.
- **Continuous heartbeats** for drift detection: Server broadcasts canonical state every **5 seconds** during playback. Each client independently reconciles.
- **Clock sync** as a separate concern: Runs on its own interval, independent of playback sync.
- **Server-authoritative**: The GenServer is the single source of truth. Any user can play/pause/seek (server broadcasts to all). Optional host-only control mode.

---

## Phoenix/Elixir architecture

### Supervision tree

```
Application
 ├── Phoenix.PubSub (name: WatchParty.PubSub)
 ├── Registry (keys: :unique, name: WatchParty.RoomRegistry)
 ├── DynamicSupervisor (name: WatchParty.RoomSupervisor, strategy: :one_for_one)
 ├── WatchPartyWeb.Presence
 └── WatchPartyWeb.Endpoint
      └── UserSocket
           └── channel "room:*" → RoomChannel
```

### GenServer per room with DynamicSupervisor + Registry

```elixir
defmodule WatchParty.RoomServer do
  use GenServer, restart: :transient

  defstruct [
    :room_id, :created_at, :host_id,
    queue: [],
    current_index: nil,
    play_state: :paused,
    current_time: 0.0,
    last_sync_at: 0,
    playback_rate: 1.0,
    settings: %{host_only_controls: false, auto_skip_on_end: true},
    cleanup_ref: nil
  ]

  def start_link(room_id) do
    GenServer.start_link(__MODULE__, room_id, name: via(room_id))
  end

  defp via(room_id), do: {:via, Registry, {WatchParty.RoomRegistry, room_id}}

  @impl true
  def init(room_id) do
    state = %__MODULE__{
      room_id: room_id,
      created_at: DateTime.utc_now(),
      last_sync_at: System.monotonic_time(:millisecond)
    }
    {:ok, state}
  end

  # Current position computed on demand — never stale
  def current_position(%{play_state: :paused, current_time: t}), do: t
  def current_position(%{play_state: :playing, current_time: t, last_sync_at: ts}) do
    elapsed = (System.monotonic_time(:millisecond) - ts) / 1000.0
    t + elapsed
  end
end
```

**`restart: :transient`** means the supervisor only restarts on abnormal exits — when we intentionally stop an empty room via `{:stop, :normal, state}`, it stays dead. The `{:via, Registry, ...}` tuple avoids atom exhaustion from dynamic room names; `Registry` auto-cleans entries when the owning process terminates.

### Room find-or-create

```elixir
defmodule WatchParty.RoomManager do
  def ensure_room(room_id) do
    case Registry.lookup(WatchParty.RoomRegistry, room_id) do
      [{_pid, _}] -> :ok
      [] ->
        case DynamicSupervisor.start_child(WatchParty.RoomSupervisor, {WatchParty.RoomServer, room_id}) do
          {:ok, _} -> :ok
          {:error, {:already_started, _}} -> :ok  # race condition handled
        end
    end
  end
end
```

### Room auto-cleanup with grace period

Two complementary mechanisms. **GenServer's built-in timeout** returns a timeout value from every callback — if no messages arrive within that window, `handle_info(:timeout, state)` fires. This catches truly idle rooms. **Custom timer via `Process.send_after`** provides the explicit "room empty for N minutes" grace period:

```elixir
def handle_cast(:user_left, state) do
  topic = "room:#{state.room_id}"
  if map_size(WatchPartyWeb.Presence.list(topic)) == 0 do
    ref = Process.send_after(self(), :check_empty, :timer.minutes(5))
    {:noreply, %{state | cleanup_ref: ref}}
  else
    {:noreply, state}
  end
end

def handle_cast(:user_joined, %{cleanup_ref: ref} = state) do
  if ref, do: Process.cancel_timer(ref)
  {:noreply, %{state | cleanup_ref: nil}}
end

def handle_info(:check_empty, state) do
  topic = "room:#{state.room_id}"
  if map_size(WatchPartyWeb.Presence.list(topic)) == 0 do
    {:stop, :normal, state}
  else
    {:noreply, %{state | cleanup_ref: nil}}
  end
end
```

For the "rooms live a few days after going empty" behavior like w2g, extend the grace period to `timer.hours(48)` or similar. If you want rooms to survive node restarts for this longer period, persist minimal room state (room_id, queue, settings) to SQLite before termination and restore on lookup.

### Phoenix Presence for user tracking

```elixir
defmodule WatchPartyWeb.Presence do
  use Phoenix.Presence, otp_app: :watch_party, pubsub_server: WatchParty.PubSub
end
```

Track users on join with metadata, update on rename:

```elixir
# In RoomChannel
def handle_info(:after_join, socket) do
  {:ok, _} = Presence.track(socket, socket.assigns.user_id, %{
    username: socket.assigns.username,
    joined_at: System.system_time(:second)
  })
  push(socket, "presence_state", Presence.list(socket))
  {:noreply, socket}
end

def handle_in("username:change", %{"username" => new_name}, socket) do
  Presence.update(socket, socket.assigns.user_id, fn meta ->
    Map.put(meta, :username, new_name)
  end)
  {:noreply, assign(socket, :username, new_name)}
end
```

Client-side, the Phoenix JS library handles `presence_state` and `presence_diff` automatically via `Presence.onSync()`. CRDT-based — no single point of failure, self-healing across distributed nodes, automatic cleanup on disconnect.

### RoomChannel implementation

```elixir
defmodule WatchPartyWeb.RoomChannel do
  use WatchPartyWeb, :channel
  alias WatchPartyWeb.Presence
  alias WatchParty.RoomServer

  def join("room:" <> room_id, %{"username" => username}, socket) do
    WatchParty.RoomManager.ensure_room(room_id)
    RoomServer.user_joined(room_id)
    send(self(), :after_join)
    socket = socket |> assign(:room_id, room_id) |> assign(:username, username)
    {:ok, RoomServer.get_state(room_id), socket}
  end

  # Play/pause/seek: update GenServer, broadcast_from (sender already applied locally)
  def handle_in("video:play", %{"position" => pos}, socket) do
    RoomServer.play(socket.assigns.room_id, pos)
    broadcast_from!(socket, "sync:play", %{
      time: pos,
      server_time: System.monotonic_time(:millisecond)
    })
    {:noreply, socket}
  end

  def handle_in("video:pause", %{"position" => pos}, socket) do
    RoomServer.pause(socket.assigns.room_id, pos)
    broadcast_from!(socket, "sync:pause", %{
      time: pos,
      server_time: System.monotonic_time(:millisecond)
    })
    {:noreply, socket}
  end

  def handle_in("video:seek", %{"position" => pos}, socket) do
    RoomServer.seek(socket.assigns.room_id, pos)
    broadcast_from!(socket, "sync:seek", %{
      time: pos,
      server_time: System.monotonic_time(:millisecond)
    })
    {:noreply, socket}
  end

  # Clock sync — minimal processing between t2 and t3
  def handle_in("sync:ping", %{"t1" => t1}, socket) do
    t2 = System.monotonic_time(:millisecond)
    t3 = System.monotonic_time(:millisecond)
    {:reply, {:ok, %{t1: t1, t2: t2, t3: t3}}, socket}
  end

  def terminate(_reason, socket) do
    RoomServer.user_left(socket.assigns.room_id)
    :ok
  end
end
```

Use `broadcast_from!` for player events (sender already applied locally, no echo) and `broadcast!` for chat messages and queue updates (everyone should see, including sender's confirmation).

### Storage recommendation

**GenServer state for room playback state** — simplest, rooms are ephemeral, state is co-located with logic. **ETS or `Registry.select/2`** for room listings/lobby display — `Registry.select(WatchParty.RoomRegistry, [{{:"$1", :"$2", :_}, [], [{{:"$1", :"$2"}}]}])` gives you all rooms without a separate data store. **SQLite via `ecto_sqlite3`** only if rooms must survive node restarts across the multi-day grace period, or for persistent features like chat history.

### LiveView + JS hooks, not a pure JS SPA

LiveView handles **~90% of the UI** server-side: room creation, lobby, chat, user list, queue management, settings. The video player is inherently client-side — use **LiveView hooks** (`phx-hook`) to bridge to the YouTube IFrame API and other player APIs. LiveView already uses Phoenix Channels under the hood, so PubSub and Presence integration come free. A pure JS SPA with `phoenix.js` would require duplicating server rendering, form handling, and state management for minimal gain.

```elixir
# LiveView template
<div id="video-player" phx-hook="VideoPlayer" phx-update="ignore"
     data-video-url={@video_url} data-video-state={@video_state}
     data-video-position={@video_position}>
</div>
```

```javascript
let VideoPlayer = {
  mounted() {
    this.suppressEvents = false;
    this.initPlayer(this.el.dataset.videoUrl);
    this.handleEvent("sync:play", ({time, server_time}) => {
      this.suppressEvents = true;
      this.player.seekTo(time, true);
      this.player.playVideo();
      setTimeout(() => this.suppressEvents = false, 200);
    });
    // ... similar for pause, seek, change
  }
};
```

The `phx-update="ignore"` is critical — it tells LiveView not to touch this DOM subtree after initial render, since the JS hook manages it entirely.

---

## Data model

### Room GenServer state

```elixir
defmodule WatchParty.Room.State do
  defstruct [
    room_id: nil,                   # "k8f3m2x9" (nanoid)
    queue: [],                      # [MediaItem.t()]
    current_index: nil,             # nil when queue empty
    play_state: :paused,            # :playing | :paused | :ended
    current_time: 0.0,             # seconds into current video at last_sync_at
    last_sync_at: 0,               # System.monotonic_time(:millisecond)
    playback_rate: 1.0,
    host_id: nil,                  # user_id of room creator
    settings: %{
      host_only_controls: false,
      auto_skip_on_end: true,
      max_queue_length: 50,
      sync_tolerance_ms: 2000
    },
    buffering_users: MapSet.new(),
    created_at: nil,
    cleanup_ref: nil
  ]
end
```

### Media item

```elixir
defmodule WatchParty.Room.MediaItem do
  defstruct [
    id: nil,              # UUID.generate()
    url: nil,             # original URL pasted by user
    source_type: nil,     # :youtube | :vimeo | :twitch | :dailymotion | :soundcloud
                          # | :direct | :extension_required
    source_id: nil,       # provider-specific ID (YouTube video ID, etc.)
    title: "Untitled",
    duration: nil,        # seconds, nil for live
    thumbnail_url: nil,
    added_by: nil,        # user_id
    added_at: nil         # DateTime
  ]
end
```

URL parsing should extract `source_type` and `source_id` from the pasted URL. YouTube URLs come in many forms (`youtube.com/watch?v=`, `youtu.be/`, `youtube.com/embed/`, `m.youtube.com/watch?v=`) — use a regex module to normalize. For unrecognized URLs, classify as `:extension_required` and fall back to the Tier 2 or Tier 3 approach.

### Channel message protocol

**Client → Server:**

| Event | Payload | Purpose |
|---|---|---|
| `"video:play"` | `{position: float}` | User pressed play |
| `"video:pause"` | `{position: float}` | User pressed pause |
| `"video:seek"` | `{position: float}` | User seeked |
| `"queue:add"` | `{url: string, position: "next" \| "bottom"}` | Add to queue |
| `"queue:remove"` | `{item_id: string}` | Remove from queue |
| `"queue:reorder"` | `{item_id: string, new_index: int}` | Move item |
| `"queue:skip"` | `{}` | Skip to next |
| `"queue:play_index"` | `{index: int}` | Jump to specific item |
| `"video:ended"` | `{}` | Current video finished |
| `"video:buffering"` | `{}` | Client buffering |
| `"video:ready"` | `{}` | Client ready |
| `"username:change"` | `{username: string}` | Rename |
| `"sync:ping"` | `{t1: float}` | Clock sync probe |
| `"chat:send"` | `{text: string}` | Chat message |

**Server → Client:**

| Event | Payload | Purpose |
|---|---|---|
| `"sync:state"` | Full room snapshot | Sent on join (late joiner reconciliation) |
| `"sync:play"` | `{time, server_time}` | Play command |
| `"sync:pause"` | `{time, server_time}` | Pause command |
| `"sync:seek"` | `{time, server_time}` | Seek command |
| `"sync:correction"` | `{expected_time, server_time}` | Periodic drift correction (every 5s) |
| `"queue:updated"` | `{queue: [...], current_index}` | Queue changed |
| `"video:change"` | `{media_item, index}` | New video to load |
| `"presence_state"` | Phoenix Presence format | Initial presence |
| `"presence_diff"` | Phoenix Presence format | Presence deltas |
| `"chat:message"` | `{user_id, username, text, timestamp}` | Chat |

### Late joiner reconciliation

When a client joins, the server computes the expected current position and pushes a full state snapshot:

```elixir
def handle_info(:after_join, socket) do
  room_id = socket.assigns.room_id
  state = RoomServer.get_state(room_id) # returns computed current_position
  push(socket, "sync:state", state)
  {:noreply, socket}
end
```

The client performs an initial clock sync burst (5 probes, 100ms apart), then seeks to `state.current_time + ((performance.now() + clockOffset - state.server_time) / 1000)` if playing. This accounts for the time elapsed between the server computing the position and the client receiving it.

### Queue management

```elixir
# Auto-advance on video end
def handle_cast(:video_ended, state) do
  if state.settings.auto_skip_on_end do
    next = state.current_index + 1
    if next < length(state.queue) do
      new_state = %{state |
        current_index: next, current_time: 0.0,
        play_state: :playing,
        last_sync_at: System.monotonic_time(:millisecond)
      }
      Phoenix.PubSub.broadcast(WatchParty.PubSub, "room:#{state.room_id}",
        {:video_change, Enum.at(state.queue, next), next})
      {:noreply, new_state}
    else
      {:noreply, %{state | play_state: :ended}}
    end
  else
    {:noreply, %{state | play_state: :paused}}
  end
end

# "Add next" vs "Add to bottom"
def handle_cast({:queue_add, item, "next"}, state) do
  insert_at = (state.current_index || -1) + 1
  new_queue = List.insert_at(state.queue, insert_at, item)
  {:noreply, %{state | queue: new_queue}}
end

def handle_cast({:queue_add, item, "bottom"}, state) do
  {:noreply, %{state | queue: state.queue ++ [item]}}
end
```

Debounce rapid seeks server-side — track `last_seek_at` in state and reject seeks within 500ms of each other.

---

## Room IDs and username generation

### Room IDs: Nanoid

Use `{:nanoid, "~> 2.1"}` from Hex. **8-character alphanumeric** gives ~2.8 trillion combinations — vastly more than enough for ephemeral rooms while keeping URLs short and shareable:

```elixir
def generate_room_id do
  Nanoid.generate(8, "0123456789abcdefghijklmnopqrstuvwxyz")
end
# => "k8f3m2x9" → URL: https://yourapp.com/room/k8f3m2x9
```

For friendlier URLs, use an `adjective-noun-number` pattern: `"cosmic-falcon-742"`. This is memorable and paste-friendly. Either generate these yourself from word lists or use a library.

### Usernames: Random human-readable names

Use `{:unique_names_generator, "~> 0.2"}` from Hex:

```elixir
UniqueNamesGenerator.generate([:adjectives, :animals], style: :capital, separator: " ")
# => "Lavender Marlin"
```

Or a zero-dependency DIY approach:

```elixir
defmodule WatchParty.NameGenerator do
  @adjectives ~w(Happy Swift Brave Calm Bold Chill Cosmic Sunny Clever Wild)
  @animals ~w(Panda Fox Wolf Hawk Otter Raven Lynx Tiger Eagle Bear)
  def generate do
    "#{Enum.random(@adjectives)}#{Enum.random(@animals)}#{:rand.uniform(99)}"
  end
end
# => "SwiftHawk42"
```

Store the username in `socket.assigns` and Presence metadata. On rename, update Presence meta via `Presence.update/4` — the `presence_diff` propagates automatically.

---

## Lessons from open-source reference implementations

### CyTube (Node.js, MIT, github.com/calzoneman/sync)

The most mature open-source watch-party. Server-authoritative with a virtual countdown timer that auto-advances through the playlist. Supports YouTube, Twitch, Vimeo, Dailymotion, Google Drive, SoundCloud, and direct files. Uses Socket.IO. Has a **rich permissions model** — numeric ranks (Guest 0, User 1, Mod 2, Admin 3, Owner 5+, Site Admin 255) with per-action minimum rank thresholds. Channels persist in MySQL. Queue supports temporary items (auto-removed after playing) and voteskip. **Key lesson**: The timer-based sync model where the server ticks position forward is elegant and simple — GenServer is a natural fit for this pattern since it can use `Process.send_after` for periodic state broadcasts. CyTube uses hard-seek only (no playbackRate correction), with a user-configurable sync threshold defaulting to ~2 seconds.

### OpenTogetherTube (TypeScript, MIT, github.com/dyc3/opentogethertube)

Modern TypeScript monorepo with Vue 3 frontend. Has a **service adapter pattern** for video sources — an Info Extractor pipeline that resolves URLs to metadata (title, duration, thumbnail). Supports YouTube (+ Invidious fallback), Vimeo, Google Drive, Reddit, PeerTube, Odysee, PlutoTV, Tubi, direct video URLs, HLS/DASH. Caches video metadata in PostgreSQL (30-day TTL) and search results in Redis (24hr TTL). **Key lesson**: The URL → MediaItem resolution pipeline is worth replicating. Also has SponsorBlock integration, vote mode, and DJ mode (loop single video). Architecture: Client Manager → Room Manager → Room → Info Extractor. Room state is in-memory, not persisted.

### Syncplay (Python, Apache 2.0, github.com/Syncplay/syncplay)

The gold standard for sync algorithms. JSON over TCP. Focuses on syncing locally-opened files (no queue/playlist). Has the `ignoringOnTheFly` feedback loop prevention — when a user triggers play/pause/seek, an incrementing counter prevents the originator from re-processing their own change as it bounces back. Uses moving-average RTT smoothing. Server computes the "slowest" client and makes faster clients slow down. **Key lesson**: The `ignoringOnTheFly` pattern is the formal version of the suppress flag, and it's worth implementing properly. Also: 4-second heartbeat timeout for disconnect detection.

### Jellyfin SyncPlay (C#, GPL-2.0)

Integrated into Jellyfin media server. Uses **time-scheduled commands** — the server tells clients *when* to execute an action (a future timestamp) rather than "do it now". This is more sophisticated than the immediate-broadcast model and handles network jitter better. Well-documented threshold parameters. **Key lesson**: The two-tier correction (speed first, seek fallback) with max retry counts prevents thrashing. The `sync_speed_attempts: 3` limit before fallback to seek is a good guard against edge cases where playbackRate adjustment can't converge.

### n.eko (Go, Apache 2.0, github.com/m1k1o/neko)

Remote browser approach. Runs a full desktop/browser inside Docker, streams via WebRTC at <300ms latency. Sidesteps the entire sync problem — one browser, one video source, all viewers see the same stream. Supports admin/participant roles, clipboard sync, RTMP broadcasting, session recording. **Key lesson**: If you eventually want to support DRM content without requiring users to install an extension, this is the architecture. It's expensive to host but eliminates cross-origin headaches entirely. Can be spun up per-room and torn down when empty, fitting the ephemeral room model.

**No existing Elixir/Phoenix watch-party project was found.** This is greenfield in the Elixir ecosystem.

---

## Deployment and scaling

### Single-node (recommended for MVP and medium scale)

All rooms live in memory as GenServer processes. Phoenix handles **2M+ concurrent WebSocket connections** on a single node — this is more than enough for a watch-party app where each room has 2–20 users. Deploy with `mix release` + Docker to Fly.io:

```toml
# fly.toml
[mounts]
  source = "data"
  destination = "/app/data"  # For SQLite if used
```

If using SQLite for room persistence across deploys, mount a Fly persistent volume. Single-writer constraint is fine for single-node.

### Multi-node (when needed)

Phoenix.PubSub with the `:pg` adapter (default) broadcasts across nodes automatically via distributed Erlang. Use `dns_cluster` (built into modern Phoenix apps) for auto-discovery:

```elixir
{DNSCluster, query: Application.get_env(:watch_party, :dns_cluster_query) || :ignore}
```

Room GenServer processes exist on **one node only**. Use `Phoenix.PubSub` to route channel messages to the correct node. For room discovery across nodes, swap `Registry` (local-only) for `:global` or use `Horde.Registry` (CRDT-based distributed registry from the `horde` hex package). Fly.io handles sticky sessions for WebSocket connections via the `fly-replay` header.

For a watch-party app, **single-node is sufficient for thousands of concurrent rooms**. Multi-node is only needed for geographic distribution or extreme scale. Don't over-engineer this at the start.

---

## Recommended hex packages

| Package | Version | Purpose |
|---|---|---|
| `phoenix` | `~> 1.8` | Framework |
| `phoenix_live_view` | `~> 1.1` | Server-rendered UI + JS hooks |
| `phoenix_html` | `~> 4.2` | HTML helpers |
| `jason` | `~> 1.4` | JSON codec |
| `bandit` | `~> 1.2` | HTTP server |
| `nanoid` | `~> 2.1` | Short room IDs |
| `unique_names_generator` | `~> 0.2` | Random usernames |
| `dns_cluster` | `~> 0.1` | Erlang clustering |
| `ecto_sqlite3` | `~> 0.17` | SQLite (only if persistence needed) |

JS-side: `phoenix` and `phoenix_html` npm packages (ship with Phoenix), plus the YouTube IFrame API loaded from `https://www.youtube.com/iframe_api`. For Vimeo, `@vimeo/player` from npm. Reference `react-player` (cookpete/react-player) for the multi-player abstraction pattern — it normalizes YouTube, Vimeo, Twitch, SoundCloud, Dailymotion, and raw files behind a single interface.

---

## Conclusion

The critical technical insight driving this entire spec is that **cross-origin DOM access is impossible without a browser extension**, and DRM makes proxy approaches non-viable for streaming sites. The architecture must be honest about this constraint. The three-tier player model — embedded APIs for YouTube/Vimeo/Twitch, a minimal extension for DRM sites, WebRTC screen sharing as a universal fallback — is the same architecture every successful watch-party product converges on, from w2g to Teleparty to Kosmi.

The Elixir/Phoenix stack is a near-perfect fit for this domain. GenServer naturally models room state with serialized access (no race conditions on play/pause/seek). `DynamicSupervisor` + `Registry` gives you ephemeral room lifecycle with zero boilerplate. Phoenix Channels with topic-based pub/sub is exactly the broadcast model needed. Phoenix Presence provides CRDT-based user tracking that works across distributed nodes. The BEAM's fault tolerance means a crashed room process restarts cleanly without affecting other rooms. And LiveView + JS hooks gives you server-rendered UI for everything except the inherently-client-side video player interaction — the best of both worlds with minimal JavaScript. Start single-node on Fly.io; the architecture scales to multi-node via `dns_cluster` + `Phoenix.PubSub` when needed, without architectural changes.