# CLAUDE.md

Project context for AI assistants working on byob.video.

## What is this

byob (bring your own binge) is a self-hosted another sync extension clone. Users create ephemeral rooms, paste video URLs, and watch in sync. Built with Elixir/Phoenix LiveView.

## Tech stack

- **Server**: Elixir 1.19, Phoenix 1.8.5, LiveView 1.1, Bandit
- **State**: GenServer per room, SQLite persistence via exqlite (no Ecto)
- **Frontend**: Tailwind CSS + daisyUI, esbuild, colocated Phoenix hooks
- **Extensions**: Chrome MV3 + Firefox MV2, plain JS (no bundler), vendored Phoenix Channel client
- **Analytics**: PostHog server-side SDK (no client-side tracking)
- **Deployment**: Fly.io with Docker, SQLite volume mount

## Key architecture

- `lib/byob/room_server.ex` — GenServer per room. Canonical playback state, queue, history, activity log. All sync goes through here.
- `lib/byob_web/live/room_live.ex` — Main LiveView. Large file (~1100 lines). Handles all room UI, events, PubSub.
- `assets/js/hooks/video_player.js` — YouTube IFrame API + direct video + sync engine. Clock sync, reconcile, suppression, seek detection.
- `extension/content.js` — Runs on all pages. MutationObserver for `<video>` elements. Sync bar overlay.
- `extension/background.js` — Service worker. Phoenix Channel WebSocket to server. Routes events between content scripts and server.

## Sync protocol

1. NTP-style clock sync (5-probe burst on join, 30s maintenance)
2. Generation counter event suppression (prevents echo loops)
3. Drift correction (playbackRate adjustment for small drift, hard seek for >2s)
4. 500ms reconcile tick with hysteresis

## Important patterns

- **`phx-update="ignore"`**: The player div is inside this — LiveView doesn't patch it. The VideoPlayer hook manages all player DOM.
- **Per-tab user IDs**: `session_id:tab_id` — each tab is a separate user for sync. Display deduplicates by username.
- **Browser ID**: Separate `localStorage` ID for analytics (same person across tabs).
- **Extension detection**: Page JS checks `data-byob-extension` attribute (set by extension content script on byob.video/localhost only).
- **`attach_hook :ensure_pid`**: Every LiveView event auto-reconnects to room GenServer if it died (deploy/restart).

## Version management

Single source of truth: `VERSION` file. `just sync-version` updates extension manifests. `mix.exs` reads it at compile time. Nix flake reads it at build time.

## Common commands

```bash
mix phx.server              # Dev server at localhost:4000
just chrome                 # Build Chrome extension
just firefox                # Build Firefox extension
just build                  # Build all
just bump 2.1.0             # Bump version everywhere
fly deploy --app byob-video # Deploy to production
```

## Environment variables (production)

- `SECRET_KEY_BASE` — required, `mix phx.gen.secret`
- `PHX_HOST` — hostname (e.g. `byob.video`)
- `PHX_SERVER=true` — start HTTP server
- `BYOB_DB_PATH` — SQLite path (default: `priv/byob.db`)
- `POSTHOG_API_KEY` — optional, enables analytics
- `PORT` — HTTP port (default: 4000)

## Gotchas

- YouTube autoplay requires user gesture. First video may need a click (we show a "Click to join playback" overlay). Subsequent queue items autoplay via `loadVideoById` on existing player.
- Age-restricted YouTube videos can't embed. We detect error codes 100/101/150 and show a fallback UI with extension detection.
- The extension WebSocket has `check_origin: false` (required since it connects from arbitrary domains). Auth is via signed Phoenix.Token.
- `force_ssl` in prod excludes `/health` path for Fly.io health checks.
- Room state persists to SQLite every 30s. On deploy, GenServers restart and reload from SQLite. The `ensure_room_pid` hook transparently reconnects LiveView sockets.

## Release workflow

After completing a set of changes:

1. Update `CHANGELOG.md` with a new version section at the top
2. Bump version: `echo "X.Y.Z" > VERSION && just sync-version`
3. Commit, tag, push: `git add -A && git commit -m "vX.Y.Z: description" && git tag vX.Y.Z && git push origin main && git push origin --tags`
4. Deploy if needed: `fly deploy --app byob-video`

Extension manifests and mix.exs version are derived from the `VERSION` file automatically.

## Related repos

- [byob-discord-bot](https://github.com/joegoldin/byob-discord-bot) — Discord bot using the REST API
