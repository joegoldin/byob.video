# byob — bring your own binge

Watch videos together in sync. Free, open source, self-hostable.

**[byob.video](https://byob.video)** · [Chrome Extension](https://chromewebstore.google.com/detail/jlpogmjckejgpbbfhafgjgkbnocjfbmb) · [Firefox Extension](https://addons.mozilla.org/en-US/firefox/addon/byob-bring-your-own-binge/) · [Discord Bot](https://github.com/joegoldin/byob-discord-bot)

## What it does

Create a room, share the link, paste video URLs, watch together. Play, pause, and seek sync across all users in real time.

**Supports:**
- YouTube — embedded player with [SponsorBlock](https://sponsor.ajay.app) integration
- Direct video files — .mp4, .webm, .ogg, .mov, .mkv
- Any streaming site — via browser extension (Crunchyroll, anime sites, etc.)

## Features

- Video queue with drag-to-reorder and auto-advance
- SponsorBlock auto-skip with per-room category settings
- Room history — click to replay
- Activity log with timestamps
- REST API for bots and integrations
- Room persistence across server restarts (SQLite)
- Dark/light theme

## Quick start

```bash
# Self-host with Docker
docker run -p 4000:4000 \
  -e SECRET_KEY_BASE=$(openssl rand -hex 64) \
  -e PHX_HOST=localhost \
  -e PHX_SERVER=true \
  -v byob-data:/data \
  byob

# Or deploy to Fly.io
fly deploy
```

## Development

```bash
mix setup
mix phx.server  # http://localhost:4000
```

## Build extensions

```bash
just chrome    # result-chrome/
just firefox   # result-firefox/
```

## API

Self-documenting at `/api`. Create rooms, manage queues, control playback programmatically.

```bash
curl -X POST https://byob.video/api/rooms
# {"ok":true,"data":{"room_id":"abc123","url":"https://byob.video/room/abc123","api_key":"..."}}
```

## Tech

Elixir/Phoenix LiveView, GenServer-per-room, NTP-style clock sync, Chrome/Firefox MV3 extension, SQLite, Tailwind + daisyUI.

## License

MIT — See [LICENSE](LICENSE)
