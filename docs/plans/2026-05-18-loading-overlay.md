# New-Video Loading Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cover the 5-8 s "black screen" between `:video_changed` and `:sync_play` with a thumbnail + spinner + "Loading…" overlay, so the wait reads as intentional instead of broken.

**Architecture:** Two new helpers on the `VideoPlayer` Phoenix hook (`assets/js/hooks/video_player.js`), mirroring the existing `_showSyncingOverlay` / `_hideSyncingOverlay` pattern. Single `_showLoadingOverlay` call at the end of `_loadVideo` covers every source type; matching `_hideLoadingOverlay` calls live at the `_playerSettled`-flip in `_onPlayerStateChange` and at the install sites of competing full-surface overlays (`_maybeShowReadyOverlay`, `_showClickToPlay`, `_onYTError`).

**Tech Stack:** Phoenix LiveView 1.1, vanilla JS hook with `pushEvent`/`handleEvent`, esbuild bundle, no JS test framework — verification is manual via `mix phx.server`.

**Spec:** `docs/plans/2026-05-18-loading-overlay-design.md`

**Repo conventions:**
- Single source of truth version in `/VERSION` — `just sync-version` propagates to extension manifests and is read at compile time by `mix.exs`.
- Changelog at `/CHANGELOG.md`, newest entry at top, "v6.8.X" headers.
- Release workflow: edit changelog → bump VERSION → `just sync-version` → commit → `git tag vX.Y.Z` → `git push origin main && git push origin --tags`.
- No JS unit tests; only Elixir tests under `test/`. Client-side changes are smoke-tested in dev server.

---

## Task 1: Add `_showLoadingOverlay` and `_hideLoadingOverlay` helpers

**Files:**
- Modify: `assets/js/hooks/video_player.js` — add two methods next to `_showSyncingOverlay`/`_hideSyncingOverlay` (currently at lines 1687 / 1776 / 1793).

- [ ] **Step 1: Open `assets/js/hooks/video_player.js` and locate the syncing-overlay helpers**

Read lines 1685-1820 of `assets/js/hooks/video_player.js` so you have the exact `_showSyncingOverlay` / `_hideSyncingOverlay` / `_hideSyncingOverlayNow` shape in mind. The loading overlay mirrors that pattern.

- [ ] **Step 2: Insert the two new helpers immediately after `_hideSyncingOverlayNow`**

Find the closing brace of `_hideSyncingOverlayNow` (around line 1815). The next method is `_pushDriftReport` — insert the new helpers between them. Code to add:

```js
  // Full-surface "Loading…" overlay shown from _loadVideo until the
  // player fires its first stable state (playing or paused). Mirrors
  // _showSyncingOverlay's structure but full-screen with a thumbnail
  // background, not a corner pill. Cosmetic only — pointer-events:none.
  // 250 ms minimum lifetime prevents a flicker on the fast
  // loadVideoById reuse path. z-index 10 matches the existing
  // interactive overlays (byob-join-ready, byob-click-to-play) —
  // they never coexist with us (early-returns + preemptive hide
  // wired into both install paths).
  _showLoadingOverlay(thumbnailUrl) {
    // Placeholder players (extension peer with no local <video>) own
    // their own "Open Player Window" status text — don't double-paint.
    if (this.player?.isPlaceholder) return;
    // The interactive overlays own the surface when up.
    if (this.el.querySelector(".byob-join-ready")) return;
    if (this.el.querySelector(".byob-click-to-play")) return;
    // Idempotent: re-shows during the same load don't stack.
    if (this.el.querySelector(".byob-loading")) return;

    // The byob-spin @keyframes is lazy-injected inside _showSyncingOverlay.
    // The loading overlay typically runs FIRST on a fresh video (before
    // any syncing pill ever fires), so we have to inject it ourselves.
    // Idempotent — same guard the syncing path uses.
    if (!document.getElementById("byob-syncing-style")) {
      const style = document.createElement("style");
      style.id = "byob-syncing-style";
      style.textContent = "@keyframes byob-spin { to { transform: rotate(360deg); } }";
      document.head.appendChild(style);
    }

    this._loadingShownAt = performance.now();
    if (this._loadingHideTimer) {
      clearTimeout(this._loadingHideTimer);
      this._loadingHideTimer = null;
    }

    const overlay = document.createElement("div");
    overlay.className = "byob-loading";
    const thumbBg = thumbnailUrl
      ? `background-image:url(${JSON.stringify(thumbnailUrl)});background-size:cover;background-position:center;`
      : "";
    overlay.style.cssText = [
      "position:absolute",
      "inset:0",
      "z-index:10",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "gap:12px",
      "background:#000",
      "pointer-events:none",
      thumbBg,
    ].join(";");

    // Dim layer over the thumbnail so the spinner/label read clearly.
    const dim = document.createElement("div");
    dim.style.cssText = "position:absolute;inset:0;background:rgba(0,0,0,0.55);";
    overlay.appendChild(dim);

    // Spinner + label, on top of the dim layer.
    const stack = document.createElement("div");
    stack.style.cssText = "position:relative;display:flex;flex-direction:column;align-items:center;gap:10px;";
    stack.innerHTML =
      `<svg width="32" height="32" viewBox="0 0 24 24" style="animation:byob-spin 0.8s linear infinite">` +
      `<circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" stroke-width="3" fill="none"/>` +
      `<path d="M12 2 a10 10 0 0 1 10 10" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/>` +
      `</svg>` +
      `<span style="font:600 13px/1 system-ui;color:rgba(255,255,255,0.9)">Loading…</span>`;
    overlay.appendChild(stack);

    this.el.appendChild(overlay);
  },

  // Hide the loading overlay. Honors a 250 ms minimum lifetime so the
  // fast YouTube loadVideoById reuse path doesn't flicker the overlay
  // in and out within a few hundred ms.
  _hideLoadingOverlay() {
    const overlay = this.el.querySelector(".byob-loading");
    if (!overlay) return;

    const LOADING_MIN_LIFETIME_MS = 250;
    const elapsed = performance.now() - (this._loadingShownAt || 0);
    if (elapsed < LOADING_MIN_LIFETIME_MS) {
      if (this._loadingHideTimer) return;
      this._loadingHideTimer = setTimeout(
        () => this._hideLoadingOverlay(),
        LOADING_MIN_LIFETIME_MS - elapsed
      );
      return;
    }

    if (this._loadingHideTimer) {
      clearTimeout(this._loadingHideTimer);
      this._loadingHideTimer = null;
    }
    overlay.remove();
  },

```

- [ ] **Step 3: Sanity-check the syntax with esbuild**

Run from repo root:

```
just build
```

Expected: build succeeds. If esbuild reports a syntax error, fix it before continuing.

- [ ] **Step 4: Commit Task 1**

```bash
git add assets/js/hooks/video_player.js
git commit -m "video: add _showLoadingOverlay / _hideLoadingOverlay helpers"
```

---

## Task 2: Show the overlay at the end of `_loadVideo`

**Files:**
- Modify: `assets/js/hooks/video_player.js:368-436` — `_loadVideo` method.

- [ ] **Step 1: Locate `_loadVideo`**

`_loadVideo` is defined at line 368. Around line 390-391 it computes `this._lastThumb`:

```js
    this._lastThumb = mediaItem?.thumbnail_url ||
      (sourceType === "youtube" && sourceId ? `https://img.youtube.com/vi/${sourceId}/hqdefault.jpg` : null);
```

We want the loading overlay to appear immediately after this — before the per-source-type `_loadYouTube`/`_loadVimeo`/`_loadTwitch`/`_loadDirectUrl`/`_loadExtension` calls.

- [ ] **Step 2: Insert the show call**

Find the existing line:

```js
    this._embedBlocked = false;
```

(currently at line 392). Insert immediately after it:

```js
    // Cover the load window (5-8 s during the server-side ready-check
    // handshake) with a thumbnail-backed spinner so the user doesn't
    // see a black screen. Skip for extension placeholder (isPlaceholder
    // guard inside _showLoadingOverlay). Hide is wired in
    // _onPlayerStateChange when _playerSettled first flips true.
    this._showLoadingOverlay(this._lastThumb);
```

- [ ] **Step 3: Verify the change in-place**

Run:

```
grep -n "_showLoadingOverlay\b" assets/js/hooks/video_player.js
```

Expected output: 3 lines — the definition, the call site you just added, and an internal `if`/`return` line is fine but the call from `_loadVideo` should be near line 393.

- [ ] **Step 4: Build to confirm no syntax errors**

```
just build
```

Expected: clean build.

- [ ] **Step 5: Commit Task 2**

```bash
git add assets/js/hooks/video_player.js
git commit -m "video: show loading overlay during _loadVideo"
```

---

## Task 3: Hide the overlay on `_playerSettled` flip

**Files:**
- Modify: `assets/js/hooks/video_player.js:690-708` — the `_playerSettled` flip block inside `_onPlayerStateChange`.

- [ ] **Step 1: Locate the `_playerSettled` flip**

In `_onPlayerStateChange` (definition at line 633), the first-stable-state block is at lines 693-708:

```js
    // Mark player as settled on first stable state after load.
    // Do this BEFORE suppression so that suppressed events (from programmatic
    // commands like loadVideoById) still mark the player as ready.
    if (!this._playerSettled && (stateName === "playing" || stateName === "paused")) {
      this._playerSettled = true;
      // Belt-and-suspenders: also signal loaded here in case the
      // player adapter's onReady fired before _currentItemId was set
      // (rare but possible during reuse paths). _signalLoaded is
      // idempotent per item_id.
      this._signalLoaded();
      // If we were loading-for-pause, the pause has landed — don't push it
      if (this._loadingPaused && stateName === "paused") {
        this._loadingPaused = false;
        // Still let suppression consume this event
        this.suppression.shouldSuppress(stateName);
        return;
      }
    }
```

- [ ] **Step 2: Add the hide call inside that block**

After `this._signalLoaded();` and before the `if (this._loadingPaused …)` line, insert:

```js
      // Player has reached a stable state — the loading overlay's job is done.
      this._hideLoadingOverlay();
```

The block should now look like:

```js
    if (!this._playerSettled && (stateName === "playing" || stateName === "paused")) {
      this._playerSettled = true;
      this._signalLoaded();
      this._hideLoadingOverlay();
      // If we were loading-for-pause, the pause has landed — don't push it
      if (this._loadingPaused && stateName === "paused") {
        this._loadingPaused = false;
        this.suppression.shouldSuppress(stateName);
        return;
      }
    }
```

(Existing comments inside the block can stay; just slot the hide call after `_signalLoaded`.)

- [ ] **Step 3: Build**

```
just build
```

Expected: clean build.

- [ ] **Step 4: Commit Task 3**

```bash
git add assets/js/hooks/video_player.js
git commit -m "video: hide loading overlay when player settles"
```

---

## Task 4: Preemptive hide when competing overlays / error UI take over

**Files:**
- Modify: `assets/js/hooks/video_player.js:1497` — `_maybeShowReadyOverlay`.
- Modify: `assets/js/hooks/video_player.js:1558` — `_showClickToPlay`.
- Modify: `assets/js/hooks/video_player.js:778` — `_onYTError`.

The loading overlay can't sit on top of an interactive overlay (`byob-join-ready`, `byob-click-to-play`) or an error fallback. The show helper already returns early when those are on screen, but the *opposite* race exists: loading is up first, and then one of those tries to install. The youtube_error.js path clears `this.el.innerHTML` so it nukes our overlay implicitly, but be explicit anyway for clarity.

- [ ] **Step 1: `_maybeShowReadyOverlay`**

Find this function (line 1497). It currently starts with a series of early-returns and then builds the `byob-join-ready` overlay. Find the first line that builds DOM (creates `const overlay = document.createElement("div")` for `byob-join-ready`, around line 1513 in the current source). Immediately BEFORE that DOM-build, add:

```js
    // The join-ready overlay takes over the surface from us.
    this._hideLoadingOverlay();
```

Place it after all the early-returns and just before the actual overlay construction so we only run it when we're actually committed to showing the join-ready surface.

- [ ] **Step 2: `_showClickToPlay`**

Find this function (line 1558). It also opens with a couple of early-returns (e.g. `if (this.el.querySelector(".byob-click-to-play"))`) and then builds DOM. Find the first DOM-build line for `byob-click-to-play` (around line 1573 in the current source). Immediately BEFORE it, add:

```js
    // The click-to-play overlay takes over the surface from us.
    this._hideLoadingOverlay();
```

- [ ] **Step 3: `_onYTError`**

Find `_onYTError` (line 778):

```js
  _onYTError(event) {
    handleYTError(this, event);
  },
```

Replace the body with:

```js
  _onYTError(event) {
    // Error fallback (handleYTError) replaces el.innerHTML, which would
    // implicitly nuke any overlay child anyway — but be explicit so
    // _loadingHideTimer / _loadingShownAt are cleaned up too.
    this._hideLoadingOverlay();
    handleYTError(this, event);
  },
```

- [ ] **Step 4: Build**

```
just build
```

Expected: clean build.

- [ ] **Step 5: Commit Task 4**

```bash
git add assets/js/hooks/video_player.js
git commit -m "video: hide loading overlay when competing UI takes over"
```

---

## Task 5: Manual smoke test in dev server

No JS test framework exists. Verification is manual.

- [ ] **Step 1: Start the dev server**

```
mix phx.server
```

Wait for it to print "Running ByobWeb.Endpoint with Bandit … at 0.0.0.0:4000".

- [ ] **Step 2: Open the app in a browser**

Navigate to `http://localhost:4000`. Click "Create Room" (or join an existing one).

- [ ] **Step 3: Paste a YouTube URL into the queue**

E.g. `https://www.youtube.com/watch?v=dQw4w9WgXcQ`. Submit.

Expected: as the video loads, you see a full-screen overlay with the YouTube video thumbnail darkened, a spinning circle, and "Loading…" text. The overlay disappears when playback actually starts.

- [ ] **Step 4: Queue a SECOND YouTube URL (reuse path)**

While the first video is playing, drop another YouTube URL in the queue. Let the queue advance (or skip).

Expected: the overlay appears briefly during the `loadVideoById` reuse and disappears as playback starts. Because of the 250 ms minimum lifetime, it should not flicker — even if the reuse is very fast you should still see the overlay for ~250 ms minimum, not a strobe.

- [ ] **Step 5: Test a Vimeo URL**

E.g. `https://vimeo.com/76979871`.

Expected: overlay appears, hides when the Vimeo player starts playing.

- [ ] **Step 5b: Test a Twitch URL**

E.g. a public clip or VOD: `https://www.twitch.tv/videos/...`.

Expected: overlay appears during Twitch player load, hides when Twitch reports playing.

- [ ] **Step 5c: Test a direct video URL**

Any `.mp4` URL you have handy (or a public sample like `https://download.samplelib.com/mp4/sample-5s.mp4`).

Expected: overlay appears briefly during HTML5 `<video>` load. Since direct URLs are usually fast, you may only see the overlay for the 250 ms minimum lifetime.

- [ ] **Step 6: Test an age-restricted YouTube URL (embed error path)**

Use a known age-restricted ID, or a private-video ID, that triggers error code 100/101/150. (If you don't have one handy, skip this step and verify later.)

Expected: overlay appears briefly, then is replaced by the embed-error fallback UI. The spinner should NOT be visible behind/over the fallback.

- [ ] **Step 7: Test joining a paused room**

Open a second browser window (or incognito), join the same room while the first window is paused.

Expected: the second window's overlay shows during load, then the click-to-play "join ready" overlay takes over. The spinner should NOT remain visible behind the join-ready overlay.

- [ ] **Step 8: Verify extension placeholder unaffected (optional)**

If you have the extension installed and can trigger a placeholder source (e.g. Crunchyroll URL on a peer without the extension), verify the placeholder UI shows without a loading-overlay flash on top of it.

If any test fails, debug and re-test. Once all pass, proceed to Task 6.

- [ ] **Step 9: Stop the dev server**

Ctrl-C in the terminal.

---

## Task 6: Version bump, changelog, commit, tag, push

- [ ] **Step 1: Update `CHANGELOG.md`**

Open `CHANGELOG.md`. Find the line `# byob Changelog` near the top, followed by `---` and `# v6.8.70`. Insert a new section immediately after the `---` and before `# v6.8.70`:

```markdown
# v6.8.71

### Loading overlay so new-video starts don't look broken

The 5-8 s "black screen" that appears when a new video starts —
during the server-side ready-check handshake (8 s timeout) and the
YouTube IFrame's own load time — now shows a full-surface overlay:
the video thumbnail dimmed, a centered spinner, and a "Loading…"
label. Hides on the player's first stable state (playing or
paused) and yields to the join-ready / click-to-play / embed-error
overlays when those take over the surface.

Cosmetic only. Doesn't touch `@ready_check_timeout_ms`, doesn't
change the sync protocol, doesn't preload the next queue item.

---

```

(The trailing `---` should already be there before `# v6.8.70`; just make sure the new section ends with `---` followed by a blank line before `# v6.8.70`.)

- [ ] **Step 2: Bump VERSION**

```bash
echo "6.8.71" > VERSION
just sync-version
```

Expected output from `just sync-version`: "Synced version 6.8.71 to manifests".

- [ ] **Step 3: Verify staged files**

```bash
git status
```

Expected modified files:
- `CHANGELOG.md`
- `VERSION`
- `assets/js/hooks/video_player.js` (already committed across tasks 1-4; not in status now)
- `extension/manifest.json`
- `extension/manifest.firefox.json`

- [ ] **Step 4: Commit the version bump**

```bash
git add CHANGELOG.md VERSION extension/manifest.json extension/manifest.firefox.json
git commit -m "$(cat <<'EOF'
v6.8.71: loading overlay during new-video start

Cover the 5-8 s "black screen" between :video_changed and :sync_play
(server ready-check handshake + YT IFrame load) with a thumbnail +
spinner + "Loading…" overlay. Hides on first stable player state.
Yields to byob-join-ready, byob-click-to-play, and the YT embed-
error fallback so those UIs aren't obscured.

Pure cosmetic change. No protocol changes; ready-check timeout
untouched.
EOF
)"
```

- [ ] **Step 5: Tag**

```bash
git tag v6.8.71
```

- [ ] **Step 6: Push**

```bash
git push origin main && git push origin --tags
```

Expected: both pushes succeed. If the push fails because the 1Password SSH agent isn't responding, ask the user to unlock 1Password and re-run.

- [ ] **Step 7: Confirm**

```bash
git log --oneline -3
git tag --list 'v6.8.7?'
```

Expected: latest commit is `vX.Y.Z: loading overlay during new-video start` and `v6.8.71` appears in the tag list.

---

## Done criteria

- All checkboxes above are ticked.
- A YouTube fresh-load shows the thumbnail+spinner overlay, then hides on play.
- Vimeo / Twitch loads also show the overlay.
- Extension placeholder does NOT get a loading overlay over it.
- Embed-error fallback is not obscured by the overlay.
- Join-ready and click-to-play overlays are not obscured.
- `v6.8.71` is pushed to `origin/main` with matching tag.
