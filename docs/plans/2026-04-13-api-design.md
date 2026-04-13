# byob REST API — v1.1.0 Design

## Overview

Add a JSON REST API to byob for programmatic room management. Primary use case: Discord bot integration. Every room gets an API key shown in the settings modal.

## Authentication

- **Bearer token**: `Authorization: Bearer <api_key>` header
- **Query param**: `?api_key=<api_key>` (convenience for curl/testing)
- Both accepted on all authed endpoints
- Token is a 32-char random string generated on room creation
- Stored in RoomServer state and persisted to SQLite

## Endpoints

All return JSON. Content-Type: application/json.

### No auth required

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api` | Self-documenting HTML page with all endpoints and curl examples |
| POST | `/api/rooms` | Create room → `{room_id, url, api_key}` |

### Room API key required

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/rooms/:id` | — | Room info: current video, play state, user count, queue length |
| GET | `/api/rooms/:id/queue` | — | Full queue with current_index |
| POST | `/api/rooms/:id/queue` | `{url, mode}` | Add URL. mode: "now" or "queue" |
| DELETE | `/api/rooms/:id/queue/:item_id` | — | Remove item from queue |
| PUT | `/api/rooms/:id/queue/reorder` | `{from, to}` | Reorder queue items |
| POST | `/api/rooms/:id/skip` | — | Skip to next in queue |
| POST | `/api/rooms/:id/play` | `{position}` | Play at position (seconds) |
| POST | `/api/rooms/:id/pause` | `{position}` | Pause at position (seconds) |
| GET | `/api/rooms/:id/users` | — | List users with connected status |
| PUT | `/api/rooms/:id/username` | `{username}` | Change API user's display name |

### Response format

Success:
```json
{"ok": true, "data": { ... }}
```

Error:
```json
{"error": "message"}
```

HTTP status codes: 200 (success), 201 (created), 400 (bad request), 401 (unauthorized), 404 (room not found), 429 (rate limited).

## Rate Limiting

ETS-based sliding window per key. Returns 429 with `Retry-After` header.

| Category | Limit | Key |
|----------|-------|-----|
| Room creation | 5/min | IP address |
| Queue mutations (add/remove/reorder/skip/play/pause) | 20/min | API key |
| Read endpoints (GET) | 60/min | API key |
| Docs page | 30/min | IP address |

Implementation: `ByobWeb.RateLimit` plug using `:ets` table with `{key, count, window_start}` entries. A periodic process cleans expired entries.

## API User Identity

When an API request hits a room, the server joins an API user:
- user_id: `"api:<first_8_chars_of_key>"`
- username: "API" (changeable via PUT /username)
- The API user shows up in the room's user list
- API user is joined lazily on first request and marked disconnected after 30s of inactivity

## Token Storage

- `api_key` field added to `RoomServer` state struct
- Generated via `:crypto.strong_rand_bytes(24) |> Base.url_encode64()`
- Persisted to SQLite with room state
- Every room gets a key (both web-created and API-created)

## Settings UI

- New "Room API Key" section in the settings modal
- Shows the key with a click-to-copy button
- Link to `/api` documentation page

## Self-Documenting `/api` Page

Simple HTML page rendered by the controller. Lists all endpoints with:
- Method, path, description
- Required auth
- Example curl commands
- Example request/response bodies

No auth required to view.

## Files to create/modify

### New files
- `lib/byob_web/controllers/api_controller.ex` — all API endpoint handlers
- `lib/byob_web/plugs/rate_limit.ex` — ETS-based rate limiter plug
- `lib/byob_web/controllers/api_html.ex` — docs page template

### Modified files
- `lib/byob_web/router.ex` — add `/api` pipeline and routes
- `lib/byob/room_server.ex` — add `api_key` to state, generate on init
- `lib/byob/persistence.ex` — persist api_key with room state
- `lib/byob_web/live/room_live.ex` — show API key in settings modal
- `lib/byob/room_manager.ex` — return api_key from create_room

## Out of scope (v1.2+)

- Discord bot (separate repo, consumes this API)
- WebSocket API for real-time events
- API key rotation/revocation
- Per-endpoint auth scoping
