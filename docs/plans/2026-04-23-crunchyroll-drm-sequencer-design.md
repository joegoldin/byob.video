# Crunchyroll DRM Sequencer Design

## Problem

Crunchyroll emits a local event order of `pause -> play -> seeking/seeked` during scrub-while-playing. Our extension forwards those events individually, so receivers can observe `command:play` before the matching `command:seek`. On DRM/MSE sites, that order can wedge the receiver pipeline and leave playback stuck for several seconds.

## Chosen Approach

Add a DRM-only receiver-side sequencer in `extension/content.js`.

When a paused DRM receiver gets `command:play` with a target position far from the current one, it should not immediately call `.play()`. Instead it should hold that play command briefly and wait for a matching `command:seek`. If the seek arrives in that window, the receiver applies the seek while paused, lets the target settle briefly, and then calls `.play()`. If no matching seek arrives, the held play falls back to normal playback so non-seek play commands still work.

## Why This Approach

- It is scoped to the broken path: paused DRM receivers handling out-of-order remote seeks.
- It leaves YouTube, Vimeo, and standard HTML5 sites unchanged.
- It avoids moving Crunchyroll-specific policy into shared server/channel code.
- It matches the empirical root cause from the handoff: the bad state is created by calling play before the repositioning command has been safely applied.

## Guardrails

- Only enable the sequencer on DRM hosts.
- Only hold play when the target position differs materially from the current paused position.
- Only consume a queued play when the incoming seek matches the queued target within a small tolerance and arrives within a short timeout.
- Clear queued state after release or timeout to avoid poisoning later commands.

## Verification

- Add a channel-level regression test for the existing server broadcast semantics so backend behavior stays explicit.
- Add a small JS regression harness for the content script command sequencer and verify:
  - `play` then matching `seek` on DRM applies seek before play.
  - `play` without a following seek still plays after timeout.
  - Non-DRM behavior is unchanged.
