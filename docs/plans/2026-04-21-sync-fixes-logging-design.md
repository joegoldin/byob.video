# Sync Fixes & Debug Logging — Design Spec

**Date:** 2026-04-21
**Status:** Approved for implementation planning

## Goal

Fix two sync bugs and add structured debug logging:

1. **Extension autoplay** — browser autoplay policy blocks programmatic `video.play()` on third-party sites. Add a "click to join playback" gesture overlay so the first play succeeds, then all subsequent sync commands work.
2. **YouTube stutter on resume** — when a host pauses, a friend joins, then the host resumes, the friend's player echo-loops (or never starts). Root cause: cue-only load, single-shot suppression, redundant broadcasts, and outbound events during buffering.
3. **Debug logging** — the sync core (room_server, room_live, extension_channel) has zero Logger calls. Add structured, privacy-safe logging at key sync points so production issues are diagnosable from logs.

## Non-goals

- No changes to the reconcile/drift-correction algorithm itself.
- No changes to clock sync (NTP probes).
- No new analytics events in PostHog — this is Elixir Logger only.
- No user-facing log viewer or admin panel.
- No changes to the main byob.video YouTube player's existing click-to-play overlay (that already works).

---

## Workstream 1: Extension Autoplay Overlay

### Problem

Browsers require a user gesture (click/tap) before allowing `video.play()`. The extension currently calls `hookedVideo.play()` programmatically from `command:play` in `content.js:312-317`, which silently fails on sites like Crunchyroll. The video stays paused, a "paused" event leaks back to the server, and the sync bar flashes "Playing/Paused" rapidly.

Confirmed: enabling "Allow Audio and Video" autoplay in Firefox site permissions makes it work. The fix is to obtain a user gesture.

### Design

Change the initial sync flow in the extension so a user click is always obtained before enabling bidirectional sync.

#### New flow

1. Content script detects and hooks a `<video>` element, sends `video:hooked` to service worker (unchanged).
2. Service worker requests room state via `sync:request_state` (unchanged).
3. **Changed**: service worker sends `command:initial-state` (new message type) back to the content script instead of directly sending `command:play`/`command:pause`/`command:seek`/`command:synced`.
4. Content script receives `command:initial-state` with `{ play_state, current_time }`:
   - **Always** show an overlay: "Click to join playback" anchored over or near the hooked video element.
   - On click: call `hookedVideo.play()` (user gesture provides autoplay unlock) → on success, immediately pause, seek to `current_time`, then apply room state (play or stay paused). Send `command:synced` locally to enable bidirectional sync.
   - If room is paused: after the gesture-play-then-pause, the video sits at the correct position, ready.
   - If room is playing: after the gesture-play-then-pause-then-seek, immediately call `play()` again — it now succeeds because the page is gesture-unlocked.

#### Overlay design

- Semi-transparent dark overlay with centered play button icon and "Click to join playback" text.
- Positioned over the hooked video element (absolute positioning relative to video's offset parent, or fixed if video is fullscreen).
- Auto-dismissed on click. Also dismissed if the user manually clicks play on the site's native player (detect via the existing `play` event listener — if we see a user-initiated play before the overlay click, treat it as the gesture).
- Sync bar updates to "Click to join" status while overlay is shown.

#### Files changed

- `extension/content.js`: Add overlay injection/dismissal logic. Handle `command:initial-state`. Restructure the post-hook flow.
- `extension/background.js`: In `video:hooked` handler (~line 42-58), send `command:initial-state` instead of `command:play`/`command:pause`/`command:seek`/`command:synced`.

---

## Workstream 2: YouTube Stutter Fix

### Problem

Scenario: Host creates room → queues YouTube video → pauses at start → friend joins → host hits play → friend's player never starts (or host's stutters).

Root causes identified:

1. **Cue-only load**: Friend joins paused room → `cueVideoById` shows thumbnail but doesn't load the video. On resume, YouTube has to load from scratch, causing extended BUFFERING state.
2. **Single-shot suppression**: `Suppression.shouldSuppress()` clears on the first matching event. YouTube fires multiple state changes during load (BUFFERING → PLAYING, or BUFFERING → PAUSED → PLAYING). The first event consumes suppression, subsequent events leak through.
3. **Redundant broadcasts**: Server broadcasts `sync:play` / `sync:pause` even when no state transition occurs (already playing/already paused). These redundant broadcasts cause unnecessary seek+play cycles on all clients.
4. **Outbound events during buffering**: `_onPlayerStateChange` pushes `video:play`/`video:pause` to the server even when YouTube is transitioning through transient states during load. These pollute the server state.
5. **stateCheckInterval mismatch during buffering**: When expectedPlayState is "playing" but YouTube is buffering (not yet playing), the 500ms mismatch timer triggers a force-play, which causes another round of state changes.

### Fix 1: Load instead of cue

**File**: `assets/js/hooks/video_player.js`, `_applyPendingState` (~line 206-218)

Current code:
```javascript
} else if (state.play_state === "paused") {
  this.expectedPlayState = "paused";
  this.suppression.suppress("paused");
  if (this.sourceType === "youtube" && this.player?.cueVideoById) {
    this.player.cueVideoById({
      videoId: this.sourceId,
      startSeconds: state.current_time,
    });
  } else {
    this._seekTo(state.current_time);
  }
}
```

Change to: Use `loadVideoById` with `startSeconds`, then immediately pause once the player fires `PLAYING` or `BUFFERING`. Set a flag `_loadingPaused = true` to suppress all outbound events until the load-then-pause sequence completes.

### Fix 2: Time-window suppression

**File**: `assets/js/sync/suppression.js`

Current behavior: `suppress("playing")` → first "playing" event clears suppression → subsequent events leak.

New behavior: `suppress("playing")` → all events suppressed for a time window (2 seconds) OR until the terminal state is reached and a settling period (200ms) has passed. This handles YouTube's multi-event sequences (BUFFERING → PAUSED → PLAYING → PLAYING) without leaking intermediate states.

```javascript
suppress(expectedState) {
  this.gen++;
  this.suppressUntilGen = this.gen;
  this.expectedState = expectedState;
  this.terminalReached = false;
  this.terminalAt = null;

  if (this.safetyTimeout) clearTimeout(this.safetyTimeout);
  this.safetyTimeout = setTimeout(() => {
    this.suppressUntilGen = 0;
    this.expectedState = null;
  }, 3000); // safety fallback unchanged
}

shouldSuppress(currentState) {
  if (this.suppressUntilGen === 0) return false;

  if (currentState === this.expectedState) {
    if (!this.terminalReached) {
      this.terminalReached = true;
      this.terminalAt = performance.now();
    }
    // Keep suppressing for 200ms after terminal state, to catch double-fires
    if (performance.now() - this.terminalAt > 200) {
      this._clear();
    }
  }
  // Suppress ALL events while active, not just matching ones
  return true;
}
```

This is a behavior change: previously, non-matching events cleared suppression and passed through. Now, all events are suppressed during the window. This is correct because during a programmatic command, we don't want *any* player state changes to propagate — the server already knows the target state.

**Extension content.js**: Apply the same suppression pattern (the extension has its own inline suppression). Change `shouldSuppress` to match the new time-window behavior.

### Fix 3: Skip redundant broadcasts

**File**: `lib/byob/room_server.ex`

Play handler (line 307): Move broadcast inside the `if was_paused` block.
```elixir
# Only broadcast on real state transitions
if was_paused do
  broadcast(state, {:sync_play, %{time: position, server_time: now, user_id: user_id}})
end
```

Pause handler (line 339): Move broadcast inside the `if was_playing` block.
```elixir
if was_playing do
  broadcast(state, {:sync_pause, %{time: position, server_time: now, user_id: user_id}})
end
```

This means a client echoing `video:play` when the server is already playing gets silently dropped. The existing rate limiter already handles abuse; this just prevents amplification.

### Fix 4: Gate outbound events on player readiness

**File**: `assets/js/hooks/video_player.js`, `_onPlayerStateChange` (~line 396)

Add a `_playerSettled` flag. Set it to `false` when loading a video (`_loadVideo`, `_applyPendingState`). Set it to `true` once the player reaches a stable playing or paused state for the first time after load (not during BUFFERING transitions).

In `_onPlayerStateChange`, early-return (without pushing to server) if `!this._playerSettled`. The suppression still runs (so we consume expected events), but nothing reaches the server until the player is stable.

Also: when YouTube reports BUFFERING (`stateName === "buffering"` — currently not handled in `_onPlayerStateChange`), explicitly do nothing. Don't push to server, don't update expectedPlayState.

### Fix 5: Buffering tolerance in stateCheckInterval

**File**: `assets/js/hooks/video_player.js`, stateCheckInterval (~line 795)

Current code at line 795-810: if `localState !== this.expectedPlayState`, start a 500ms timer then force-correct.

Add: if `localState === "buffering" && this.expectedPlayState === "playing"`, treat it as matching (reset `_mismatchSince`). The existing 5-second stuck-buffering handler at line 770-790 already covers the case where buffering goes on too long. The 500ms mismatch path should not fire during normal buffering.

---

## Workstream 3: Debug Logging

### Problem

The sync core has zero Logger calls. When users report bugs, there's no way to see what happened in production.

### Privacy model

- **Video URLs**: Never logged. Instead, log a 12-character hex hash: `url |> :crypto.hash(:sha256) |> Base.encode16(case: :lower) |> binary_part(0, 12)`. Enough to correlate events for the same video, not reversible.
- **User IDs**: Already random UUIDs (`session_id:tab_id`), safe to log as-is.
- **Room IDs**: Random strings, safe to log.
- **Usernames, titles, chat**: Never logged.
- **Positions/timestamps**: Safe to log (no PII).

### Helper module

**New file**: `lib/byob/sync_log.ex`

```elixir
defmodule Byob.SyncLog do
  require Logger

  def hash_url(nil), do: "none"
  def hash_url(url) do
    :crypto.hash(:sha256, url)
    |> Base.encode16(case: :lower)
    |> binary_part(0, 12)
  end

  def play(room_id, user_id, url, position, transition) do
    Logger.info("[sync:play] room=#{room_id} user=#{user_id} video=#{hash_url(url)} pos=#{Float.round(position, 1)} #{transition}")
  end

  def pause(room_id, user_id, url, position, transition) do
    Logger.info("[sync:pause] room=#{room_id} user=#{user_id} video=#{hash_url(url)} pos=#{Float.round(position, 1)} #{transition}")
  end

  def seek(room_id, user_id, url, position) do
    Logger.info("[sync:seek] room=#{room_id} user=#{user_id} video=#{hash_url(url)} pos=#{Float.round(position, 1)}")
  end

  def join(room_id, user_id, user_count) do
    Logger.info("[sync:join] room=#{room_id} user=#{user_id} users=#{user_count}")
  end

  def snapshot(room_id, user_id, play_state, position) do
    Logger.info("[sync:snapshot] room=#{room_id} user=#{user_id} state=#{play_state} pos=#{Float.round(position, 1)}")
  end

  def ext_join(room_id, user_id) do
    Logger.info("[sync:ext_join] room=#{room_id} user=#{user_id}")
  end

  def ext_event(room_id, event, user_id) do
    Logger.info("[sync:ext:#{event}] room=#{room_id} user=#{user_id}")
  end

  def heartbeat(room_id, play_state, position) do
    Logger.debug("[sync:heartbeat] room=#{room_id} state=#{play_state} pos=#{Float.round(position, 1)}")
  end

  def redundant(room_id, event, user_id) do
    Logger.debug("[sync:redundant] room=#{room_id} event=#{event} user=#{user_id}")
  end
end
```

### Call sites

**`lib/byob/room_server.ex`**:
- Play handler (~line 267): Log on real transition (`was_paused`), log `redundant` otherwise.
- Pause handler (~line 312): Log on real transition (`was_playing`), log `redundant` otherwise.
- Seek handler (~line 344): Log every seek.
- Join handler (~line 215): Log join with user count.
- Snapshot delivery (wherever `snapshot/1` is called): Log state sent to joining client.
- Heartbeat (~line 816): Log at debug level (frequent, only visible when debug logging enabled).

**`lib/byob_web/channels/extension_channel.ex`**:
- `join/3`: Log extension join.
- `handle_in` for play/pause/seek/ended: Log extension events.

**`lib/byob_web/live/room_live/pubsub.ex`**: No logging needed (thin pass-through, would duplicate room_server logs).

### Log levels

- `:info` for state transitions (play, pause, seek, join, snapshot) — always visible in prod.
- `:debug` for heartbeats and redundant events — only visible when debug logging is enabled.

---

## Files Changed Summary

| File | Workstream | Change |
|------|-----------|--------|
| `extension/content.js` | 1, 2 | Autoplay overlay, updated suppression |
| `extension/background.js` | 1 | `command:initial-state` message |
| `assets/js/sync/suppression.js` | 2 | Time-window suppression |
| `assets/js/hooks/video_player.js` | 2 | Load-not-cue, player readiness gate, buffering tolerance |
| `lib/byob/room_server.ex` | 2, 3 | Skip redundant broadcasts, add logging |
| `lib/byob/sync_log.ex` | 3 | New helper module |
| `lib/byob_web/channels/extension_channel.ex` | 3 | Add logging |

## Testing approach

- **Extension autoplay**: Manual test on Crunchyroll, Dailymotion, random video sites — verify overlay appears, click unlocks playback, subsequent syncs work without gesture.
- **Stutter fix**: Manual test: create room → queue YouTube video → pause → open second browser/incognito → join → resume. Verify both clients play smoothly. Also test: rapid pause/resume by host, seek during playback, queue advance.
- **Logging**: Check `mix phx.server` output during manual testing. Verify video URLs never appear, hashes are consistent, state transitions are logged.
