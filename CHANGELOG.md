# byob Changelog

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
