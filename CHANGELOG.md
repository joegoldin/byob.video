# byob Changelog

---

# v5.0.0

**Revert to v3.6.3 sync engine + targeted improvements.**

The v4.x reconcile loop caused cascading issues on sites with DRM/buffering transitions. This release reverts to the proven v3.6.3 suppression-based sync engine and adds focused improvements.

### Drift correction
- **250ms drift tolerance** with proportional rate correction (0.9–1.1x). Hard seek for >3s drift.
- **1s correction interval** (was 5s) — server sends expected position every second for tight sync.
- **Follower mode:** Joining clients are read-only until stable (position+state match server for 3 consecutive ticks). Prevents join process from disrupting existing clients.

### Sync bar improvements
- **Debounced status display:** Brief DRM pauses don't flicker "Paused" — requires 2 consecutive paused updates.
- **Bar updates only when synced:** Unsynced clients don't send bar updates (prevents seek bar flickering).
- **Auto-play on join:** `command:play` tries `play()` even during `needsGesture` — if browser allows it, syncs immediately without manual click.

### Time-window suppression
- **Absorbs ALL matching events** for 1.5s instead of just the first. Sites with DRM/buffering fire multiple play/pause during transitions — all suppressed.

### Details for nerds
- **Per-client sync stats panel** in room settings: drift (ms, color-coded), server position, play state.
- Updates every 1s correction cycle.

### Backported from v4.x
- **innerHTML removed:** All `innerHTML` replaced with DOM creation methods (AMO compliance).
- **Persistence crash recovery:** `binary_to_term` wrapped in try/rescue; validates required fields.
- **Computed position on sync:** Returns `current_time + elapsed` for playing rooms.
- **Position-based ended detection:** Requires duration >60s and position >90%.
- **Video element replacement guard:** Resets `synced=false` on element swap.
- **Connection cooldown (3s):** Prevents reconnection storms.
- **Tab closing:** Extension tabs close on queue advance/end.

### Known issues
- **Ready count:** May show incorrect counts during join (autoplay triggers premature `video:ready`). Cleanup on disconnect may not always propagate.

---

# v4.1.0

**Extension sync engine: NTP clock sync, reconcile loop, drift correction, buffering detection.**

### Reconcile loop
- **Single reconcile loop** (500ms tick) handles play/pause mismatch, buffering/stall detection, position drift, and paused position correction.
- **Debounced play/pause** (500ms): rapid site toggles (DRM, buffering transitions) cancel each other out. Only stable state changes reach the server.
- **State-change-only filter:** `onVideoPlay`/`onVideoPause` only send events that change `expectedPlayState`. Redundant confirmations from the site are silently dropped.
- **Paused position correction:** Both clients paused but different positions → hard seek to server position.
- **Playing drift correction:** Proportional playback rate (0.9–1.1x) for small drift, hard seek for >5s. Respects recent user seeks (no hard-seek for 5s after user action).

### Buffering detection
- **Stall-based detection:** If video position frozen for 1.5s (3 ticks), enters buffering state. Suppressed during settling (3s after join) and after seeks (5s buffer time).
- **Server pause on buffer:** Pauses server so other clients wait. `_bufferingPause` flag prevents the buffering client from fighting its own pause echo.
- **Buffer clear:** Resumes server from current position. Requires 3s of sustained playback before clearing.
- **Buffer timeout (10s):** Accepts site's actual position if stuck, seeks server to match.
- **Position-based ended detection:** Replaces browser `ended` event (unreliable on third-party sites). Checks `position >= duration - 3` with `duration > 60` guard.

### NTP clock sync
- **5-probe burst on connect**, median offset selection. 30s maintenance re-sync.
- **Synced clock for drift computation:** `serverMonotonic ≈ Date.now() + clockOffset`.
- **RTT reporting:** Each client reports RTT; room tolerance widens to 500ms if any client > 250ms.
- **Clock-sync gate:** Drift correction only runs after clock sync completes. Stall detection runs immediately.

### Server-authoritative model
- **Server timestamps on all commands:** play/pause/seek/correction include `server_time` (monotonic ms). Stale messages rejected.
- **Computed position on sync:** `sync:request_state` and join payload return `current_time + elapsed` for playing rooms.
- **Per-tab user ID:** `ext_user_id:tab_id` so two tabs in one browser are separate sync clients.
- **Adaptive command guard:** Holds until site settles (play state matches expected) for incoming server commands. Fixed guard for seeks.
- **3s settling period after sync:** Suppresses contradictory events during site initialization on join.

### Infrastructure
- **Connection cooldown (3s):** Prevents reconnection storms from cascading socket failures.
- **Delayed clock sync (2s):** NTP burst starts after connection stabilizes.
- **Persistence crash recovery:** Gracefully discards incompatible saved room data; validates required fields.
- **Debug logging:** `[byob]` logs in devtools + `[ext:debug]` in server terminal. Anonymized user IDs (SHA-256 8-char prefix).
- **Details for nerds panel** in room settings: sync tolerance, correction interval, per-client RTT.
- **Tab closing:** Extension tabs close when queue advances after autoplay countdown or queue ends.
- **innerHTML removed:** All `innerHTML` replaced with DOM creation methods (AMO validation).

### Known issues
- **Dual-tab same-browser:** Two tabs sharing one service worker (normal + incognito) can interfere during the second tab's join process. Needs "active player" tracking in the SW.
- **Seek-hostile sites:** Some streaming sites (e.g., aniwave) don't honor `currentTime` seeks, causing position mismatches that trigger cascading corrections.

---

# v4.0.1

- **Buffering overlay fix:** Overlay never appeared on third-party sites because the video runs in an iframe but the overlay only renders in the top frame. Added `byob:local-buffering` relay from iframe → service worker → top frame for instant overlay display.
- **Buffering field forwarded:** `background.js` was stripping the `buffering` field when relaying `video:state` to the server channel. Other clients never received buffering notifications.
- **Buffering clear messages:** `onVideoCanPlay` and `resolveCommandGuard` now immediately send `buffering: false` via port so the overlay clears promptly (was waiting up to 500ms for the next state report).

---

# v4.0.0

**Architecture overhaul: replace suppression/cooldowns with SW-level echo prevention + adaptive command guard.**

### Echo prevention
- **Service worker port filtering:** `broadcastExceptOrigin()` tracks which port originated each play/pause/seek and skips echoing the server response back to that port. Replaces all client-side suppression/cooldown logic.
- **Adaptive command guard:** After every play/pause/seek command, a 500ms guard blocks outgoing events. After 500ms, checks if video state matches expected state — if mismatched, enters buffering mode and keeps checking every 200ms until resolved.

### Buffering detection
- **State mismatch approach:** Buffering = "expected playing but video is actually paused." Detected by the adaptive command guard after commands, and by native `waiting`/`canplay` events for mid-stream buffering.
- **Cross-client overlay:** When one client buffers, a purple spinner overlay appears on all clients. Relayed via `sync:buffering` channel event.
- **Local buffering relay:** Iframe → service worker → top frame relay ensures overlay displays correctly on sites where video is in an iframe.

### State reconciliation
- **200ms reconciliation loop:** Continuously compares actual video state against expected play state. After 1s mismatch, attempts correction. If `play()` fails (autoplay policy), drops to gesture-required state.
- **Constants refactor:** All magic strings in content.js replaced with frozen constant objects (State, SyncStatus, Msg, El, Hosts, Color, Copy, Evt, Tag).

---

# v3.6.3

- **Extension sync fix:** Seek suppression used `suppress(null)` which swallowed ALL subsequent events (play/pause) after a seek. Now uses distinct `"seeked"` state so only seeked events are suppressed.
- **Extension pause enforcer fix:** Enforcer no longer calls `suppress()` on each tick, which was resetting suppression every 200ms and swallowing user play/pause events. Play cancels the enforcer immediately.
- Deduplicate activity log entries (same user+action within 2s is suppressed — fixes double "joined" from longpoll→websocket upgrade)
- Removed favicon from all header bars (root layout + room nav)

---

# v3.6.2

- Updated logo and favicon
- Removed favicon from header bar (text logo only)
- Fixed visibility change handler pushing `time` instead of `position` (caused crash on tab return from background)

---

# v3.6.1

**Bugfixes + embeddable filter.**

- **Auto-pause on empty room:** When all users disconnect (including non-clean exits like killing the browser), the room auto-pauses and freezes the position. No more video "playing" in the background GenServer with nobody watching.
- **Non-embeddable video filter:** YouTube Data API now requests the `status` part to check the `embeddable` flag. Non-embeddable videos are filtered during pool ingestion so they don't appear in roulette/voting.
- **Vimeo preview card:** URL bar now shows Vimeo preview (was only matching YouTube). Homepage and URL dropdown list Vimeo as a supported source.
- **Queue scroll fix:** Queue panel wrapper was missing flex layout classes, preventing overflow scroll.

---

# v3.6.0

**Extension sync overhaul, Vimeo support, debug logging.**

### Vimeo embed support
- **Vimeo player:** Paste a Vimeo URL and it embeds natively — play, pause, seek, sync, duration, thumbnails. Uses the Vimeo Player SDK. URL preview shows title, thumbnail, and duration in the search bar.
- **Vimeo oEmbed:** Server-side metadata fetch via `vimeo.com/api/oembed.json`. Query params stripped to avoid Vimeo API rejections.

### Extension sync overhaul
- **Autoplay gesture flow:** Third-party sites (Crunchyroll, Dailymotion, etc.) blocked programmatic `video.play()`. Extension now shows a purple "Play the video to start syncing" toast and waits for the user's natural play click. One-click flow, DRM-safe.
- **Sync bar controls:** Play/pause button, clickable progress bar with purple fill, time counter. Only visible after sync. "Finished — next in 5s" countdown on video end.
- **Ready count indicator:** Shows `ready/total` with person icon (gray → green). Per-tab tracking via explicit `video:tab_opened`/`video:tab_closed`/`video:ready` messages. Tooltip details: "1 of 2 ready · 1 needs to click play".
- **Page metadata scraping:** Extension scrapes title/thumbnail from external pages (Crunchyroll-specific selectors + generic OG fallback), updates queue/history items on byob.video.
- **Stability:** Auto-reconnect on Chrome MV3 service worker restart. Tab-scoped `command:synced` (iframe → top frame, not cross-tab). Stale extension user cleanup on rejoin. bfcache error suppression.
- **Extension user hidden:** Extension connections use real username and are filtered from the room user list and count.

### YouTube sync fixes
- **Stutter fix:** Joining a paused room used `cueVideoById` (thumbnail only); resuming caused load-from-scratch → buffering → echo loop. Now uses `loadVideoById` + immediate pause.
- **Suppression overhaul:** Time-window suppression auto-clears via setTimeout 200ms after terminal state (was stuck for 3s safety timeout). Player readiness gate (`_playerSettled`) set before suppression check so events aren't blocked during load. `checkAndRetry` stops once player settles.
- **Ended state:** Heartbeat no longer overrides `expectedPlayState` after video ended, preventing restart during autoplay countdown.

### Infrastructure
- **Debug logging:** New `Byob.SyncLog` module. Video URLs SHA-256 hashed (12-char prefix). Logs play/pause/seek/join/heartbeat. Extension channel events logged. Dev logger set to info level with timestamps.
- **HTML entity fix:** OEmbed title extraction decodes `&#039;`, `&amp;`, numeric entities.
- **Voting fix:** Votes broadcast immediately (removed throttle). Early-close excludes extension users. Roulette winner text hidden until animation completes; reveal delay increased to 8s.
- **Queue scroll fix:** Queue panel wrapper missing flex layout classes, preventing scroll.

---

# v3.5.1

**Roulette polish + sync hardening.**

- **Roulette:** 3-second "Loading candidates…" overlay at the start of a round so users see the panel mount and have time to scroll down. Slice text now runs radially (aligned with each pie slice, flipped on the left half so glyphs stay left-to-right) with two-line word-aware splitting — up to ~36 chars legible per slice. Voting picks **5** candidates; roulette stays at **12**. Server scrolls the round panel into view on `:round_started` when nothing is currently playing (no queue, ended, or fresh room).
- **Roulette physics:** `Byob.RoomServer.Round.simulate_landing_slice/2` ports the same exponential-decay formula the JS hook runs, and the server uses its result to pick the winner — whichever slice the physics lands on **is** the winner, rather than picking first and solving physics to match. Identical IEEE 754 arithmetic in Elixir and JS produces bit-identical slice indexes on both sides. Winner slice gets a yellow outline + glow pulse only after the ball fully settles; a pie-slice countdown (same visual as the autoplay one) runs until the server finalizes and enqueues.
- **Fix:** clicking **Play Now** on a new video while the previous video was in its autoplay countdown dropped the user onto the "Queue finished" screen five seconds later (the countdown timer fired and advanced past the just-added video). Now any `add_to_queue` that replaces the now-playing item cancels the pending advance + broadcasts `:autoplay_countdown_cancelled`.
- **Fix:** YouTube player states `-1` (unstarted) and `5` (cued) render as a static thumbnail but were returned as `null` from `getState()`. The reconciliation loop skips null-state checks, so a player stuck on the thumbnail never got force-played. Both states now map to `"paused"` — if the room's expected state is `"playing"`, the 500 ms mismatch gate kicks in and force-plays. Likely root cause of the reported "my friend was paused while I was playing" desync.
- **Fix:** if the YouTube player stays in `"buffering"` for more than 5 seconds while expected state is `"playing"`, seek to the server's expected position and force-play. Prevents infinite-buffer stalls from blocking sync.
- **Fix:** on tab becoming visible again after backgrounding, resync the clock (3 fresh probes) and echo current local state (`video:play` / `video:pause`) back to the server. Prevents throttled-timer-induced desync in backgrounded tabs.
- **Video help:** first time a browser blocks autoplay and the "Click to join playback" overlay shows, we now also open a one-time help dialog with browser-specific instructions (Chrome/Edge/Firefox/Safari) for enabling autoplay on byob.video. "Don't show again" defaults to checked, persisted in `localStorage`.
- **Comments layout:** `min-h-[220px]` on mobile, flex-fill on desktop (removed the `lg:min-h-[260px]` that was overflowing the main column and breaking the sidebar's sticky scroll).
- **Ops:** `YOUTUBE_API_KEY` is now read in all envs (was prod-only) so dev can populate the pool. Test suite writes to a dedicated `priv/byob_test.db` so pool test seeds can't leak into dev.
- **Infra:** Fly instance scaled to 1 GB RAM.

---

# v3.5.0

**Roulette & Voting modes.** Two new ways to pick a video in a room:

- **Roulette** — click 🎰 in the room nav to open a shared wheel of 12 random candidates. Each candidate appears first as a readable card over the wheel, then shrinks into its slice. The ball orbits and physics-lands on the winner (exponential angular friction + inward spiral + damped pocket-bounce). Winner slice glows, a pie-slice countdown runs, then the winner auto-enqueues.
- **Voting** — click 🗳️ for a 15-second vote. Everyone can vote for any candidate. Highest-tally winner enqueues; random tiebreak; empty rounds end cleanly.

**Candidate pool.** Background `Byob.Pool.Scheduler` GenServer scrapes three sources on a schedule and writes to a new `video_pool` SQLite table:
- YouTube Trending (US, hourly + jitter)
- Reddit top-of-day from `r/videos`, `r/mealtimevideos`, `r/deepintoyoutube`, `r/listentothis` (hourly + jitter)
- 12 hardcoded curated playlists (daily + jitter)

Pick uses weighted sampling: **14-day freshness decay** (curated exempt) × **30-day repeat decay** on `last_picked_at`, so the same video rarely resurfaces soon after it's been picked in any room.

**Non-intrusive UI.** Round panel slots above the YouTube comments in the main column — never modal, never interrupts playback. Per-user collapse button. Only the starter can cancel an active round. Winner enqueues silently; activity log captures `:roulette_started / :roulette_winner / :vote_started / :vote_winner / :round_cancelled`.

**Ops.**
- `YOUTUBE_API_KEY` now loads in all envs (was prod-only) so dev can populate the pool.
- Test suite uses a dedicated `priv/byob_test.db` so test seeds can't leak into the dev DB.

---

# v3.4.19

- Server persistence now snapshots the **computed current position** (not the stale `current_time` field from the last event) plus a wallclock timestamp. On restart, the load path advances the position by elapsed wallclock for videos that were playing — so a fresh process picks up within seconds of where it actually was, not where it was at the last play/seek event.
- `play_state` from the persisted state is **preserved** on load (was previously always reset to `:paused`). If the room was playing when the deploy happened, it resumes playing from the advanced position.
- Persist interval **30s → 5s** for fresher disk state in the worst-case "deploy right before a scheduled persist" window.
- `schedule_sync_correction` is started on restore when the loaded state is `:playing`, so drift-correction broadcasts resume immediately on restart.
- Defensive: load path uses `Map.merge` so older persisted struct shapes (missing newer fields like `:pending_advance_ref`) load cleanly instead of `KeyError`-ing on init.

---

# v3.4.18

- On LiveView reconnect (e.g. after a server deploy), the client now pushes its current local play state and position back to the server via `video:play` / `video:pause`. Rationale: after a deploy the server reloads from SQLite with `play_state: :paused` and a possibly stale `current_time` (up to 30s old, or 0 if the video started recently). Without this echo, no one ever told the server the real position — so a fresh-joining tab would `sync:state` down the stale value. Combined with v3.4.17's is-a-real-transition guard on `:play`, the echo is safe: it's accepted when the server needs updating, ignored when it's already in sync.
- Added a `console.debug("[byob] _loadVideo", …)` diagnostic so the computed `startSeconds`, server-reported `current_time`, and clock-sync offset show up in browser devtools. Temporary aid for tracking the remaining edge cases in the refresh-after-deploy path.

---

# v3.4.17

- Server resilience: `:play` / `:pause` handlers now only update `current_time` on a real state transition (paused → playing, playing → paused). A client that's already seeing the video as playing and echoes `video:play` again can no longer overwrite the room's position. This is why the v3.4.16 refresh fix only worked once **everyone** refreshed — pre-v3.4.16 clients were sending position=0 back to the server during normal playback, and the server happily accepted it, poisoning state for fresh joiners. Seek events still update position explicitly.

---

# v3.4.16

- Fix: YouTube `onReady` callback now receives the wrapped player so the hook can assign `this.player` BEFORE `_applyPendingState` runs. Previously the onReady fired synchronously inside the `YT.Player` event — while the hook was still blocked on the `await YouTubePlayer.create(...)` — so `this.player` was still the old/null value and the initial `_seekTo` / `_play` in `_applyPendingState` were no-ops. This was the root cause of refresh-starts-at-0 and refresh-doesn't-autoplay.

---

# v3.4.15

- Fix: reconcile loop's "resync-before-hard-seek" safety check was swallowing every hard seek. Each tick with drift > 2s triggered a fresh NTP burst instead of seeking, then the next tick saw the still-huge drift and triggered another burst — infinite loop, never actually seeking. Now after a recent resync (< 3s ago) the reconcile loop trusts the drift measurement and performs the hard seek. This is why a refreshed client could stay stuck out of sync: the reconcile's self-correction was disabled.

---

# v3.4.14

- Fix (for real this time): page refresh during active playback now starts the YouTube embed at the correct position directly, via the `start` playerVar. Previously the embed loaded at 0 and we relied on a post-load `seekTo` — which got swallowed when autoplay was blocked or the player wasn't yet in a seekable state. The reconcile loop still tightens sub-second drift after load.

---

# v3.4.13

- **Server-driven autoplay countdown**: when a video ends, the server waits 5s before advancing to the next item. Clients render a bottom-right pie-slice overlay that fills clockwise over 5s, with the remaining seconds in the middle. All clients see the same countdown — no client-side timers, no race conditions, no duplicate log entries if multiple clients report `video_ended` for the same index.
- Fix: skip / play-index during an active countdown cancel it and advance immediately (or jump to the clicked item)
- Fix: refresh-during-playback starting from 0 instead of syncing to the current position — `_applyBufferedState` now sets `_pendingState` BEFORE calling `_loadVideo`, so the YouTube embed URL is generated with autoplay=1 when the server says the video is playing
- Fix: right sidebar stretches the whole page when comments are expanded — constrained to `lg:h-[calc(100vh-3.5rem)]` + `lg:sticky top-0 self-start` so it stays viewport-height regardless of main column height

---

# v3.4.12

- Activity log: new `:finished` event recorded whenever a video naturally ends ("Finished: <title>"), rendered with a ✓ icon. Skipping is unchanged — it continues to log `:skipped`.

---

# v3.4.11

- Fix: activity log now records the auto-advance to the next queue item when a video ends naturally ("Now playing: <title>"). Previously `advance_queue` was silent — only the very first auto-start (empty queue → first item) logged it.

---

# v3.4.10

- Tooltip on the comments expand button: "Expand comments viewer" / "Hide comments viewer" — uses daisyUI `tooltip tooltip-left` so it appears on hover without the 1–2s native `title` delay

---

# v3.4.9

- Activity log: clicking a queue item now records a distinct `played` event ("user played <title>") with a primary-colored play icon, instead of misleadingly reading "user resumed <title>"

---

# v3.4.8

- Sync: RoomServer broadcasts a lightweight state heartbeat every 5s. Clients adopt the server's `play_state` if theirs disagrees, and refresh the reconcile loop's reference point so drift extrapolation stays accurate between natural state changes. Any client that missed a broadcast (reconnect, transient drop, backgrounded tab) now self-heals within 5s — no need to wait for the next play/pause/seek event.

---

# v3.4.7

- Fix: "click play on next video" required after deploy — the auto-reload on disconnect was triggering after just 5s, destroying the YouTube iframe and losing the autoplay permission granted by earlier user gesture. Bumped the threshold: **30s when idle**, **120s while a video is actively playing**. LiveView normally reconnects in seconds after a deploy, so in the common case no reload happens and playback continues uninterrupted — the VideoPlayer hook's `reconnected()` callback handles resync on top of the existing iframe.

---

# v3.4.6

- Context menu: "Re-add to Queue" renamed to just "Add to Queue"
- Comments expand now clamps to a fixed 400px tall with internal scroll (was min-height 500px, which grew to fit all comments)

---

# v3.4.5

- Richer right-click context menu per item type:
  - Now Playing: Restart, Copy URL
  - Up Next: Play Now, Remove from Queue, Copy URL
  - History: Play Now, Add to Queue, Copy URL
- Fix URL extraction when two URLs are concatenated with no separator (e.g. pasting `https://youtu.be/ahttps://youtu.be/b`) — the last URL now wins instead of the whole string being treated as one garbage URL

---

# v3.4.4

- Video duration badge overlaid on thumbnails in the URL preview card, Now Playing, Up Next, and History (YouTube-style, bottom-right)
- URL preview shows channel name · "2 years ago" style relative upload date under the title
- New `Byob.YouTube.Videos` module fetches duration and `publishedAt` via the Data API with 24h ETS cache; falls back to oEmbed if the API key is missing or quota is out
- Fix: expand (+) button on the comments panel now uses a ResizeObserver instead of a Tailwind media query — shows whenever the panel is actually cramped, regardless of viewport height or aspect ratio
- Fix: right-click context menu now works on the Now Playing item and History items (was only Up Next)
- Fix: activity log now records a "play" event when you click an item in the queue (was silent)

---

# v3.4.3

- Sync: NTP maintenance every 10s (down from 30s) so drift is caught faster
- Sync: 3-probe mini-burst on `visibilitychange` — catching up to a backgrounded tab no longer needs a hard snap
- Sync: 3-probe mini-burst before any hard seek confirms "this is real drift, not clock skew" before yanking the playhead
- Sync: proportional `playbackRate` correction (scaled to drift size) replaces fixed 0.95/1.05 — smoother approach to zero, no overshoot
- Sync: rolling median over the last 5 drift samples kills instantaneous jitter, lower dead zone (50ms) for faster reaction
- Sync: direction-stability gate prevents rate-correction rubber-banding when drift crosses zero
- Fix custom right-click menu on queue items: switched hook from `oncontextmenu` property to `addEventListener` with proper teardown

---

# v3.4.2

- Play Now / Queue now blur the input so dropdowns close cleanly
- Loading skeleton no longer pulses transparent (only the gray shapes animate)
- Expand (+) button in bottom-right of comments on short viewports: click to make the comments panel taller and allow the page to scroll; click again (rotated to x) to collapse back
- The button only shows when the viewport height is under 800px, or when comments are already expanded

---

# v3.4.1

- Fix Play Now / Queue using stale URL when clicked before the 300ms debounce (form now submits with the current input value — no more "first URL wins when you paste a second")
- Fix UI sticking in a loading skeleton when the YouTube oEmbed fetch fails — preview now renders with a fallback title and working Play Now / Queue
- Fix overlapping dropdowns: the supported-sites hint no longer renders behind the error card, and only shows when the input is empty
- Dropdowns (hint, skeleton, preview, error) hide when the URL field isn't focused

---

# v3.4.0

- URL input dropdown now opens instantly on focus (CSS-driven, no server round-trip)
- Loading skeleton appears on the first keystroke, not after the 300ms debounce
- Error card explains why a URL was rejected:
  - byob room links (common accidental paste): "That's a byob room link — paste a video URL instead."
  - DRM-protected services (Netflix, Disney+, Max, Hulu, Prime Video, Apple TV+, Peacock, Paramount+): "{Service} uses DRM and can't be synced."
  - Non-URL / invalid input: "Doesn't look like a video URL."
- Paste support for URLs inside arbitrary text — the last `http(s)://` URL in the field is used, with trailing punctuation trimmed
- Play Now / Queue / Enter submit the extracted URL, so `hey watch this https://youtu.be/abc` works
- Hitting Enter on invalid input is a silent no-op (the error card already explains why)

---

# v3.3.5

- Keep Fly.io machine always running (disable auto-suspend, min 1 machine) — no cold-start delay on first visit

---

# v3.3.4

- Fix clear button visibility during focus/re-render (stable DOM id + client-side toggle)

---

# v3.3.3

- Clear button visible while input is focused (no DOM churn on re-render)

---

# v3.3.2

- Clear button stays visible while input is focused
- Fix clear button vertical centering in URL input

---

# v3.3.1

- Fix clear button vertical centering in URL input

---

# v3.3.0

- Clear button (x) on the right side of the URL input bar

---

# v3.2.0

- Per-browser toggle to show/hide YouTube comments (persisted in localStorage, configurable in settings)
- Collapse/expand arrow on comments panel header (non-persistent, defaults to open)

---

# v3.1.3

- Restore gap between video player and comments panel
- Fix bottom padding alignment between comments and sidebar

---

# v3.1.2

- Fix sidebar bottom padding alignment with comments panel

---

# v3.1.1

- Fix comments panel alignment with player
- Cap comments at 300px on mobile, fill to window on desktop
- URL input text no longer clears when clicking away

---

# v3.1.0

- Comments panel fills to window height on desktop, capped at 40vh on mobile
- Comments persist across page reloads (re-fetched on mount)
- URL preview dropdown hides on blur without clearing data
- Extension required link detects browser and opens correct store page
- Theme toggle syncs with saved preference on page load
- Removed comment count from comments header

---

# v3.0.0

### Architecture refactor
- Split `room_live.ex` (1200 → 336 lines) into 7 focused modules: UrlPreview, Playback, Queue, Username, PubSub, Components, Comments
- Split `video_player.js` (1050 → 712 lines) into player modules (YouTube, Direct, Extension), SponsorBlock, toasts, queue finished screen
- Sync engine classes (ClockSync, Suppression, Reconcile) in separate ES modules
- Common player interface: create/play/pause/seek/destroy across all player types
- SQLite schema versioning with migration runner framework
- Scaling constraints documented in docs/scaling.md

### YouTube comments panel
- Always-visible scrollable comments section below the video player
- Fetched server-side via YouTube Data API v3 (requires YOUTUBE_API_KEY)
- ETS cache with 15-minute TTL per video
- Graceful quota degradation — panel silently hidden when daily quota exhausted
- "Load more" pagination
- Relative time formatting (2h ago, 3d ago, etc.)

### Fixes
- URL preview dropdown hides on blur (click away to dismiss)
- Fixed stale tests for queue behavior and room ID validation
- All 76 tests passing

---

# v2.0.7

- Queue finished screen shows video title and thumbnail instead of raw URL
- Default YouTube thumbnail at load time (no waiting for oembed)
- Push metadata updates to JS hook when oembed results arrive

---

# v2.0.6

- Activity log: "Now playing: TITLE (added by NAME)" for auto-play/queue start
- "resumed" instead of "played" for manual unpause
- No more "joe played" noise on auto-play
- Auto-play from empty queue logs "Now playing" properly

---

# v2.0.5

- CLAUDE.md project context for AI assistants with release workflow docs
- Concise README with extension store links

---

# v2.0.4

- Only log seeks >3s that don't start from 0:00 (filters video load, SponsorBlock skips, initial sync)
- Auto-detect extension install on embed-blocked page (polls, updates UI without refresh)
- Privacy policy clarifies server-side analytics only (no tracking cookies/pixels)

---

# v2.0.3

- Embed-blocked UI: detects extension, shows "Watch on YouTube" or "Get Extension" with correct store link
- Auto-detects extension install and updates UI without refresh (polls every 2s)
- No click-to-play overlay on embed-blocked videos
- Analytics for embed-blocked events with source_type
- Detect seeks while playing, suppress duplicate play/pause log spam
- Hide YouTube URLs in sidebar when title available
- Auto-reload page after 5s server disconnect
- Concise README with extension store links
- Updated privacy policy

---

# v2.0.2

- Detect seeks while playing (3s threshold) — no longer missed in activity log
- Suppress duplicate play/pause log entries (only log actual state transitions)
- Hide YouTube URLs in sidebar when title is available (cleaner queue display)
- Non-YouTube sites and titleless items still show URL
- Auto-suspend machine when idle, cap to 1 machine (cost savings)
- Auto-reload page after 5s server disconnect (deploy/restart)

---

# v2.0.0

## Analytics

- PostHog analytics integration for anonymous usage tracking
- Tracks: room creation/join, video source types, playback actions, extension detection
- Does NOT track: video URLs/titles, usernames, browsing history, any extension data
- Browser-level distinct_id (same person across tabs)
- Extension detection from page JS (not extension code) — no extension privacy changes needed
- Configurable via `POSTHOG_API_KEY` env var (disabled when not set)
- Updated privacy policy with full analytics disclosure
- Self-hosted instances have no analytics unless configured

---

# v1.4.3

- Seek events in activity log with from/to timestamps (e.g. "joe seeked 1:23 → 4:56")

---

# v1.4.2

- Deduplicate user list by username (no more stale/disconnected dupes)
- Prevent taking a username already in use by another user
- Activity log entries wrap (line-clamp-2) instead of truncating
- Activity log "added" entries update to show video title when metadata loads
- Timestamps show seconds (e.g. "at 5:42:03 pm")

---

# v1.4.1

- Fix Play Now / Queue buttons requiring multiple clicks (race condition between blur and form submit)
- Buttons now use phx-click with stored URL — no form submission, deterministic single-click behavior

---

# v1.4.0

## Queue management and embed fallback

- Clicking a queue item replaces now-playing (old item removed), all others stay as Up Next
- Play Now replaces now-playing, puts new video at front of queue
- Only auto-advance (video end) removes the finished item
- Age-restricted / embed-blocked YouTube videos: fallback UI with "Watch on YouTube" button and extension sync hint
- YouTube IFrame error codes 100, 101, 150 detected and handled

---

# v1.3.5

## Queue and sync improvements

- Played items removed from queue (moved to history only)
- Play Now removes the old now-playing from queue
- Clicking a queue item to play removes the previous item
- No more duplicate items in Now Playing and Up Next
- Autoplay permissions: `Permissions-Policy: autoplay=*` header + iframe allow attribute
- Click-to-play overlay when browser blocks autoplay on join
- Per-tab user IDs restored for correct sync (no more feedback loops between tabs)
- Multi-tab users show "(you)" and "(other tab)" labels
- Username changes apply to all tabs of the same user
- Activity log: newest at bottom, auto-scrolls, video titles on play/pause, local timestamps
- Deterministic preview dropdown (no blur timing hack)
- URL preview shows full title (up to 3 lines)

---

# v1.3.4

- Fix stale room_pid after deploy/restart: auto-reconnect via attach_hook
- Always assign user_id (fallback anon ID if session missing)
- Activity log shows video title for play/pause events
- Activity log timestamps in local time
- Prettier queue finished screen
- Revert muted autoplay hack (caused volume issues)

---

# v1.3.3

- Fix Fly.io deploy health check: add `/health` endpoint excluded from force_ssl
- SSL redirect was causing health check redirect loop (301 to external domain)

---

# v1.3.2

- Fix double-skip on video end (position detector + YT_ENDED both fired)
- Deduplicate ended events via `_endedFired` flag and server-side index matching

---

# v1.3.1

- Muted autoplay fallback when joining a playing room (Chrome allows muted autoplay)
- Auto-unmute once playback starts
- Fly.io health check grace period to suppress startup warning

---

# v1.3.0

## Activity log, toasts, and queue polish

- Activity log in sidebar: tracks joins, leaves, play/pause, queue adds, skips, renames
- Toast notifications at bottom of screen for room events
- Right-click context menu on queue items: shows URL (grayed) + Copy URL
- Hide URLs from queue display (title only, URL via context menu)
- Smaller text for Up Next and History items
- Simplified duplicate tab notice (non-blocking)
- Attribution: Phoenix, daisyUI, Tailwind CSS credits in settings

---

# v1.2.0

## Queue UX and tab management

- Reuse YouTube player instance on queue selection — autoplay works without requiring a click
- "Finished playing" screen when queue ends, showing last video thumbnail and title
- Queue ended state clears "Now Playing" in sidebar
- Duplicate tab detection: new tab takes over, old tab gets disabled overlay with "Use this tab instead" button
- Per-browser user identity (all tabs share one user, no more duplicate users)
- Room API key moved below SponsorBlock settings in the modal
- Attribution text improvements

---

# v1.1.2

## Per-browser identity and duplicate tab warning

- Use localStorage for browser ID so all tabs share one user identity
- BroadcastChannel-based duplicate tab detection with warning banner

---

# v1.1.1

## API fix

- Return HTTP 201 (not 200) from `POST /api/rooms`
- Discord bot accepts both 200 and 201

---

# v1.1.0

## REST API

- **`POST /api/rooms`** — create a room, get back room_id, URL, and API key
- **`GET /api/rooms/:id`** — room info (current video, play state, user count)
- **`GET /api/rooms/:id/queue`** — full queue with current index
- **`POST /api/rooms/:id/queue`** — add URL (mode: "now" or "queue")
- **`DELETE /api/rooms/:id/queue/:item_id`** — remove from queue
- **`PUT /api/rooms/:id/queue/reorder`** — reorder items
- **`POST /api/rooms/:id/skip`** — skip to next
- **`POST /api/rooms/:id/play`** — play at position
- **`POST /api/rooms/:id/pause`** — pause at position
- **`GET /api/rooms/:id/users`** — list users
- **`PUT /api/rooms/:id/username`** — change API user's name
- **`GET /api`** — self-documenting endpoint page with curl examples
- Auth via `Authorization: Bearer <token>` or `?api_key=<token>`
- ETS-based rate limiting (5/min create, 20/min mutations, 60/min reads)
- Room API key shown in settings modal with copy button
- API users appear in the room's user list

## Fixes

- Auto-play first video when added to empty queue via "Queue" mode

---

# v1.0.1

- Chrome Web Store and Firefox AMO extension links
- Chrome Web Store submission docs
- Privacy policy link and version number in settings modal
- Centralized extension store URLs in `Byob.Links`

---

# v1.0.0

## Watch any video, together

byob is now at v1.0.0! Create a room at [byob.video](https://byob.video), share the link, and watch together.

## Supported sources

- **YouTube** — synced play/pause/seek with [SponsorBlock](https://sponsor.ajay.app) integration (auto-skip sponsors, colored seek bar segments)
- **Direct video files** — paste any .mp4, .webm, .ogg, .mov, or .mkv URL for synced playback with a built-in HTML5 player
- **Any streaming site** — Crunchyroll, anime sites, etc. via the [browser extension](https://github.com/joegoldin/byob.video/releases)

## Features

- Video queue with drag-to-reorder and auto-advance to next video
- SponsorBlock with per-room category settings (auto-skip, show in bar, or disable)
- Room history — click to replay past videos
- Random usernames, renamable, with online/offline status
- Dark mode by default (light mode available)
- Rooms persist across server restarts

## Extension highlights

- Sync bar overlay shows Playing/Paused status with timestamps
- Collapses to a small pill in the bottom-right corner
- Detects videos automatically in nested iframes and shadow DOM
- Pauses playback when all player windows close
- Authenticated WebSocket connection with signed tokens

## Self-hosted

byob is free, open source (MIT), and designed to be self-hosted. Deploy with Docker or Fly.io.

```
fly deploy
```

Source code: [github.com/joegoldin/byob.video](https://github.com/joegoldin/byob.video)

---

# v0.7.0

## Branding and polish

- Custom logo and favicon throughout the app and extension
- About section in settings modal with SponsorBlock attribution and license links
- Landing page redesign with logo, supported formats, and extension links
- GitHub link in header nav bar
- Centralized link configuration (`Byob.Links`) with browser-detected extension URLs
- SVGs served from `priv/static/images/` as single source of truth
- Extension icons generated from SVG at nix build time via imagemagick

---

# v0.6.0

## Direct video URL playback

- New source type: paste any direct video link (.mp4, .webm, .ogg, .mov, .mkv, .avi, .m4v)
- Built-in HTML5 `<video>` player with native controls, fully synced across users
- Play/pause/seek/ended events synced like YouTube — same reconcile and clock sync engine
- URL preview shows film icon with filename
- No extension needed for direct video files
- Centralized `VERSION` file — single source of truth for mix.exs, extension manifests, and nix flake

---

# v0.5.0

## Security hardening

- **Critical**: Fixed RCE via `binary_to_term` — added `:safe` flag in persistence
- **Critical**: Fixed SSRF — block internal/private IPs in OpenGraph URL fetching
- Token-based extension WebSocket auth via Phoenix.Token (24h expiry)
- Extension only writes storage config from trusted origins
- Extension presence indicator hidden from other websites
- Sync bar uses DOM APIs instead of innerHTML
- Validated SponsorBlock categories, room IDs, username lengths
- Queue capped at 200 items, history at 99 entries
- Rate limited room creation (5 per minute per session)
- DB path configurable via `BYOB_DB_PATH` env var
- Default to dark mode
- Fly.io deployment config with SQLite volume mount

---

# v0.4.0

## Inline nav bar and drag-reorder queue

- Room renders its own nav bar with logo, copy link, URL input, settings, and theme toggle all inline
- URL preview appears as dropdown overlay below search input
- Drag-and-drop reordering for queue items
- Online users sorted to top of list, self shown bold with (you)
- Users list scrolls when too many users
- Player maintains 16:9 ratio without black bars, JS-driven sizing

---

# v0.3.1

## Extension sync bar and external player UX

- Sync bar status progression: Loading -> Searching -> Syncing -> Playing/Paused
- Sync bar collapses to small pill on bottom-right
- Bar updates relayed via port system for cross-origin iframe support
- Fix suppression: only suppress expected event, let user actions through
- Focus existing external player window instead of opening duplicate
- Copy room link works after DOM teleport
- Extension sends video:ended to advance queue for external sites
- Pause playback when all external player windows close
- Pass media item metadata on refresh for external video placeholder
- Include thumbnail_url in serialized queue items
- Disable check_origin on extension WebSocket for production

---

# v0.3.0

## Browser extension for non-YouTube sites

- Extension content script detects `<video>` elements on any site via MutationObserver
- Shadow DOM support via attachShadow monkey-patch
- Works in nested iframes (all_frames: true) for sites like Crunchyroll
- Sync bar overlay on external player pages
- Cross-origin iframe communication via chrome.runtime.sendMessage relay
- Extension service worker maintains Phoenix Channel WebSocket to server
- Pause enforcer fights site autoplay after sync
- OpenGraph metadata fetching for non-YouTube URL previews
- External player popup window management

---

# v0.2.1

## Extension packaging and distribution

- Chrome extension packaged as .crx via chromium --pack-extension
- Firefox extension packaged as .xpi with AMO-compatible manifest
- Nix flake for building Chrome, Firefox, and Docker packages
- Justfile with build targets
- Extension config via chrome.storage instead of URL params
- Auto-close external player on video change

---

# v0.1.1

## Docker and deployment

- Dockerfile with multi-stage build (elixir:1.19 + Node.js 22)
- Fix colocated hooks: compile before assets.deploy

---

# v0.1.0

## Core watch party features

- Ephemeral rooms with shareable URLs
- YouTube embedded playback with synced play/pause/seek
- NTP-style clock synchronization (5-probe burst, median filtering)
- Generation counter event suppression to prevent sync echo loops
- Drift correction with playbackRate adjustment and hard-seek threshold
- Video queue with Play Now and Queue modes, auto-advance on end
- SponsorBlock integration with auto-skip and colored seek bar segments
- Per-room SponsorBlock category settings
- Room history with replay
- SQLite persistence for room state across server restarts
- Dark/light theme toggle
- Random usernames, renamable, with online/offline presence
- Per-tab user sessions via sessionStorage
- URL preview with YouTube oEmbed metadata

---

# v0.0.1

## Initial prototype

- Basic room creation and joining
- YouTube player embed with LiveView push events
