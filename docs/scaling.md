# Scaling Constraints

This document audits byob.video's current architecture for single-instance assumptions and describes what would need to change to support multi-instance (horizontally scaled) deployment.

## Current Architecture (Single-Instance)

### What Works Today

The application is designed for a single Fly.io machine and works well within that constraint.

**Room GenServers** — Each room runs as a `GenServer` registered via Elixir's local `Registry` (`Byob.RoomRegistry`). Lookup, creation, and inter-process calls all happen in-process. `RoomManager.ensure_room/1` calls `Registry.lookup/2` directly.

**PubSub** — `Phoenix.PubSub` is started with the default `Phoenix.PubSub.PG2` adapter (local broadcast). All sync events (`sync_play`, `sync_pause`, `sync_seek`, `queue_updated`, etc.) are broadcast via `Phoenix.PubSub.broadcast/3` in `RoomServer` and subscribed to in `RoomLive`. This works as long as the broadcaster and all subscribers are on the same node.

**Persistence** — `Byob.Persistence` is a single `GenServer` wrapping one SQLite connection (`exqlite`). SQLite serializes all writes through this process. Room state is persisted every 30 seconds and on GenServer termination. There is no external database; the file lives on a Fly.io volume.

**WebSockets** — Two socket endpoints:
- `/live` — Phoenix LiveView WebSocket (browser)
- `/extension` — `ExtensionSocket` channel with `check_origin: false` (browser extension, arbitrary origin)

Both connect to the single node, so there is no routing concern today.

---

## Multi-Instance Constraints

The following components have hard single-node assumptions that would break under horizontal scaling.

### 1. PubSub Adapter (blocking)

`Phoenix.PubSub` is started with no explicit adapter, defaulting to `PG2` (in-process). Broadcasts from a `RoomServer` on node A will not reach `LiveView` subscribers on node B.

**Fix:** Switch to a distributed adapter. The standard option is `phoenix_pubsub_redis` or the newer `Phoenix.PubSub` cluster support via `libcluster`. Example config:

```elixir
{Phoenix.PubSub, name: Byob.PubSub, adapter: Phoenix.PubSub.Redis, url: redis_url}
```

All broadcast/subscribe call sites in `RoomServer` and `RoomLive` stay the same — the adapter is the only change.

### 2. Room Registry (blocking)

`Byob.RoomRegistry` is an Elixir `Registry` (local, in-process). `RoomManager.ensure_room/1` and `RoomServer.start_link/1` both use `{:via, Registry, {Byob.RoomRegistry, room_id}}`. A room started on node A is invisible to node B; two nodes would start duplicate GenServers for the same room and diverge.

**Options:**
- **`Horde.Registry` + `Horde.DynamicSupervisor`** — drop-in distributed replacements; rooms live on one node, registry is globally consistent via CRDT.
- **Sticky sessions + local registry** — route all requests for a room to the node that owns it. Simpler operationally but requires the load balancer to support cookie or header affinity per room.

### 3. Database — SQLite is single-writer (blocking)

`Byob.Persistence` opens one SQLite file. SQLite does not support multiple concurrent writers from separate OS processes. Multiple instances either need to share a network volume (single-writer bottleneck, Fly volumes are single-machine) or use a client/server database.

**Fix:** Replace `Byob.Persistence` with an Ecto + PostgreSQL (or MySQL) adapter. Key considerations:
- Serialized Erlang terms (`erlang.term_to_binary`) are stored as BLOBs today — a migration to JSON columns or structured schema would improve portability.
- `Fly.io Postgres` is available as a managed option on the same platform.

### 4. Sticky Sessions for LiveView WebSockets (required with distributed registry)

Phoenix LiveView WebSockets maintain a stateful connection. If the load balancer round-robins connections and room GenServers stay local (option 2b above), a LiveView on node B cannot directly call a room PID on node A.

**Fix:** Use sticky (affinity) sessions so a user's WebSocket reconnects to the same node. On Fly.io this is done with `fly.toml` stickiness:

```toml
[http_service]
  sticky_sessions = true
```

This is only required if the distributed registry approach is _not_ used (i.e., rooms remain local to one node). With `Horde`, rooms can be called from any node via `:rpc` transparently.

### 5. Extension WebSocket Routing

The extension connects via `/extension` (`ExtensionSocket`) with `check_origin: false` using a signed `Phoenix.Token` for auth. It subscribes to the same PubSub topics as LiveView. With the PubSub fix (#1), extension connections on any node will receive broadcasts correctly.

However, the extension's WebSocket must also reach the node that can resolve the `Phoenix.Token` — token validation uses `SECRET_KEY_BASE` which must be identical across nodes (already required for cookie sessions). No structural change needed beyond ensuring `SECRET_KEY_BASE` is shared.

---

## Summary Table

| Component | Today | Required Change |
|---|---|---|
| PubSub | `PG2` (local) | Redis or clustered adapter |
| Room registry | Elixir `Registry` (local) | `Horde.Registry` or sticky sessions |
| Room supervisor | `DynamicSupervisor` (local) | `Horde.DynamicSupervisor` or sticky sessions |
| Database | SQLite single-writer | PostgreSQL (Ecto) |
| LiveView WebSocket | Any node (single node today) | Sticky sessions (if local registry kept) |
| Extension WebSocket | Any node (single node today) | No change beyond shared `SECRET_KEY_BASE` |

For a Fly.io multi-region deployment the minimum viable path is: **PubSub → Redis, Registry/Supervisor → Horde, Persistence → Postgres**. Sticky sessions are a simpler short-term workaround that defers the registry problem but adds operational fragility on node restarts.
