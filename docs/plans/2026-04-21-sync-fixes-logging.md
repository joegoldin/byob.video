# Sync Fixes & Debug Logging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix extension autoplay failures on third-party sites, eliminate the YouTube stutter/echo-loop on resume after a paused join, and add structured privacy-safe logging to the sync core.

**Architecture:** Three independent workstreams touching distinct layers. Workstream 1 (extension overlay) is entirely in browser extension JS. Workstream 2 (stutter fix) spans client JS (`suppression.js`, `video_player.js`) and one server file (`room_server.ex`). Workstream 3 (logging) adds a new Elixir module and call sites in `room_server.ex` and `extension_channel.ex`. No database changes. No new dependencies.

**Tech Stack:** Elixir/Phoenix (server), vanilla JS (extension + client hooks), YouTube IFrame API.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `assets/js/sync/suppression.js` | Modify | Time-window suppression replacing single-shot |
| `assets/js/hooks/video_player.js` | Modify | Load-not-cue, player readiness gate, buffering tolerance in stateCheckInterval |
| `extension/background.js` | Modify | Send `command:initial-state` instead of direct play/pause/seek commands |
| `extension/content.js` | Modify | Autoplay overlay, handle `command:initial-state`, update inline suppression |
| `lib/byob/sync_log.ex` | Create | Privacy-safe structured logging helper |
| `lib/byob/room_server.ex` | Modify | Skip redundant broadcasts, add SyncLog calls |
| `lib/byob_web/channels/extension_channel.ex` | Modify | Add SyncLog calls |

---

## Task 1: Time-window suppression (`suppression.js`)

This is a dependency for both workstream 1 and 2, so we do it first.

**Context:** The current `Suppression` class in `assets/js/sync/suppression.js` (50 lines) uses a generation counter. `suppress("playing")` arms it; the very first event matching `"playing"` clears it. Any non-matching event also clears it and passes through. YouTube fires multi-event sequences (BUFFERING → PAUSED → PLAYING → PLAYING) during load, so intermediate events leak through and echo back to the server.

**New behavior:** After `suppress(expectedState)`, ALL events are suppressed (return `true` from `shouldSuppress`) until either (a) the expected terminal state is reached AND 200ms has elapsed, or (b) the 3-second safety timeout fires. No events pass through during the suppression window — the server already knows the target state from the command that triggered it.

- [ ] **1.1** Read `assets/js/sync/suppression.js` (the complete 50-line file shown above in the spec).

- [ ] **1.2** Replace the `Suppression` class with the time-window version. The full replacement for `assets/js/sync/suppression.js`:

```javascript
// Time-window suppression for echoed player events after programmatic commands.
// Suppresses ALL events for a window after a programmatic command, clearing
// only after the terminal state is reached + a settling period, or a safety timeout.
export class Suppression {
  constructor() {
    this.gen = 0;
    this.suppressUntilGen = 0;
    this.expectedState = null;
    this.terminalReached = false;
    this.terminalAt = null;
    this.safetyTimeout = null;
  }

  // Call before applying a remote command to the player.
  // expectedState: the state we expect to see ("playing", "paused", or null for seek).
  suppress(expectedState) {
    this.gen++;
    this.suppressUntilGen = this.gen;
    this.expectedState = expectedState;
    this.terminalReached = false;
    this.terminalAt = null;

    if (this.safetyTimeout) clearTimeout(this.safetyTimeout);
    this.safetyTimeout = setTimeout(() => {
      this._clear();
    }, 3000);
  }

  // Call from player state change handler. Returns true if event should be swallowed.
  shouldSuppress(currentState) {
    if (this.suppressUntilGen === 0) return false;

    if (currentState === this.expectedState || this.expectedState === null) {
      if (!this.terminalReached) {
        this.terminalReached = true;
        this.terminalAt = performance.now();
      }
      // Keep suppressing for 200ms after terminal state to catch double-fires
      if (performance.now() - this.terminalAt > 200) {
        this._clear();
      }
    }

    // Suppress ALL events while active, not just matching ones
    return true;
  }

  isActive() {
    return this.suppressUntilGen > 0;
  }

  _clear() {
    this.suppressUntilGen = 0;
    this.expectedState = null;
    this.terminalReached = false;
    this.terminalAt = null;
    if (this.safetyTimeout) {
      clearTimeout(this.safetyTimeout);
      this.safetyTimeout = null;
    }
  }

  destroy() {
    this._clear();
  }
}
```

- [ ] **1.3** Run `mix phx.server` and verify the app starts without JS build errors. Open a room with a YouTube video, play/pause a few times to confirm basic suppression still works (events don't echo).

- [ ] **1.4** Commit: `fix: time-window suppression to prevent echo loops during YouTube state transitions`

---

## Task 2: Player readiness gate + buffering tolerance (`video_player.js`)

**Context:** `assets/js/hooks/video_player.js` is 978 lines. We're touching three areas: (a) `_applyPendingState` around line 160, (b) `_onPlayerStateChange` around line 396, (c) `stateCheckInterval` around line 760.

- [ ] **2.1** Read `assets/js/hooks/video_player.js` lines 160-220 (`_applyPendingState`), lines 220-260 (`_loadVideo` start), lines 396-431 (`_onPlayerStateChange`), and lines 760-812 (stateCheckInterval). You already have this context from earlier reads.

- [ ] **2.2** Add a `_playerSettled` flag. In the hook's `mounted()` or initialization section (wherever `this.suppression` is initialized), add:
```javascript
this._playerSettled = true;
```
Set it to `true` by default so existing playing rooms work. It only gets set to `false` during load transitions.

- [ ] **2.3** In `_loadVideo` (line 221), add at the top of the function:
```javascript
this._playerSettled = false;
```
This gates outbound events while the player is loading a new video.

- [ ] **2.4** In `_onPlayerStateChange` (line 396), add a readiness gate and buffering handling. Replace the function:

**Current code (lines 396-431):**
```javascript
_onPlayerStateChange(stateName) {
    if (stateName && this.suppression.shouldSuppress(stateName)) {
      return;
    }

    if (stateName === "playing") {
      // ... pushes video:play to server
    } else if (stateName === "paused") {
      // ... pushes video:pause to server
    } else if (stateName === "ended") {
      // ... pushes video:ended
    }
  },
```

**New code:**
```javascript
_onPlayerStateChange(stateName) {
    // Always let suppression consume events (tracks terminal state)
    if (stateName && this.suppression.shouldSuppress(stateName)) {
      return;
    }

    // Buffering is transient — don't push to server, don't update expectedPlayState
    if (stateName === "buffering") {
      return;
    }

    // Mark player as settled on first stable state after load
    if (!this._playerSettled && (stateName === "playing" || stateName === "paused")) {
      this._playerSettled = true;
      // If we were loading-for-pause, the pause has landed — don't push it
      if (this._loadingPaused && stateName === "paused") {
        this._loadingPaused = false;
        return;
      }
    }

    // Don't push events to server until player is settled after load
    if (!this._playerSettled) {
      return;
    }

    if (stateName === "playing") {
      this.expectedPlayState = "playing";
      window.__byobPlaying = true;
      const position = this.player.getCurrentTime();
      this.pushEvent("video:play", { position });
      const serverTime = this.clockSync.serverNow();
      this.reconcile.setServerState(position, serverTime, this.clockSync);
      this.reconcile.pauseFor(1000);
      this.reconcile.start();
    } else if (stateName === "paused") {
      this.expectedPlayState = "paused";
      window.__byobPlaying = false;
      const position = this.player.getCurrentTime();
      this.pushEvent("video:pause", { position });
      this.reconcile.stop();
    } else if (stateName === "ended") {
      this.expectedPlayState = null;
      window.__byobPlaying = false;
      this.reconcile.stop();
      if (!this._endedFired) {
        this._endedFired = true;
        const currentIndex = this.el.dataset.currentIndex;
        if (currentIndex != null) {
          this.pushEvent("video:ended", { index: parseInt(currentIndex) });
        }
      }
    }
  },
```

- [ ] **2.5** Fix `_applyPendingState` paused branch to use `loadVideoById` instead of `cueVideoById`. Replace the paused branch (lines 206-218):

**Current:**
```javascript
} else if (state.play_state === "paused") {
      this.expectedPlayState = "paused";
      this.suppression.suppress("paused");
      // Use cueVideoById to show thumbnail at the right position without playing
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

**New:**
```javascript
} else if (state.play_state === "paused") {
      this.expectedPlayState = "paused";
      this.suppression.suppress("paused");
      if (this.sourceType === "youtube" && this.player?.loadVideoById) {
        // Load fully (not cue) so the video is ready to play instantly on resume.
        // _loadingPaused flag tells _onPlayerStateChange to swallow the pause event
        // once the load completes, rather than echoing it to the server.
        this._loadingPaused = true;
        this.player.loadVideoById({
          videoId: this.sourceId,
          startSeconds: state.current_time,
        });
        // Pause as soon as YouTube starts loading — it will fire BUFFERING then
        // we pause immediately. The _playerSettled gate prevents any events from
        // leaking to the server during this sequence.
        const pauseOnLoad = () => {
          const s = this.player?.getState?.();
          if (s === "playing" || s === "buffering") {
            this._pause();
            return;
          }
          // Retry briefly in case the player hasn't started yet
          if (this._loadPauseAttempts < 10) {
            this._loadPauseAttempts = (this._loadPauseAttempts || 0) + 1;
            setTimeout(pauseOnLoad, 100);
          }
        };
        this._loadPauseAttempts = 0;
        setTimeout(pauseOnLoad, 100);
      } else {
        this._seekTo(state.current_time);
      }
    }
```

- [ ] **2.6** Fix `stateCheckInterval` buffering tolerance. In the stateCheckInterval block (around line 795), add a buffering check before the mismatch logic:

Find this code block:
```javascript
      if (localState !== this.expectedPlayState) {
        if (!this._mismatchSince) {
          this._mismatchSince = performance.now();
        } else if (performance.now() - this._mismatchSince > 500) {
```

Insert before it (after the `this._stuckBufferingSince = null;` on line 792, before the mismatch check):
```javascript
      // Buffering while we expect playing is normal — don't treat as mismatch.
      // The stuck-buffering handler above covers the case where it lasts >5s.
      if (localState === "buffering" && this.expectedPlayState === "playing") {
        this._mismatchSince = null;
        return;
      }
```

Wait — looking at the code more carefully, the `localState === "buffering"` case already returns at line 790 before reaching the mismatch check. So this is already handled by the existing buffering block (lines 770-793). The `else { this._stuckBufferingSince = null; }` at line 791-793 only runs for non-buffering states. So the mismatch check at line 795 only fires for `"playing"` or `"paused"` localState. **No change needed here** — the existing code already handles this correctly.

- [ ] **2.7** Run `mix phx.server`. Test the stutter scenario: create room → queue YouTube video → pause at start → open incognito/second browser → join room → verify video loads (not just thumbnail) and is paused → hit play on original tab → verify both clients play smoothly without stutter.

- [ ] **2.8** Also test: rapid pause/resume, seek during playback, queue advance to next video. Ensure no regressions.

- [ ] **2.9** Commit: `fix: load-not-cue on paused join + player readiness gate to prevent echo loops`

---

## Task 3: Skip redundant server broadcasts (`room_server.ex`)

**Context:** `lib/byob/room_server.ex` lines 267-342. The play handler broadcasts `sync:play` on line 307 even when `was_paused` is false (no state transition). Same for pause on line 339.

- [ ] **3.1** Read `lib/byob/room_server.ex` lines 267-342 (play and pause handlers).

- [ ] **3.2** In the play handler, move the broadcast inside the `was_paused` conditional. Replace lines 307-308:

**Current (line 307):**
```elixir
        broadcast(state, {:sync_play, %{time: position, server_time: now, user_id: user_id}})
        {:reply, :ok, state}
```

**New:**
```elixir
        if was_paused do
          broadcast(state, {:sync_play, %{time: position, server_time: now, user_id: user_id}})
        end

        {:reply, :ok, state}
```

- [ ] **3.3** In the pause handler, move the broadcast inside the `was_playing` conditional. Replace line 339:

**Current (line 339):**
```elixir
        broadcast(state, {:sync_pause, %{time: position, server_time: now, user_id: user_id}})
        {:reply, :ok, state}
```

**New:**
```elixir
        if was_playing do
          broadcast(state, {:sync_pause, %{time: position, server_time: now, user_id: user_id}})
        end

        {:reply, :ok, state}
```

- [ ] **3.4** Run `mix compile --warnings-as-errors` to verify no compilation warnings.

- [ ] **3.5** Commit: `fix: skip redundant sync broadcasts when no state transition occurs`

---

## Task 4: Extension autoplay overlay (`background.js` + `content.js`)

**Context:** `extension/background.js` (180 lines) handles `video:hooked` at lines 42-58 by directly sending `command:play`/`command:pause`/`command:seek`/`command:synced`. `extension/content.js` (561 lines) handles these commands in `handleSWMessage` at lines 280-343.

- [ ] **4.1** Read `extension/background.js` lines 42-58 and `extension/content.js` lines 280-343 (already read above).

- [ ] **4.2** Modify `extension/background.js` `video:hooked` handler. Replace lines 42-58:

**Current:**
```javascript
    case "video:hooked":
      // Don't send position 0 to server - it corrupts the canonical state
      // Instead, request current state from channel and sync to it
      if (channel) {
        channel.push("sync:request_state", {}).receive("ok", (resp) => {
          console.log("[byob] Got current state for sync:", resp);
          setTimeout(() => {
            if (resp.play_state === "playing") {
              port.postMessage({ type: "command:play", position: resp.current_time });
            } else {
              port.postMessage({ type: "command:seek", position: resp.current_time });
              port.postMessage({ type: "command:pause", position: resp.current_time });
            }
            port.postMessage({ type: "command:synced" });
          }, 300);
        });
      }
      break;
```

**New:**
```javascript
    case "video:hooked":
      // Request current room state and send it to the content script.
      // The content script will show an autoplay overlay — the user's click
      // provides the gesture needed to unlock video.play().
      if (channel) {
        channel.push("sync:request_state", {}).receive("ok", (resp) => {
          console.log("[byob] Got current state for sync:", resp);
          port.postMessage({
            type: "command:initial-state",
            play_state: resp.play_state,
            current_time: resp.current_time,
          });
        });
      }
      break;
```

- [ ] **4.3** Update the inline suppression in `extension/content.js` to use time-window behavior. Replace the `suppress` and `shouldSuppress` functions (lines 245-277):

**New:**
```javascript
  // Suppression — time-window based (matches suppression.js in main app)
  let terminalReached = false;
  let terminalAt = null;

  function suppress(state) {
    suppressGen++;
    suppressUntilGen = suppressGen;
    expectedState = state;
    terminalReached = false;
    terminalAt = null;
    if (safetyTimeout) clearTimeout(safetyTimeout);
    safetyTimeout = setTimeout(() => {
      suppressUntilGen = 0;
      expectedState = null;
      terminalReached = false;
      terminalAt = null;
    }, 3000);
  }

  function shouldSuppress(currentState) {
    if (suppressUntilGen === 0) return false;
    if (currentState === expectedState || expectedState === null) {
      if (!terminalReached) {
        terminalReached = true;
        terminalAt = performance.now();
      }
      if (performance.now() - terminalAt > 200) {
        suppressUntilGen = 0;
        expectedState = null;
        terminalReached = false;
        terminalAt = null;
        if (safetyTimeout) { clearTimeout(safetyTimeout); safetyTimeout = null; }
      }
    }
    // Suppress ALL events while active
    return true;
  }
```

- [ ] **4.4** Add the autoplay overlay injection and `command:initial-state` handler in `extension/content.js`. In the `handleSWMessage` function, add a new case before the `if (!hookedVideo) return;` guard (before line 309), and add the overlay helper functions.

Add this new status to `updateSyncBarStatus` states object (inside the function around line 430):
```javascript
      clickjoin: { color: "#ff9900", text: "Click video to join playback" },
```

Add this case in `handleSWMessage`, right after the `byob:bar-update` handler (before `if (!hookedVideo) return;`):
```javascript
    if (msg.type === "command:initial-state") {
      updateSyncBarStatus("clickjoin");
      showAutoplayOverlay(msg.play_state, msg.current_time);
      return;
    }
```

Add these new functions (before the `injectSyncBar` function):

```javascript
  function showAutoplayOverlay(playState, currentTime) {
    if (!hookedVideo) return;
    removeAutoplayOverlay();

    const overlay = document.createElement("div");
    overlay.id = "byob-autoplay-overlay";
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 999998;
      background: rgba(0,0,0,0.6); display: flex; align-items: center;
      justify-content: center; cursor: pointer; backdrop-filter: blur(2px);
    `;

    const btn = document.createElement("div");
    btn.style.cssText = `
      background: rgba(0,0,0,0.8); border: 2px solid rgba(255,255,255,0.3);
      border-radius: 16px; padding: 24px 36px; text-align: center;
      color: white; font-family: system-ui, sans-serif;
    `;
    btn.innerHTML = `
      <div style="font-size:48px;margin-bottom:12px">&#9654;</div>
      <div style="font-size:16px;font-weight:bold">Click to join playback</div>
      <div style="font-size:12px;opacity:0.6;margin-top:4px">Required by browser autoplay policy</div>
    `;

    overlay.appendChild(btn);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", () => {
      removeAutoplayOverlay();
      activateAfterGesture(playState, currentTime);
    }, { once: true });

    // Also detect if user clicks play on the native player directly
    const onNativePlay = () => {
      if (document.getElementById("byob-autoplay-overlay")) {
        removeAutoplayOverlay();
        activateAfterGesture(playState, currentTime);
      }
      hookedVideo?.removeEventListener("play", onNativePlay);
    };
    hookedVideo.addEventListener("play", onNativePlay);
  }

  function removeAutoplayOverlay() {
    const el = document.getElementById("byob-autoplay-overlay");
    if (el) el.remove();
  }

  function activateAfterGesture(playState, currentTime) {
    if (!hookedVideo) return;

    // The click provides the user gesture — play to unlock autoplay
    suppress("playing");
    hookedVideo.play().then(() => {
      // Autoplay is now unlocked. Pause, seek to room position, apply state.
      suppress("paused");
      hookedVideo.pause();
      hookedVideo.currentTime = currentTime;

      if (playState === "playing") {
        // Small delay to let the seek settle, then play
        setTimeout(() => {
          suppress("playing");
          hookedVideo.play().catch(() => {});
          synced = true;
          updateSyncBarStatus("playing");
        }, 200);
      } else {
        synced = true;
        updateSyncBarStatus("paused");
      }
    }).catch(() => {
      // play() failed even with gesture — very rare, try directly
      hookedVideo.currentTime = currentTime;
      synced = true;
      updateSyncBarStatus(playState === "playing" ? "playing" : "paused");
    });
  }
```

- [ ] **4.5** Build the extension and test. Run `just chrome` and/or `just firefox` to build.

- [ ] **4.6** Manual test — Firefox: create a room on byob.video, queue a video, open external to a third-party site (e.g., Crunchyroll, Dailymotion). Verify:
  - Sync bar appears with "Click video to join playback" status
  - Full-page overlay with play button appears
  - Clicking the overlay unlocks playback
  - If room is paused: video seeks to correct position and stays paused
  - If room is playing: video plays at correct position
  - Subsequent sync commands (play/pause/seek from room) work without needing another click

- [ ] **4.7** Manual test — Chrome: same test as above.

- [ ] **4.8** Commit: `feat: autoplay overlay for extension sync on third-party sites`

---

## Task 5: Debug logging module (`sync_log.ex`)

**Context:** No logging exists in the sync core. We need a helper module that hashes URLs and provides structured log functions.

- [ ] **5.1** Create `lib/byob/sync_log.ex`:

```elixir
defmodule Byob.SyncLog do
  @moduledoc """
  Structured sync logging with privacy-safe defaults.
  Video URLs are SHA-256 hashed (12-char hex prefix). User IDs are
  random UUIDs (session:tab) — no PII. Never logs titles, usernames,
  or chat.
  """
  require Logger

  def hash_url(nil), do: "none"

  def hash_url(url) when is_binary(url) do
    :crypto.hash(:sha256, url)
    |> Base.encode16(case: :lower)
    |> binary_part(0, 12)
  end

  def play(room_id, user_id, url, position, transition) do
    Logger.info(
      "[sync:play] room=#{room_id} user=#{user_id} video=#{hash_url(url)} pos=#{fmt_pos(position)} #{transition}"
    )
  end

  def pause(room_id, user_id, url, position, transition) do
    Logger.info(
      "[sync:pause] room=#{room_id} user=#{user_id} video=#{hash_url(url)} pos=#{fmt_pos(position)} #{transition}"
    )
  end

  def seek(room_id, user_id, url, position) do
    Logger.info(
      "[sync:seek] room=#{room_id} user=#{user_id} video=#{hash_url(url)} pos=#{fmt_pos(position)}"
    )
  end

  def join(room_id, user_id, user_count) do
    Logger.info("[sync:join] room=#{room_id} user=#{user_id} users=#{user_count}")
  end

  def leave(room_id, user_id) do
    Logger.info("[sync:leave] room=#{room_id} user=#{user_id}")
  end

  def snapshot(room_id, user_id, play_state, position) do
    Logger.info(
      "[sync:snapshot] room=#{room_id} user=#{user_id} state=#{play_state} pos=#{fmt_pos(position)}"
    )
  end

  def ext_join(room_id, user_id) do
    Logger.info("[sync:ext_join] room=#{room_id} user=#{user_id}")
  end

  def ext_event(room_id, event, user_id) do
    Logger.info("[sync:ext:#{event}] room=#{room_id} user=#{user_id}")
  end

  def heartbeat(room_id, play_state, position) do
    Logger.debug(
      "[sync:heartbeat] room=#{room_id} state=#{play_state} pos=#{fmt_pos(position)}"
    )
  end

  def redundant(room_id, event, user_id) do
    Logger.debug("[sync:redundant] room=#{room_id} event=#{event} user=#{user_id}")
  end

  defp fmt_pos(pos) when is_float(pos), do: Float.round(pos, 1)
  defp fmt_pos(pos) when is_integer(pos), do: pos
  defp fmt_pos(_), do: "?"
end
```

- [ ] **5.2** Run `mix compile --warnings-as-errors` to verify it compiles.

- [ ] **5.3** Commit: `feat: add SyncLog module for privacy-safe structured sync logging`

---

## Task 6: Add logging to room_server.ex

**Context:** `lib/byob/room_server.ex` — play handler at line 267, pause handler at line 312, seek handler at line 344, join handler at line 215, heartbeat at line 816. We need a helper to get the current media URL for hashing.

- [ ] **6.1** Add a `current_media_url/1` helper near the existing `current_media_title/1` (line 1134) in `room_server.ex`:

```elixir
  defp current_media_url(state) do
    case state.current_index do
      nil -> nil
      idx ->
        item = Enum.at(state.queue, idx)
        if item, do: item.url, else: nil
    end
  end
```

- [ ] **6.2** Add `alias Byob.SyncLog` at the top of the module (near the existing aliases).

- [ ] **6.3** Add logging to the **play handler** (around line 267). After the state update and before the reply, in the `was_paused` conditional block where we already moved the broadcast (Task 3), add:

After the broadcast line inside `if was_paused do`:
```elixir
          SyncLog.play(state.room_id, user_id, current_media_url(state), position, "paused→playing")
```

And add an else clause for the redundant case:
```elixir
        else
          SyncLog.redundant(state.room_id, "play", user_id)
```

- [ ] **6.4** Add logging to the **pause handler** (around line 312). Same pattern:

Inside `if was_playing do`:
```elixir
          SyncLog.pause(state.room_id, user_id, current_media_url(state), position, "playing→paused")
```

Else clause:
```elixir
        else
          SyncLog.redundant(state.room_id, "pause", user_id)
```

- [ ] **6.5** Add logging to the **seek handler** (around line 344). After the state update:
```elixir
        SyncLog.seek(state.room_id, user_id, current_media_url(state), position)
```

- [ ] **6.6** Add logging to the **join handler** (around line 215). After `log_activity(state, :joined, user_id)`:
```elixir
        SyncLog.join(state.room_id, user_id, map_size(state.users))
```

- [ ] **6.7** Add logging to the **heartbeat handler** (around line 816):
```elixir
        SyncLog.heartbeat(state.room_id, state.play_state, position)
```

- [ ] **6.8** Run `mix compile --warnings-as-errors`.

- [ ] **6.9** Commit: `feat: add sync logging to RoomServer play/pause/seek/join/heartbeat`

---

## Task 7: Add logging to extension_channel.ex

**Context:** `lib/byob_web/channels/extension_channel.ex` — 188 lines. Join at line 7, handle_in for play/pause/seek/ended at lines 32-61.

- [ ] **7.1** Add `alias Byob.SyncLog` at the top (near the existing aliases on line 4).

- [ ] **7.2** Add logging to `join_room/3` (line 15). After the `RoomServer.join` call:
```elixir
    SyncLog.ext_join(room_id, user_id)
```

- [ ] **7.3** Add logging to `handle_in` for play, pause, seek, ended. After each `RoomServer.*` call:

For play (line 33):
```elixir
    SyncLog.ext_event(socket.assigns.room_id, "play", socket.assigns.user_id)
```

For pause (line 38):
```elixir
    SyncLog.ext_event(socket.assigns.room_id, "pause", socket.assigns.user_id)
```

For seek (line 43):
```elixir
    SyncLog.ext_event(socket.assigns.room_id, "seek", socket.assigns.user_id)
```

For ended with index (line 48):
```elixir
    SyncLog.ext_event(socket.assigns.room_id, "ended", socket.assigns.user_id)
```

- [ ] **7.4** Run `mix compile --warnings-as-errors`.

- [ ] **7.5** Commit: `feat: add sync logging to ExtensionChannel`

---

## Task 8: Integration testing

- [ ] **8.1** Start `mix phx.server`. Create a room, queue a YouTube video. Check terminal output — should see `[sync:join]` log line.

- [ ] **8.2** Play the video. Check for `[sync:play] ... paused→playing` log. Pause it. Check for `[sync:pause] ... playing→paused`. Seek. Check for `[sync:seek]`.

- [ ] **8.3** Verify video URLs do NOT appear in any log line — only 12-char hex hashes.

- [ ] **8.4** Open a second browser/incognito tab, join the same room while paused. Verify:
  - `[sync:join]` shows `users=2`
  - The YouTube player loads fully (not just thumbnail) at the paused position
  - Hit play on the first tab — both tabs play smoothly, no stutter
  - Logs show clean `paused→playing` transition, no `[sync:redundant]` spam

- [ ] **8.5** Test rapid pause/resume (click pause then play within 1 second). Verify both clients stay in sync and no echo loop occurs.

- [ ] **8.6** Test extension (if extension build is available): open external to a third-party video site. Verify overlay appears, click joins playback, sync works after gesture.

- [ ] **8.7** Final commit if any fixups needed, then tag for version bump per release workflow.
