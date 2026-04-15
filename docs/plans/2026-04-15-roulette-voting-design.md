# Roulette & Voting Modes — Design Spec

**Date:** 2026-04-15
**Status:** Approved for implementation planning

## Goal

Add two new ways to pick a video in a byob room:

- **Roulette** — spin a shared wheel of 6 random candidates; server picks the winner; winner gets appended to the queue.
- **Voting** — same 6 candidates, but users vote; highest tally wins; winner gets appended to the queue.

Candidates are pulled from a persistent, background-scraped video pool (YouTube Trending + curated subreddits + curated YouTube playlists). The pool grows over time on the Fly volume's SQLite DB, with freshness bias and server-wide repeat down-weighting so rounds stay interesting.

## Non-goals

- No takeover / no interruption of current playback. Rounds are an additive "pick me something" experience.
- No hosts / no permissions model beyond "the person who started a round can cancel it."
- No user-visible playlist management UI. Curated sources are configured in code for v1.
- No cross-restart round persistence. Rounds are ephemeral.

---

## Architecture Overview

A new **video pool subsystem** runs globally (one per Fly instance), polling three sources on a schedule and writing to SQLite. A **round subsystem** lives inside each `RoomServer` GenServer as a new state field, driven by user intents (`start_round`, `cast_vote`, `cancel_round`) and a scheduled timer. A **LiveView component** plus a JS hook render the panel and spin animation; all clients stay in sync via server-broadcast state (including a shared seed for the roulette wheel).

### New module tree

```
lib/byob/pool/
├── pool.ex                    # public API: pick_candidates/2, mark_picked/1, upsert/1
├── store.ex                   # raw exqlite CRUD for video_pool
├── scheduler.ex               # GenServer; jittered 1h + 24h tick
└── sources/
    ├── trending.ex            # YT Data API chart=mostPopular
    ├── subreddit.ex           # Reddit public JSON; filters YT links
    └── curated.ex             # Expands hardcoded playlist IDs via YT Data API

lib/byob_web/live/room_live/
└── round.ex                   # LiveComponent: voting panel + roulette wheel

assets/js/hooks/
└── roulette_wheel.js          # Deterministic spin given (seed, slot_count)
```

### Modified files

- `lib/byob/room_server.ex` — new `:round` state field, handlers for start/vote/cancel, finalize timer.
- `lib/byob_web/live/room_live.ex` — wires new events + PubSub messages; renders `Round` component when `round != nil`.
- `lib/byob/persistence.ex` — migration adds `video_pool` table.
- `lib/byob/application.ex` — starts `Byob.Pool.Scheduler` under the top-level supervisor.

### Why these boundaries

- **Pool is global** — videos are scraped once, shared across all rooms. Global supervision matches reality.
- **Sources are tiny, single-purpose modules.** Each exports `fetch/0 -> list of %PoolEntry{}`. Adding a 4th source later (Hacker News? Bluesky?) is one new file.
- **Round logic in `room_server.ex`** (not a new child process) — shares the GenServer's existing reconnect, state_heartbeat, and persistence patterns. Ephemeral round state is a natural fit.
- **Wheel rendering is a pure hook.** Server sends `{seed, duration_ms}`; hook animates. Same pattern as the existing sync engine.

---

## Data Model

### Table: `video_pool`

```sql
CREATE TABLE video_pool (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type    TEXT NOT NULL,           -- 'trending' | 'subreddit' | 'curated'
  source_detail  TEXT,                    -- subreddit name, region code, or playlist ID
  external_id    TEXT NOT NULL,           -- YouTube video ID
  title          TEXT NOT NULL,
  channel        TEXT,
  duration_s     INTEGER,
  thumbnail_url  TEXT,
  score          INTEGER,                 -- trending rank (lower=better) or reddit upvotes
  first_seen_at  INTEGER NOT NULL,        -- unix ms; never updated; drives freshness decay
  last_seen_at   INTEGER NOT NULL,        -- unix ms; bumped on re-scrape; small re-heat factor
  last_picked_at INTEGER,                 -- unix ms; NULL = never picked; drives repeat decay
  UNIQUE(source_type, external_id)
);
CREATE INDEX idx_pool_source_seen ON video_pool(source_type, last_seen_at DESC);
CREATE INDEX idx_pool_external ON video_pool(external_id);
```

**Key semantics:**
- `first_seen_at` is *set once on insert* and never updated. It's the age anchor for the freshness decay curve.
- `last_seen_at` updates every time a re-scrape sees the video; used for a mild "re-heat" factor (a video that trended three times over a year is slightly more recent than one that trended once a year ago).
- `last_picked_at` is updated across *all rows with the same `external_id`* whenever any room's round picks that video as a winner. Server-wide repeat-suppression signal.
- `UNIQUE(source_type, external_id)` allows the same YT video to live under two source types (e.g. both trending and subreddit) — by design, since it may be weighted twice.

### Hardcoded curated playlists

In `lib/byob/pool/sources/curated.ex`:

```elixir
@curated_playlists [
  "PLmur3Z0Afau5t4kKbwmCsrXUiyUoZBQ5m",
  "PLmur3Z0Afau4xMQrGmNI20OUu1_jBWRIo",
  "PLmur3Z0Afau6t-ab7uUZZnAtWZuLyMW9r",
  "PLmur3Z0Afau4wSl9By0h8qIgOBbN9Zmhd",
  "PLEbAHi3fZpuEyBOPtr158TY-FW7P1l4Fg",
  "PL8hhMHBxIcj2slXZOJHs8_lESmVDIR0U9",
  "PLDIpOnnnyGLC9-1hn4lcNlrWDF2ktOtTp",
  "PLFz4Zf531DCDlhwNQLk64yJwofKHyu9jo",
  "PLGGr2yYc6y6QINtXVgc5BUw8qeb44dI48",
  "PLdUGA0NFIvcCrfMeI_iuaEP0iyGPnbryJ",
  "PLcLtbK8Nf64InyudI1rnYwwRbCr08yup_",
  "PLDWYWQX-Q1O6gpctyJS9SlQBIPnuXuuWQ"
]
```

### Hardcoded subreddits

In `lib/byob/pool/sources/subreddit.ex`:

```elixir
@subreddits ~w(videos mealtimevideos deepintoyoutube listentothis)
```

---

## Scraping Flow

### Scheduler

`Byob.Pool.Scheduler` is a single `GenServer` under the app supervisor. Two independent tick schedules:

- **Hourly tick (±10 min jitter):** fetches Trending + all 4 subreddits. Low API cost.
- **Daily tick (±2 h jitter):** fetches all 12 curated playlists via `playlistItems.list` pagination. Higher API cost, changes infrequently.

Each tick fans out via `Task.async_stream/3` with a 30s timeout per source. Source failures are isolated — one crash doesn't stop the other sources' work.

```
boot
 └── schedule hourly_tick in 60s    (cold-start cushion)
 └── schedule daily_tick   in 5min

hourly_tick
 └── Task.async_stream([Trending, Subreddit], fn mod ->
       try do Pool.upsert(mod.fetch()) rescue _ -> :error end
     end, timeout: 30_000)
 └── schedule next hourly_tick (1h ± 10min)

daily_tick
 └── Task.async_stream(Curated.fetch_per_playlist/1, fn entries ->
       Pool.upsert(entries)
     end, max_concurrency: 3)
 └── schedule next daily_tick (24h ± 2h)
```

### Source behaviors

**`Trending.fetch/0`** — one API call to `videos.list` with `chart=mostPopular`, `maxResults=50`, US region. Returns up to 50 `%PoolEntry{}`. Cost: ~1 YT quota unit.

**`Subreddit.fetch/0`** — for each of the 4 subs, `GET https://www.reddit.com/r/{sub}/top.json?t=day&limit=50`. No auth; a `User-Agent` header is required. Filters posts whose `url` resolves to a YouTube video ID; non-YT links are dropped. Each sub = one HTTP call. Total: 4 per tick.

**`Curated.fetch/0`** — for each playlist ID, paginate `playlistItems.list` (`maxResults=50`, loop `pageToken`) until exhausted. Extracts `videoId`, `title`, `channelTitle`, `thumbnails.medium.url` from each item. A single playlist might require multiple page calls. Cost: N quota units per playlist where N = ceil(playlist_size / 50).

### Dedupe on insert

`Pool.upsert/1` uses `INSERT ... ON CONFLICT(source_type, external_id) DO UPDATE SET last_seen_at=?, score=?, title=?`. `first_seen_at` is untouched on conflict.

---

## Candidate Selection

`Pool.pick_candidates(live_queue_external_ids) :: {:ok, [Candidate.t()]} | {:error, :no_candidates}`

**Goal:** 6 candidates, 2 per source, deduped by `external_id`, excluding videos currently in the room's live queue.

**SQL (per source, weighted pick):**

```sql
SELECT * FROM video_pool
 WHERE source_type = ?
   AND external_id NOT IN (SELECT value FROM json_each(?))   -- live-queue exclusion
 ORDER BY
   -log(abs(random()) / 9223372036854775807.0 + 1e-10)
   / (
       exp(-((? - first_seen_at) / 1209600000.0))            -- 14d freshness half-scale
       * CASE WHEN last_picked_at IS NULL THEN 1.0
              ELSE (1.0 - exp(-((? - last_picked_at) / 2592000000.0)))  -- 30d repeat decay
         END
     )
 LIMIT 2;
```

This is the **Gumbel trick** for weighted reservoir sampling: picking each row with probability ∝ weight.

**Exception:** Curated source skips freshness decay (playlists are your handpicked evergreens) — curated query drops the `exp(-.../1209600000.0)` factor and keeps only the repeat decay.

**Orchestration (`Pool.pick_candidates/1`):**

1. For each `source_type`, run the weighted query with `LIMIT 4` (overfetch for dedupe).
2. Dedupe result by `external_id` (keeping first occurrence, preserving source attribution).
3. Take up to 2 per source. If a source yields fewer than 2 (empty DB, all in live queue, dedupe collisions), mark that source as under-quota.
4. If total < 6, backfill from sources that have surplus, using the same weight rules.
5. If total is still 0, return `{:error, :no_candidates}`.

### Repeat signal wiring

`Pool.mark_picked(external_id)` runs a single `UPDATE video_pool SET last_picked_at = ? WHERE external_id = ?`. Called whenever a round winner is enqueued.

---

## Round State Machine

Lives in `lib/byob/room_server.ex` as a new field on the state struct:

```elixir
defstruct [
  # ... existing fields ...
  round: nil  # %Round{} or nil
]
```

```elixir
defmodule Byob.RoomServer.Round do
  defstruct [
    :id,                      # random string, round identity
    :mode,                    # :roulette | :voting
    :started_by,              # user_id of initiator
    :started_at,              # monotonic ms (server)
    :expires_at,              # monotonic ms; started_at + 15_000 (vote) or + 4_000 (roulette)
    :candidates,              # list of %Candidate{external_id, title, duration_s, thumbnail_url, source_type}
    :votes,                   # %{external_id => MapSet.of(user_id)}  (voting only)
    :seed,                    # integer (roulette only; determines winning slice)
    :winner_external_id,      # set on resolve
    :phase                    # :active | :revealing | :done
  ]
end
```

### Transitions

```
idle
  │
  │ :start_round(mode, triggering_user)
  │    reject if state.round != nil  → reply {:error, :round_active}
  │    pool = Pool.pick_candidates(queue_external_ids)
  │    if {:error, :no_candidates}   → reply {:error, :no_candidates}
  │    create Round{}; Process.send_after(self, {:round_expire, round_id}, duration)
  │    broadcast {:round_started, round}
  ▼
active
  │
  │ mode=:voting → :cast_vote(user_id, external_id)
  │   remove user_id from every candidate's vote set
  │   add user_id to candidates[external_id].votes
  │   broadcast {:round_updated, round}   (throttled max 1/250ms)
  │   if MapSet.size of all vote sets = MapSet.size of present_users → resolve_now()
  │
  │ mode=:roulette → votes ignored; wait for timer
  │
  │ :cancel_round(user_id)
  │   accept iff user_id == round.started_by
  │   clear round; broadcast {:round_cancelled, reason: :cancelled_by_starter}
  │   → idle
  │
  │ timer {:round_expire, round_id} fires
  ▼
revealing
  │  voting mode:
  │    if all vote sets empty → broadcast {:round_cancelled, reason: :no_votes}; → idle
  │    else pick max tally; random tiebreak; set winner_external_id
  │  roulette mode:
  │    generate seed (:rand.uniform(1 bsl 32)); winner = candidates[seed rem 6]
  │  broadcast {:round_revealed, %{seed, winner}}
  │  Process.send_after(self, {:round_finalize, round_id}, reveal_delay)
  │    reveal_delay: 1_500ms (voting) or 1_000ms (roulette landing + highlight)
  ▼
done (triggered by :round_finalize)
  │  add_to_queue(winner)  (reuses existing flow)
  │  Pool.mark_picked(winner.external_id)
  │  activity_log_entry(:roulette_winner | :vote_winner, ...)
  │  round: nil
  │  broadcast {:round_finalized}
  ▼
idle
```

### Late messages & race handling

- Every round-related message carries `round_id`. If the current round's id mismatches (or no round is active), the handler is a no-op. Prevents stale votes after cancel/finalize.
- `cast_vote` during `phase: :revealing` is rejected — voting window is closed.
- If a client reconnects mid-round, it gets the full `Round{}` in the `get_state` reply. The client computes remaining time from `expires_at - server_now()` using the existing clock-sync offset.

### Not persisted across restart

The `Round{}` struct is ephemeral — it's *not* serialized into SQLite by the periodic persistence. If the server restarts during a round, the round is lost; the room reloads without a round, and users can start a new one. This matches byob's existing pattern for ceremonial state (countdowns, etc.) and avoids the bookkeeping cost of reconstructing an incomplete round.

---

## Broadcasts (PubSub)

All use the existing `"room:#{room_id}"` topic.

| Message | Payload | When |
|---|---|---|
| `{:round_started, round}` | full Round struct | on successful :start_round |
| `{:round_updated, round}` | full Round struct | on :cast_vote; throttled max 1 per 250ms |
| `{:round_revealed, payload}` | voting: `%{mode: :voting, winner_external_id, tallies}`; roulette: `%{mode: :roulette, seed, winner_external_id}` | timer fires, phase → :revealing |
| `{:round_cancelled, %{reason}}` | reason: `:cancelled_by_starter` \| `:no_votes` | cancel or empty vote |
| `{:round_finalized, nil}` | — | finalize timer fires, winner enqueued |

Throttling of `:round_updated` is done in the RoomServer: when a vote comes in, if last broadcast was <250ms ago, schedule a deferred send_after, coalescing multiple votes into one broadcast.

---

## Activity Log

Adds five new entry kinds to the existing activity log (stored in `RoomServer` state, already rendered by `components.ex`):

| Kind | Text rendering |
|---|---|
| `:roulette_started` | "{user} spun the roulette" |
| `:roulette_winner` | "🎰 {title}" (linked to the queued item) |
| `:vote_started` | "{user} opened voting" |
| `:vote_winner` | "🗳️ {title} won with {n} vote(s)" |
| `:round_cancelled` | "{user} cancelled the round" OR "round ended with no votes" |

Rendered in `lib/byob_web/live/room_live/components.ex` alongside the existing entry formatters. No new rendering layer.

---

## UI Layout

### Placement

When a round is active, a **Round Panel** appears in the right column *above* the YouTube comments panel, pushing comments down the normal stacking order. When no round is active, the panel does not exist in the DOM — comments sit at the top as they do now. No `position: absolute`; no overlap with the video.

### Triggers

Two small icon buttons in the queue header row (where the URL paste bar and queue actions already live):

```
[ Paste URL... ]   [ 🎰 ]  [ 🗳️ ]
```

- Tooltips: "Roulette — spin for a random video" / "Voting — pick together"
- Disabled with a dimmed state when a round is active (tooltip: "Round in progress")
- Single click starts a round immediately; no confirm dialog

Anyone in the room can click. No host check.

### Voting panel layout

```
┌─────────────────────────────────────┐
│ 🗳️  Voting — 9s      [▾] [✕]       │   ← ✕ only interactive for started_by
├─────────────────────────────────────┤
│ [thumb] Candidate 1 title        🎯 │   ← 🎯 = your current vote
│        channel • 3:42        ▓▓░░ 2│   ← live tally bar + count
│                                     │
│ [thumb] Candidate 2 title        ·  │
│        channel • 5:13        ▓░░░ 1│
│                                     │
│ ... 6 rows total ...                │
└─────────────────────────────────────┘
```

Click a row to cast/change vote. Tally bars transition smoothly on updates. Header timer counts down (client computes from `expires_at - server_now()`).

### Roulette panel layout

```
┌─────────────────────────────────────┐
│ 🎰 Roulette           [▾] [✕]       │
├─────────────────────────────────────┤
│                                     │
│          ╭───────────╮              │
│          │  spinning │              │   ← SVG wheel, 6 slices
│          │   wheel   │              │     each showing a thumbnail
│          ╰───────────╯              │
│                                     │
│ 6 candidates · 4s                   │
└─────────────────────────────────────┘
```

On `:round_started` the wheel begins spinning freely (randomized velocity, no known target). 4s later `{:round_revealed, seed, winner}` arrives; the client damps into a deterministic landing animation (~500ms) that settles on `seed % 6`. All clients land on the same slice because the seed is shared. The winning slice is then highlighted for ~500ms before `round_finalized` fires at t ≈ 5s total and the panel collapses.

### JS hook: `RouletteWheel`

- `mounted()` reads slices from data attrs; starts a free-spin rotation at a randomized initial velocity using `requestAnimationFrame`.
- Listens for `this.handleEvent("round:land", %{seed})`. On receipt, switches to a deterministic easing landing: a `cubic-bezier(.12,.72,.28,1)` ~500ms tween whose final rotation = (currentRotation rounded up to next multiple of 360°) + 2 full revolutions + `(seed % 6) * 60deg`. Clients stay visually in sync on the *landing slice*, even if their pre-landing free-spin rotations differed.
- `destroyed()` cancels any pending frame.
- CSS fallback: if the hook fails to mount, display the static winning slice after `round_revealed` arrives — no animation, correct result.

### Non-intrusive guarantees

- No toasts, no sound, no flashing, no focus steal, no scroll-into-view.
- Round panel has a `[▾]` collapse affordance, state persisted in LiveView process per-user (not per-room). Collapsed state shows one row: "🎰 Roulette spinning — 3s" or "🗳️ Voting — 9s".
- The `[✕]` cancel button is rendered only for the user whose `user_id == round.started_by`. Other users see a static icon.
- Non-participants are silently ignored. "All present voted" early-close check counts only users currently in presence; it doesn't require everyone to vote — the 15s timer is the real backstop.
- Winner enqueue is silent — same visual treatment as any other queue add. No "winner!" banner.

---

## Error Handling

| Situation | Behavior |
|---|---|
| All 3 sources empty at `pick_candidates` | Reply `{:error, :no_candidates}`; surface as flash to *triggering user only* (not a room broadcast) |
| One source errors during scheduler tick | Logger.warn; that source contributes 0 new rows this tick; other sources unaffected |
| Source returns zero candidates | `pick_candidates` backfills from other sources up to 6; round proceeds |
| Winner video is age-restricted / fails to add to queue | Activity log: "🎰 winner couldn't play: {reason}"; round ends cleanly; no retry |
| User disconnects mid-vote | Vote stays counted (MapSet is keyed on user_id); "all present voted" check uses live presence so disconnect can trigger early-close |
| Server restart mid-round | Round is lost; no persistence; room resumes normally |
| Two `:start_round` intents race | First wins; second gets `{:error, :round_active}` |
| Client clock drift | All timing is server-authoritative (`expires_at` is server monotonic); client derives display time using existing clock-sync offset |
| API quota exhausted | Next scheduler tick's API call returns 403; Trending/Curated contribute 0 new rows; existing pool rows still serve rounds fine |

---

## Testing Strategy

### Unit tests

- **`Byob.Pool.Store`** — upsert semantics (insert new; update `last_seen_at` and `score` on conflict but not `first_seen_at`).
- **`Byob.Pool.pick_candidates/1`** — empty DB → `:no_candidates`; freshness decay favors recent; repeat decay suppresses `last_picked_at` rows; live-queue exclusion; backfill when source under-quota.
- **Source modules** — mock HTTP layer; verify parsing of YT Data API / Reddit responses; verify YT-link filtering in subreddit source.
- **`Byob.RoomServer.Round`** (pure state transitions if factored out) — vote tallying, tiebreaker randomness, reveal selection.

### Integration tests

- **`RoomServerTest`** (extend existing) — happy path: start voting round → cast 3 votes → timer fires → winner enqueued. Same for roulette (deterministic by seeding `:rand`). Cancel path. Empty-vote path.
- **Concurrent rounds rejected** — two rapid `:start_round` calls; second returns `:round_active`.
- **Vote during reveal phase rejected** — no-op, no state change.
- **Mid-round reconnect** — `get_state` returns round struct intact; client can compute remaining time.

### Manual / e2e

- Two browser windows in same room; start voting; cast votes in each; observe live tallies and winner enqueue.
- Two browser windows; start roulette; verify both land on same slice.
- Collapse button; starter ✕ button; non-starter sees no ✕ affordance.
- Right column layout: round panel pushes comments down; both visible without clipping; resizes cleanly on round end.
- API key missing → sources silently disabled; rounds still work if any other source has rows.
- Force source failure (bad URL) → other sources still contribute.

---

## Open questions / punted to v2

- User-driven curation (add/remove playlists via UI). v1: hardcoded module constant.
- Per-user context-menu "add to curated pool" action. Punted.
- Additional sources (Hacker News, Bluesky, etc.). Trivial to add later — one file per source.
- Re-spin / vote-again affordances. Round is one-shot in v1.
- Winning vote reveal theatrics (animated tally reordering, etc.). Plain transition in v1.
- Cross-restart round persistence. Rounds remain ephemeral.
