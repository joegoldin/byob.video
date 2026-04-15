# byob Changelog

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
