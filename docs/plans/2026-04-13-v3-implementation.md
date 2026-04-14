# byob.video v3.0.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor monolithic files into focused modules, add SQLite schema versioning, and build a YouTube comments panel below the video player.

**Architecture:** Refactor first (Track 1), then features (Track 2). LiveView split uses Phoenix's event handler delegation pattern. JS split uses ES module imports bundled by esbuild. YouTube comments fetched server-side via Data API v3 with ETS caching and silent quota degradation.

**Tech Stack:** Elixir/Phoenix LiveView, esbuild (ES2022), YouTube Data API v3, ETS, SQLite/Exqlite

---

## File Structure

### Track 1: Architecture Refactor

**New Elixir modules (split from room_live.ex):**

| File | Responsibility |
|------|----------------|
| `lib/byob_web/live/room_live.ex` | Mount, assigns, top-level render, `ensure_room_pid` hook. Delegates events/info to submodules. |
| `lib/byob_web/live/room_live/url_preview.ex` | `handle_event` for `"preview_url"`, `"add_url"`, `"preview:play_now"`, `"preview:queue"`, `"url:focus"`, `"url:blur"`. `handle_info` for `{:url_preview_result, _}`. |
| `lib/byob_web/live/room_live/playback.ex` | `handle_event` for `"video:play"`, `"video:pause"`, `"video:seek"`, `"video:ended"`, `"video:embed_blocked"`, `"sync:ping"`, `"analytics:has_extension"`. |
| `lib/byob_web/live/room_live/queue.ex` | `handle_event` for `"queue:skip"`, `"queue:remove"`, `"queue:play_index"`, `"queue:reorder"`, `"history:play"`, `"switch_tab"`, `"sb:update"`. |
| `lib/byob_web/live/room_live/username.ex` | `handle_event` for `"username:edit"`, `"username:cancel"`, `"username:change"`. |
| `lib/byob_web/live/room_live/pubsub.ex` | All `handle_info` for PubSub messages: `{:sync_play, _}`, `{:sync_pause, _}`, `{:sync_seek, _}`, `{:sync_correction, _}`, `{:queue_updated, _}`, `{:queue_ended, _}`, `{:video_changed, _}`, `{:sponsor_segments, _}`, `{:sb_settings_updated, _}`, `{:extension_player_state, _}`, `{:users_updated, _}`, `{:activity_log_updated, _}`, `{:activity_log_entry, _}`. |
| `lib/byob_web/live/room_live/components.ex` | Function components: sidebar (queue list, history, activity log, users card), URL preview dropdown, SponsorBlock settings modal. Helpers: `format_log_entry/1`, `dedup_users/2`, `extension_open_url/2`, etc. |

**New JS modules (split from video_player.js):**

| File | Responsibility |
|------|----------------|
| `assets/js/hooks/video_player.js` | Phoenix hook lifecycle (`mounted`, `reconnected`, `destroyed`), event handler registration, delegates to player/sync modules. ~150 lines. |
| `assets/js/sync/clock.js` | `ClockSync` class — NTP-style ping/pong, latency estimation, `serverNow()`. Extracted from existing inline class. |
| `assets/js/sync/suppression.js` | `Suppression` class — generation counter, `suppress()`, `isSuppressed()`. Extracted from existing inline class. |
| `assets/js/sync/reconcile.js` | `Reconcile` class — 500ms tick, drift detection, playbackRate correction, hard seek. Extracted from existing inline class. |
| `assets/js/players/youtube.js` | `YouTubePlayer` — load IFrame API, create/reuse player, state change handling, error handling (embed blocked), click-to-play overlay. Exports player interface. |
| `assets/js/players/direct.js` | `DirectPlayer` — create `<video>` element, event handlers, play/pause/seek/ended. Exports player interface. |
| `assets/js/players/extension.js` | `ExtensionPlayer` — placeholder UI, polling interval, media info updates. Exports player interface. |
| `assets/js/sponsor_block.js` | Segment storage, seek bar injection, auto-skip detection, skip toast UI. |
| `assets/js/ui/toasts.js` | `showToast()`, `showSkipToast()` — extracted from video_player. |
| `assets/js/ui/queue_finished.js` | `showQueueFinished()` — builds the queue-ended screen DOM. |

**Player interface contract** (each player exports):

```javascript
export function create(el, hook) → player instance
// player instance has:
//   play(), pause(), seek(seconds), destroy()
//   getCurrentTime() → number
//   getDuration() → number
//   getState() → "playing" | "paused" | "buffering" | "ended" | null
```

**Persistence:**

| File | Responsibility |
|------|----------------|
| `lib/byob/db/migrations.ex` | Schema version check on load, numbered migration functions (`migrate_1_to_2/1`, etc.) |

Changes to `lib/byob/persistence.ex`: add `schema_version` column, pass version on save, check+migrate on load.

### Track 2: YouTube Comments

| File | Responsibility |
|------|----------------|
| `lib/byob/youtube/comments.ex` | Fetch from YouTube Data API v3, ETS cache, quota tracking |
| `lib/byob_web/live/room_live/comments.ex` | `handle_event` for `"comments:load_more"`. `handle_info` for `{:comments_result, _}`. Function component for comments panel. |
| `test/byob/youtube/comments_test.exs` | Unit tests for comment fetching, caching, quota handling |

Changes to existing files:
- `lib/byob/room_server.ex` — spawn comment fetch task on video change (YouTube only), handle `{:comments_result, _}`
- `lib/byob_web/live/room_live.ex` — render comments component below player
- `lib/byob_web/live/room_live/pubsub.ex` — handle `{:comments_updated, _}` broadcast
- `config/runtime.exs` — read `YOUTUBE_API_KEY` env var

---

## Phase 1: LiveView Split

### Task 1.1: Create RoomLive event delegation skeleton

Set up the module structure so events route to submodules. No behavior changes — pure refactor.

**Pattern:** Phoenix LiveView supports splitting by defining `handle_event/3` in the main module that delegates based on event name prefix, or by using `defdelegate`. The cleanest approach: define each submodule as a plain module with public functions that take and return socket, then call them from RoomLive's `handle_event/3`.

- [ ] Read `lib/byob_web/live/room_live.ex` fully to confirm line mapping
- [ ] Create `lib/byob_web/live/room_live/url_preview.ex` — module `ByobWeb.RoomLive.UrlPreview` with stub functions matching each event: `handle_url_focus/2`, `handle_url_blur/2`, `handle_preview_url/2`, `handle_add_url/2`, `handle_play_now/2`, `handle_queue/2`, `handle_preview_result/2`
- [ ] Move the event handler bodies from `room_live.ex` lines 122-180, 187-209, 424-441 into the corresponding functions in `url_preview.ex`. Each function takes `(params, socket)` and returns `{:noreply, socket}`.
- [ ] In `room_live.ex`, replace the moved `handle_event` clauses with delegations: `def handle_event("preview_url", params, socket), do: UrlPreview.handle_preview_url(params, socket)` etc. Same for `handle_info({:url_preview_result, _})`.
- [ ] Run `mix compile` — no warnings
- [ ] Run `mix test` — all tests pass
- [ ] Commit: "refactor: extract UrlPreview event handlers from RoomLive"

### Task 1.2: Extract Playback event handlers

- [ ] Create `lib/byob_web/live/room_live/playback.ex` — module `ByobWeb.RoomLive.Playback`
- [ ] Move event handlers from `room_live.ex` lines 211-248, 316-320 (play, pause, seek, ended, embed_blocked, sync:ping, analytics:has_extension)
- [ ] Delegate from `room_live.ex`
- [ ] `mix compile` — no warnings
- [ ] `mix test` — all pass
- [ ] Commit: "refactor: extract Playback event handlers from RoomLive"

### Task 1.3: Extract Queue event handlers

- [ ] Create `lib/byob_web/live/room_live/queue.ex` — module `ByobWeb.RoomLive.Queue`
- [ ] Move event handlers from `room_live.ex` lines 182-185, 250-272, 274-277 (skip, remove, play_index, reorder, history:play, switch_tab, sb:update)
- [ ] Delegate from `room_live.ex`
- [ ] `mix compile` — no warnings
- [ ] `mix test` — all pass
- [ ] Commit: "refactor: extract Queue event handlers from RoomLive"

### Task 1.4: Extract Username event handlers

- [ ] Create `lib/byob_web/live/room_live/username.ex` — module `ByobWeb.RoomLive.Username`
- [ ] Move event handlers from `room_live.ex` lines 279-314 (username:edit, username:cancel, username:change)
- [ ] Delegate from `room_live.ex`
- [ ] `mix compile` — no warnings
- [ ] `mix test` — all pass
- [ ] Commit: "refactor: extract Username event handlers from RoomLive"

### Task 1.5: Extract PubSub handlers

- [ ] Create `lib/byob_web/live/room_live/pubsub.ex` — module `ByobWeb.RoomLive.PubSub`
- [ ] Move all `handle_info` clauses from lines 324-477 (sync_play, sync_pause, sync_seek, sync_correction, queue_updated, sponsor_segments, queue_ended, video_changed, sb_settings_updated, extension_player_state, users_updated, activity_log_updated, activity_log_entry). Keep the catchall `handle_info(_msg, socket)` in RoomLive.
- [ ] Each function: `handle_sync_play(data, socket)` returns `{:noreply, socket}`
- [ ] Delegate from `room_live.ex`: `def handle_info({:sync_play, data}, socket), do: PubSub.handle_sync_play(data, socket)` etc.
- [ ] `mix compile` — no warnings
- [ ] `mix test` — all pass
- [ ] Commit: "refactor: extract PubSub handlers from RoomLive"

### Task 1.6: Extract template components

- [ ] Create `lib/byob_web/live/room_live/components.ex` — module `ByobWeb.RoomLive.Components` with `use Phoenix.Component`
- [ ] Move function components and helpers: `sb_row/1`, `format_log_entry/1`, `dedup_users/2`, `is_self_user/2`, `extension_open_url/2`, `show_url?/1`, `format_time/1`
- [ ] Extract sidebar sections from the template into function components: `queue_panel/1`, `history_panel/1`, `activity_log/1`, `users_card/1`, `url_preview_dropdown/1`
- [ ] Update the main `render/1` in `room_live.ex` to call these components: `<.queue_panel queue={@queue} ... />`
- [ ] `mix compile` — no warnings
- [ ] `mix test` — all pass
- [ ] Manual test: start dev server, create room, verify sidebar renders correctly
- [ ] Commit: "refactor: extract template components from RoomLive"

### Task 1.7: Clean up RoomLive

After all extractions, `room_live.ex` should contain only: `mount/3`, `render/1`, `handle_params/3`, delegation clauses, `sync_state_payload/2`, `serialize_item/1`, `ensure_room_pid/1`.

- [ ] Review `room_live.ex` — verify it's under 300 lines
- [ ] Remove any dead code or unused imports
- [ ] `mix compile` — no warnings
- [ ] `mix test` — all pass
- [ ] Commit: "refactor: clean up RoomLive after extraction"

---

## Phase 2: JavaScript Split

### Task 2.1: Extract sync modules

The three inline classes (`ClockSync`, `Suppression`, `Reconcile`) at the top of `video_player.js` are already self-contained. Move them to separate files.

- [ ] Read current `video_player.js` to locate the three classes (they're defined inline at the top)
- [ ] Create `assets/js/sync/clock.js` — export `ClockSync` class as-is
- [ ] Create `assets/js/sync/suppression.js` — export `Suppression` class as-is
- [ ] Create `assets/js/sync/reconcile.js` — export `Reconcile` class as-is
- [ ] In `video_player.js`, replace inline classes with `import { ClockSync } from "../sync/clock"` etc.
- [ ] `mix phx.server` — verify dev server builds JS without errors
- [ ] Manual test: open room, play a YouTube video, verify sync works (play/pause from another tab)
- [ ] Commit: "refactor: extract sync classes to separate JS modules"

### Task 2.2: Extract player modules

- [ ] Create `assets/js/players/youtube.js` — export object with: `create(el, hook)`, returning `{ play(), pause(), seek(t), destroy(), getCurrentTime(), getDuration(), getState() }`. Move `_loadYouTube`, `_onYTStateChange`, `_onYTError`, click-to-play overlay logic. The player callbacks (reporting events to server) come via a `callbacks` param passed to `create()`.
- [ ] Create `assets/js/players/direct.js` — same interface. Move `_loadDirectUrl` and the HTML5 video event handlers.
- [ ] Create `assets/js/players/extension.js` — same interface. Move extension placeholder UI creation, `_onExtPlayerState`, `_onExtMediaInfo`, polling interval.
- [ ] Update `video_player.js` to import and use the player modules. `_loadVideo` becomes: pick player module by sourceType, call `player.create(el, hook)`, store as `this.player`.
- [ ] Update `_getCurrentTime`, `_seekTo`, `_play`, `_pause`, `_setPlaybackRate` to use `this.player` interface instead of checking `this.sourceType`.
- [ ] `mix phx.server` — verify dev build
- [ ] Manual test: play YouTube video, play direct video URL, verify both work
- [ ] Commit: "refactor: extract player modules with common interface"

### Task 2.3: Extract SponsorBlock and UI modules

- [ ] Create `assets/js/sponsor_block.js` — export functions: `setSegments(data)`, `applySettings(settings, player)`, `checkSkip(player, settings, callback)`, `sendToEmbed(iframe, segments, duration)`. Move `_onSponsorSegments`, `_applySponsorSettings`, `_sendSegmentsToEmbed`, `_retrySponsorBar`, the skip detection from `_startSeekDetector`.
- [ ] Create `assets/js/ui/toasts.js` — export `showToast(el, text)`, `showSkipToast(el, category, labels)`. Move `_showToast`, `_showSkipToast`.
- [ ] Create `assets/js/ui/queue_finished.js` — export `showQueueFinished(el, title, thumbnail)`. Move `_onQueueEnded` DOM creation.
- [ ] Update `video_player.js` to import these modules
- [ ] `mix phx.server` — verify dev build
- [ ] Manual test: verify SponsorBlock segments show on seek bar, verify toast on skip, verify queue finished screen
- [ ] Commit: "refactor: extract SponsorBlock and UI modules"

### Task 2.4: Clean up video_player.js

- [ ] Review `video_player.js` — verify it's under 200 lines (hook lifecycle + event routing + seek detector)
- [ ] Remove dead code, unused variables
- [ ] `mix phx.server` — verify build
- [ ] `mix test` — all pass (LiveView tests still work)
- [ ] Full manual test: create room, add YouTube video, add direct video, verify sync between 2 tabs, verify queue advance, verify queue finished screen
- [ ] Commit: "refactor: clean up video_player.js after extraction"

---

## Phase 3: SQLite Schema Versioning

### Task 3.1: Add schema_version column and migration framework

- [ ] Read `lib/byob/persistence.ex` to confirm current schema
- [ ] Write test in `test/byob/persistence_test.exs`: loading a room saved without schema_version should return version 1 state
- [ ] Run test — should fail (no schema_version handling yet)
- [ ] In `lib/byob/persistence.ex`, add migration in `init`: `ALTER TABLE rooms ADD COLUMN schema_version INTEGER DEFAULT 1` (SQLite ADD COLUMN is safe if column exists — wrap in try/rescue or check pragma)
- [ ] Update `save_room/2` to write `schema_version = @current_version` alongside state
- [ ] Update `load_room/1` to read `schema_version`, pass to migration runner
- [ ] Run test — should pass
- [ ] Commit: "feat: add schema_version column to rooms table"

### Task 3.2: Create migration runner

- [ ] Create `lib/byob/db/migrations.ex` — module `Byob.DB.Migrations`
- [ ] Write test: `migrate(state, 1, 2)` adds expected new fields with defaults
- [ ] Run test — should fail
- [ ] Implement: `def run(state, from_version, to_version)` — loops `from_version` to `to_version`, calling `migrate_N_to_N+1(state)` for each step
- [ ] Implement `migrate_1_to_2/1` — identity function for now (v3 refactor doesn't change state shape yet, but the framework is in place)
- [ ] Run test — should pass
- [ ] Wire into `persistence.ex` `load_room/1`: after loading, run migrations if version < current
- [ ] `mix test` — all pass
- [ ] Commit: "feat: SQLite state migration framework"

---

## Phase 4: Multi-Instance Audit

### Task 4.1: Audit and document scaling constraints

This is a documentation task, not a code change.

- [ ] Read `room_server.ex` — verify all inter-process communication uses Phoenix.PubSub (not direct `send/2` to known pids)
- [ ] Read `lib/byob/room_manager.ex` — check if room lookup uses Registry or a global name
- [ ] Read `lib/byob/persistence.ex` — note SQLite is single-writer (would need Postgres or similar for multi-instance)
- [ ] Create `docs/scaling.md` documenting: what works today, what would need to change for multi-instance (PubSub adapter, room registry, DB, sticky sessions)
- [ ] Commit: "docs: add scaling constraints documentation"

---

## Phase 5: YouTube Comments Panel

### Task 5.1: Add YOUTUBE_API_KEY config

- [ ] In `config/runtime.exs`, add: `config :byob, :youtube_api_key, System.get_env("YOUTUBE_API_KEY")`
- [ ] Update `CLAUDE.md` environment variables section to include `YOUTUBE_API_KEY`
- [ ] `mix compile` — no warnings
- [ ] Commit: "config: add YOUTUBE_API_KEY environment variable"

### Task 5.2: Build Byob.YouTube.Comments module — fetching

- [ ] Write test `test/byob/youtube/comments_test.exs`:
  - Test `fetch/1` with a mocked HTTP response returning 2 comments
  - Test response parsing: extracts author, avatar, text, likes, reply_count, published_at
  - Test `fetch/1` with comments disabled (empty items list) returns `{:ok, []}`
  - Test `fetch/1` with quota exceeded (403) returns `{:error, :quota_exhausted}`
  - Test `fetch/1` when no API key configured returns `{:error, :not_configured}`
- [ ] Run tests — should fail
- [ ] Create `lib/byob/youtube/comments.ex` — module `Byob.YouTube.Comments`
- [ ] Implement `fetch(video_id, opts \\ [])`:
  - Check `Application.get_env(:byob, :youtube_api_key)` — return `{:error, :not_configured}` if nil
  - Check quota flag — return `{:error, :quota_exhausted}` if set for today
  - Build URL: `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=#{video_id}&order=relevance&maxResults=20&textFormat=plainText&key=#{api_key}`
  - If `opts[:page_token]`, append `&pageToken=#{token}`
  - HTTP GET via `Req.get!` (already a dependency in mix.exs)
  - Parse response: extract `items[].snippet.topLevelComment.snippet.{authorDisplayName, authorProfileImageUrl, textDisplay, likeCount, publishedAt}` and `items[].snippet.totalReplyCount`
  - Return `{:ok, %{comments: list, next_page_token: body["nextPageToken"], total_count: body["pageInfo"]["totalResults"]}}`
  - On 403 with quotaExceeded: set flag, return `{:error, :quota_exhausted}`
- [ ] Run tests — should pass
- [ ] Commit: "feat: YouTube comments fetcher module"

### Task 5.3: Add ETS cache layer

- [ ] Write test: fetching same video_id twice within 15min returns cached result (mock HTTP called only once)
- [ ] Write test: fetching after cache expires makes new HTTP request
- [ ] Run tests — should fail
- [ ] Add ETS table creation in `Application.start/2`: `:ets.new(:youtube_comments_cache, [:named_table, :public, :set])`
- [ ] In `fetch/1`, check ETS first: if cached and age < 15 minutes, return cached
- [ ] After successful fetch, store in ETS: `{video_id, result, DateTime.utc_now()}`
- [ ] Run tests — should pass
- [ ] Commit: "feat: ETS cache for YouTube comments (15min TTL)"

### Task 5.4: RoomServer integration — fetch on video change

- [ ] Write test in `room_server_test.exs`: when a YouTube video starts playing, room broadcasts `{:comments_updated, _}` (may need to mock the API or use a test API key)
- [ ] Run test — should fail
- [ ] In `room_server.ex`, in `advance_queue/1` and `handle_call({:play_index, ...})` and `add_item_to_queue/3` (when mode is `:now` or queue was empty): after setting the new current video, if source_type is `:youtube`, spawn `Task.start(fn -> ... end)` to fetch comments
- [ ] Add `handle_info({:comments_result, video_id, result})` — only broadcast if `video_id` matches current video. Broadcast `{:comments_updated, %{video_id: video_id, comments: comments, next_page_token: token, total_count: count}}`
- [ ] Run test — should pass
- [ ] `mix test` — all pass
- [ ] Commit: "feat: RoomServer fetches YouTube comments on video change"

### Task 5.5: LiveView — comments assigns and PubSub handler

- [ ] Add `comments: nil, comments_next_page: nil, comments_video_id: nil, comments_total: nil` to mount assigns
- [ ] In `pubsub.ex`, add `handle_comments_updated(data, socket)`:
  - Assign `comments: data.comments`, `comments_next_page: data.next_page_token`, `comments_video_id: data.video_id`, `comments_total: data.total_count`
- [ ] In `room_live.ex`, add delegation: `def handle_info({:comments_updated, data}, socket), do: PubSub.handle_comments_updated(data, socket)`
- [ ] Clear comments on video change: in `handle_info({:video_changed, _})`, assign `comments: nil`
- [ ] `mix compile` — no warnings
- [ ] `mix test` — all pass
- [ ] Commit: "feat: LiveView assigns for YouTube comments"

### Task 5.6: LiveView — load more event

- [ ] In `lib/byob_web/live/room_live/comments.ex`, create module `ByobWeb.RoomLive.Comments`
- [ ] Implement `handle_load_more(params, socket)`:
  - Get `socket.assigns.comments_video_id` and `socket.assigns.comments_next_page`
  - Return `{:noreply, socket}` if either is nil
  - Spawn task to fetch next page: `Task.start(fn -> ... end)` with `send(self(), {:comments_page_result, video_id, result})`
  - (The task sends result back to LiveView process, not RoomServer — pagination is per-client, not broadcast)
- [ ] Add `handle_info({:comments_page_result, video_id, {:ok, result}}, socket)`:
  - Only apply if `video_id == socket.assigns.comments_video_id`
  - Append `result.comments` to `socket.assigns.comments`
  - Update `comments_next_page`
- [ ] Delegate from `room_live.ex`: `def handle_event("comments:load_more", params, socket), do: Comments.handle_load_more(params, socket)` and `def handle_info({:comments_page_result, _, _} = msg, socket), do: Comments.handle_page_result(msg, socket)`
- [ ] `mix compile` — no warnings
- [ ] Commit: "feat: load more comments pagination"

### Task 5.7: Comments panel component

- [ ] In `lib/byob_web/live/room_live/comments.ex`, add function component `comments_panel/1`:
  - Accepts assigns: `comments`, `comments_total`, `comments_next_page`
  - Renders nothing if `@comments` is nil or empty
  - Container: `div` with `max-h-[200px] overflow-y-auto` below the player
  - Header: "Comments" + count badge (`@comments_total`)
  - Each comment: flex row with 28px round avatar, author name (bold, small), relative time, comment text, like count, reply count
  - Bottom: "Load more" button with `phx-click="comments:load_more"` (only if `@comments_next_page`)
  - Bottom gradient overlay to hint scrollability
- [ ] In `room_live.ex` render, add `<Comments.comments_panel comments={@comments} comments_total={@comments_total} comments_next_page={@comments_next_page} />` below the player div (after the aspect-ratio wrapper, before the sidebar)
- [ ] `mix compile` — no warnings
- [ ] Manual test: start dev server, paste a YouTube URL, verify comments appear below player
- [ ] Manual test: verify comments disappear when switching to a direct video URL
- [ ] Manual test: scroll comments, click "Load more", verify pagination works
- [ ] Commit: "feat: YouTube comments panel component"

### Task 5.8: Relative time formatting

YouTube API returns ISO 8601 timestamps. Need to display as "2 months ago", "3 weeks ago", etc.

- [ ] Add a helper function `relative_time/1` in `comments.ex` that converts a DateTime/ISO string to relative text
- [ ] Handle: seconds ago, minutes ago, hours ago, days ago, weeks ago, months ago, years ago
- [ ] Use in the comments panel template for `published_at`
- [ ] Manual test: verify timestamps display correctly
- [ ] Commit: "feat: relative time formatting for comment timestamps"

---

## Phase 6: Final Verification & Release

### Task 6.1: Full test suite and manual verification

- [ ] `mix test` — all tests pass
- [ ] `mix compile --warnings-as-errors` — no warnings
- [ ] Manual test: full user flow
  - Create room, share link, open in 2 tabs
  - Paste YouTube URL, verify sync play/pause/seek between tabs
  - Verify comments panel appears with content
  - Scroll comments, load more
  - Paste direct video URL, verify comments panel disappears
  - Skip back to YouTube video, verify comments reappear
  - Let queue finish, verify queue-finished screen shows title + thumbnail
  - Verify SponsorBlock segments on seek bar
  - Verify activity log, user list, history all work
- [ ] Commit any fixes found during testing

### Task 6.2: Update docs and version

- [ ] Update `CHANGELOG.md` with v3.0.0 section
- [ ] Update `CLAUDE.md` with new module structure, `YOUTUBE_API_KEY` env var
- [ ] Bump version: `echo "3.0.0" > VERSION && just sync-version`
- [ ] Commit: "v3.0.0: architecture refactor + YouTube comments panel"
- [ ] Tag: `git tag v3.0.0`
