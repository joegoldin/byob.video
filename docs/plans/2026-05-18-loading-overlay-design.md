# New-Video Loading Overlay Design

## Problem

When a new video starts (queue advance, initial mount, or any other `_loadVideo` trigger), peers see a black screen for 5-8 seconds. The wait is structural: the server runs a ready-check handshake (`@ready_check_timeout_ms = 8_000`) that waits for every connected peer to fire `video:loaded` before broadcasting `:sync_play`. During that window the YouTube IFrame shows black or its own loader; on fresh-load paths there's an additional 1-3 seconds of iframe instantiation.

We are NOT touching the ready-check timing in this change — the user's ask is purely the cosmetic cover-up. Make the wait read as intentional instead of broken.

## Chosen Approach

Add a thumbnail+spinner+"Loading…" full-screen overlay to `assets/js/hooks/video_player.js`. Mirror the existing `_showSyncingOverlay` / `_hideSyncingOverlay` helper pattern (line 1687 / 1776).

Show from the moment `_loadVideo` runs; hide when the player fires its first stable state (`"playing"` or `"paused"`) or when any other overlay/error UI takes over the surface.

## Design

### Helpers

Two new methods on the `VideoPlayer` hook:

- `_showLoadingOverlay(thumbnailUrl)`:
  - Idempotent — return early if `.byob-loading` already exists.
  - Skip if `this.player?.isPlaceholder` (extension placeholder owns its own UI).
  - Skip if `.byob-join-ready` or `.byob-click-to-play` already on screen (they own the surface).
  - Build a `<div class="byob-loading">` child of `this.el`: thumbnail background (or fall back to black if `thumbnailUrl` is null), 0.55-opacity dim layer, centered spinner SVG, "Loading…" label under it.
  - Stamp `_loadingShownAt = performance.now()` for the minimum-lifetime gate.
  - Use the same `byob-spin` `@keyframes` the syncing pill uses (line 1729). Important: that keyframe is injected lazily inside `_showSyncingOverlay` only. On a fresh video, `_showLoadingOverlay` runs *before* any syncing pill, so the loading overlay must inject the same `byob-syncing-style` `<style>` block itself if it isn't already in the DOM (idempotent — same `getElementById` guard).
  - z-index: above the player surface, below the syncing pill (z-index 30). Use z-index 20.

- `_hideLoadingOverlay()`:
  - If `performance.now() - _loadingShownAt < 250 ms`, defer the hide on a timeout (prevents flicker on the fast `loadVideoById` reuse path).
  - Otherwise remove `.byob-loading` immediately.

### Call sites

- **Show**: end of `_loadVideo` (after `_lastThumb` is set, line 390-391). One call covers all source-type branches (`_loadYouTube`, `_loadVimeo`, `_loadTwitch`, `_loadDirectUrl`, `_loadExtension`); the isPlaceholder guard inside `_showLoadingOverlay` excludes the extension-placeholder case.
- **Hide**: inside `_onPlayerStateChange` at line 693 where `_playerSettled` first flips true. Same lifecycle as `_signalLoaded()`. Fires on first `"playing"` or `"paused"`.
- **Hide (preemptive)**: in `_maybeShowReadyOverlay` (line 1497) and `_showClickToPlay` (line 1558), before installing those overlays. Loading cannot coexist with the join-ready or click-to-play UIs.
- **Hide (preemptive)**: in `_onYTError` (line 778) / embed-blocked path, before installing the error fallback. The user needs to see the error UI, not a spinner over it.

### Visual

```
+----------------------------------+
|                                  |
|   [thumbnail image]              |  ← background-image, cover
|                                  |
|     [dim 0.55 black layer]       |  ← overlay
|                                  |
|              ◐                   |  ← spinner SVG, byob-spin keyframe
|          Loading…                |  ← 13px system font, white 90% opacity
|                                  |
+----------------------------------+
```

`pointer-events: none` — clicks pass through to the player or whatever's underneath.

## Why this approach

- Mirrors the existing `_showSyncingOverlay` helper pattern; reviewer can scan it against the syncing pill one-to-one.
- Touches one file, ~50 lines of code.
- No refactor of `byob-join-ready` / `byob-click-to-play` even though they share the thumbnail-background pattern — those are interactive (click-to-play), this is purely indicative. Combining them would obscure the difference.
- Source-type-agnostic: one call site in `_loadVideo` covers YouTube, Vimeo, Twitch, direct URL, and (via the isPlaceholder guard) skips the extension placeholder.

## Guardrails

- **Minimum lifetime 250 ms** — prevents flicker on fast `loadVideoById` reuse paths.
- **Skip on placeholder players** — extension peers showing "Open Player Window" already have their own status text.
- **Skip when another full-surface overlay is up** — `byob-join-ready` and `byob-click-to-play` win.
- **Preemptive hide on error / interactive-overlay install** — the loading spinner must not block click targets or error fallbacks.
- **Idempotent show** — repeated calls during a single load don't stack duplicates.

## Out of scope

- Touching `@ready_check_timeout_ms` or any server-side timing.
- Preloading the next queue item via `cueVideoById` while the current one plays.
- Skipping the ready-check for solo rooms.
- Surfacing video title / uploader on the overlay (user picked option b in design Q2, not c/d).
- Refactoring `byob-join-ready` / `byob-click-to-play` to share thumbnail-overlay scaffolding.
- Re-introducing playback-rate correction (separate, larger change for the chronic-outlier drift case).

## Verification

- Visual smoke test on each source type: YouTube fresh load, YouTube `loadVideoById` reuse, Vimeo, Twitch, direct URL.
- Verify overlay does NOT appear on extension placeholder.
- Verify overlay hides cleanly on:
  - Normal load → playback start.
  - Paused-room mount (hide on first `"paused"`).
  - Embed-blocked / age-restricted YouTube (hide before error UI installs).
  - Click-to-play overlay taking over (hide before that overlay installs).
- Confirm minimum-lifetime gate prevents flicker on rapid same-source reuse.
