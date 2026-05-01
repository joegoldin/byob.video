
# byob Changelog

---

# v6.8.2

### Bands diagram tracks room jitter; SyncDecision logging

**Green "in sync" band now sized by room jitter consensus**, not
local noise floor. That's the value actually driving tolerance —
the band visually communicates "everyone in the room is within
this much of each other on average". Falls back to local noise
floor for single-user rooms; clamped at tolerance so green never
overflows yellow. Status chip mini-text updated from
`jitter ~Xms` to `room jitter ~Xms`.

**Server-side seek decision logging.** `Byob.SyncDecision` now
emits a Logger.info entry every time it issues a seek:
`[sync_decision] seek drift=X target=Y overshoot=Z streak=N
learned_L=Lms`. So `fly logs | grep sync_decision` shows the
full decision flow per peer — useful for diagnosing "why isn't
this client seeking" questions.

Server-only / no extension republish.

---

# v6.8.1

### Hotfix: clock-adjustment sign bug

v6.8.0's room-wide clock adjustment had the sign backwards. Drift
sign convention is `local − expected`. When peers are behind,
mean drift is negative; expected is too HIGH; we should LOWER
`current_time`. My code did `current_pos - (mean × 0.3) / 1000` —
which for negative mean *added* to current_pos, pushing the
canonical reference further away from where peers actually were
on every adjustment pass.

Symptom: peer drifts grew gradually instead of converging to 0;
clients sometimes appeared "stuck out of sync" because the
reference kept racing ahead.

Fix: `current_pos + (mean × 0.3) / 1000`. Negative mean → negative
adjustment → `current_pos` decreases → drift converges to 0.
Positive mean (peers ahead, rare) works symmetrically.

Server-only / no extension republish.

---

# v6.8.0

### Tighter tolerances + room-wide clock adjustment + extension status text

Three independent improvements:

**Tighter tolerance band (300 / 1000 ms).** Previously 600 / 30000.
The v6.7.x adaptive-L learning means seeks converge to ~0 residual
in 2 hops, so a 300 ms floor is comfortable. Ceiling at 1000 ms
keeps peer-to-peer divergence bounded at ~2 s worst case (was
unbounded). Adaptive landing in the middle: `K × jitter` settles
at 600 ms territory on typical wifi.

**Room-wide clock adjustment.** New: `room_server` now subscribes
to its own room's PubSub and observes every peer's drift samples.
Every 10 s, if ≥ 2 active peers have a consistent mean drift
(|mean| > 100 ms, all behind or all ahead), it shifts the
canonical reference position by 30 % of that mean (capped at
200 ms per pass) and broadcasts a fresh `:sync_correction` so
clients pick it up. Peer drifts converge to ~0 over a few
adjustments; nobody fights a poorly-calibrated room reference.

Heavily defended: only fires while playing, requires ≥ 2 peers
(single-peer drift is structural lag, not room-wide), damped
fractionally so adjustments stay below the 500 ms jitter-spike
rejection threshold on clients (won't poison their EMAs or
SyncDecision L-learning).

**Extension status text during seeks.** No popup overlay (mirrored
that to the main page in v6.7.4); instead, the existing byob bar
in the extension shows transient sticky status text when the
content script is mid-correction:
- "Joining…" — initial sync after `command:synced`
- "Catching up…" — peer-driven seek (`command:seek`)
- "Re-syncing…" — server-driven seek (`sync:seek_command`)

Each is sticky for 2.5 s (3 s for joining, covers two-seek
convergence). Polling-driven status updates (playing / paused)
are skipped during the sticky window so the transient text doesn't
flicker.

Server-only **plus** extension republish (Chrome Web Store +
Firefox Add-ons).

---

# v6.7.4

### "Syncing…" overlay during corrective seeks

When the client is mid-correction it now shows a translucent
spinner overlay so it's clear that playback isn't fully settled
yet. Three triggers:

- **Joining…** — initial join's seek + the server's adaptive-L
  follow-up seek (typically 2-3 s combined).
- **Catching up…** — a peer just seeked and we're seeking to
  match them.
- **Re-syncing…** — server-driven seek command from
  `Byob.SyncDecision`.

Auto-hides on the next "playing" state from the player, or after
a 3 s safety timeout. Re-showing while already visible just resets
the timer, so the multi-seek L-learning sequence on join stays up
continuously instead of flickering.

`pointer-events: none` — purely informational, doesn't block
interaction with the player below.

Server-only / no extension republish.

---

# v6.7.3

### Stats panel polish

Four small tweaks to the connected-clients section:

- **Jitter row always shown.** Was hidden when 0; now renders
  `<1ms` (in success-green) when calm, `Xms` otherwise. So you can
  tell at a glance whether the client is reporting *calm* vs.
  *not yet measured*.
- **"Learned seek lag" row** added to the local user's row when the
  server's `Byob.SyncDecision` has converged on a value. Lets you
  watch the adaptive L learning settle in real time.
- **Offset trace removed from the local clock-sync chart.** It's
  always 0 in the server-driven model — the violet line was dead
  pixels. Chart is now RTT (blue) + drift (amber) only.
- **"You" highlighting.** Local user's row in the connected-clients
  list gets a primary-tinted border + "(you)" tag in the header so
  it's obvious which row is yours.

Server-only / no extension republish.

---

# v6.7.2

### Extension: server-driven sync (mirror v6.7.0/v6.7.1 to extension/content.js)

Brings the extension up to the same architecture as the browser
player: the extension is now a measurement reporter and command
executor, with no local seek decisions or rate correction.

**Stripped from `extension/content.js`:**
- Adaptive offset EMA (`_offsetEmaMs`, `_offsetSamples`,
  `_OFFSET_*`) — server's `Byob.SyncDecision` learns total
  round-trip compensation per-client.
- Hard-seek path with `_hardSeekFailures` / `HARD_SEEK_GIVE_UP_ATTEMPTS`.
- Rate correction (`DRIFT_RATE_MIN/MAX`, `DRIFT_RATE_TIME_CONSTANT`,
  `DRIFT_HARD_THRESHOLD_S`) — same iOS-Safari-silently-ignores
  reasons that motivated removing it from the browser side.

**Added:**
- Jitter EMA tracking (Δdrift per tick, ~1 s horizon, with
  500 ms single-tick rejection so seeks don't poison it).
- Periodic `VIDEO_DRIFT` message with `{drift, noise_floor_ms}`;
  background.js now also fills in `rtt_ms` from its own clockSync.
- `EVT.SYNC_SEEK_COMMAND` handler in dispatchToContent — executes
  server-issued seek targets (which already include learned-L
  overshoot from the v6.7.1 fix).

**Server-side `extension_channel.ex`:**
- `:user_sync_state` and `:clients` now in socket assigns at join.
- New `handle_info({:sync_client_stats, ...})` runs `SyncDecision`
  for this extension's user (mirrors the LV's behaviour).
- `video:drift` handler accepts and broadcasts `noise_floor_ms` /
  `rtt_ms` so room-jitter consensus and per-client tolerance work.
- Pushes `sync:seek_command` to the extension when a seek is
  needed.

**State-mismatch enforcement stays.** The extension still rectifies
silent paused-vs-playing toggles from sites like Crunchyroll
autoplay, since those bypass our event handlers.

Net: extension ~80 LOC of sync logic deleted; both browser and
extension peers now run identical decision logic on the server.

**Extension republish required** — Chrome Web Store + Firefox Add-ons.

---

# v6.7.1

### Hotfix: convergence (rtt double-count) and jitter-from-seeks

User report on v6.7.0: "Re-syncing now" stuck on, drift not converging,
seeks fucking up the jitter and drift values.

**Bug 1: rtt/2 double-counted in seek target.** The server's seek
target was `expected + (learned_L + rtt/2) / 1000`, but the L
observation formula `L = last_overshoot − drift_after` already
absorbs the round-trip into `learned_L`. Adding rtt/2 separately at
seek-time meant we over-shot by that amount, drift went positive,
next seek didn't overshoot (positive-drift case), drift went
negative again, oscillation forever — the panel showed perpetual
"Re-syncing now" while seeks fired but never converged.

Fix: drop the explicit rtt/2 addition. `learned_L` is now the *total*
round-trip compensation. First seek (learned_L = 0) goes to
expected — residual drift is one full round-trip + seek-processing,
which we observe and use as the second seek's overshoot. Drift
converges to ~0 in two seeks.

**Bug 2: seeks poisoned the jitter EMA.** Every seek caused a huge
`Δdrift` between consecutive ticks (position jumped). The jitter EMA
absorbed that as if it were measurement noise, inflating tolerance
for tens of seconds — server then *stopped* deciding to seek, which
looked like the system giving up.

Fix: reject any single `|Δdrift| > 500 ms` from the EMA update. Real
network jitter never spikes that high tick-to-tick; values that
large are always seeks.

Server-only / no extension republish.

---

# v6.7.0

### Server-authoritative sync with adaptive seek-latency learning

Major refactor: the seek decision moves from the browser to the
server. Each user's LV owns a `Byob.SyncDecision` state machine in
its assigns. The browser is now a *measurement reporter*: it sends
drift / jitter / rtt at 1 Hz; the server computes tolerance, checks
sustained drift, applies cooldown, and issues a `sync:seek_command`
event with a pre-computed target. The browser executes it.

**Why this shape.** Removes the duplicated reconcile logic across
browser and (eventually) extension. Server has the room's full
picture; better positioned to decide consistently. Decision logic
in Elixir is testable in a way browser code never quite is.

**Adaptive seek-latency (L) learning.** v6.6.2 tried a static
`seek_target = expected − drift` overshoot, which oscillated
because drift ≠ L. The server-driven model fixes this: after each
seek, the next drift report tells us the residual `L = overshoot −
drift_after`. Server tracks an EMA of L per user. Subsequent seek
commands use `target = expected_now + (rtt_ms / 2 + learned_L) /
1000` — overshoot exactly compensates for the round-trip + the
device's actual seek processing time, drift converges to ~0 in one
shot.

**Reconcile.js shrinks dramatically.** From ~150 LOC of decision
logic to ~80 LOC of measurement + a single `executeSeek(target,
server_time)` callback. Deleted: `seekStreak`, cooldown ladder,
`seekCandidateTicks`, MAX_SEEK_STREAK, post-seek tolerance bumps,
`_applyHardSeek`, `_cooldownRemainingMs`, all of it. Server owns
the equivalent state.

**Drift report payload simplified.** Browser ships
`{drift_ms, rtt_ms, noise_floor_ms, playing}`. Tolerance / streak /
cooldown are now server-computed and only flow back via the panel
push to the local user.

**Panel still works as before.** Server stuffs the computed
tolerance / streak / cooldown / learned_L into the local user's
clients-map entry post-decision, so the existing template reads
them naturally. Other peer rows show drift / jitter / RTT only —
those decisions are owned by their own LVs.

**Extension still on the old client-driven model.** The extension
codebase needs the same simplification (turn its content.js into a
measurement reporter that listens for `sync:seek_command` from the
Channel). Separate task; requires extension republish through
Chrome / Firefox stores. v6.7.x for that.

Server-only / no extension republish.

---

# v6.6.4

### Tolerance ceiling raised — accept what each client can actually deliver

User feedback on v6.6.3: "make this whole thing dynamic so if clients
are somehow 2 s apart and we can never sync them because jitter is
that bad, accept it". The 1000 ms ceiling was forcing constant
seeking on links that genuinely couldn't hold tighter sync.

`MAX_TOLERANCE_MS` raised 1000 → 30 000. Effectively no hard cap;
tolerance now scales freely with observed jitter. Pathological
clients (e.g. cellular spike → 2 s jitter) get a 8 s tolerance band,
peers can drift 16 s apart without correction, and we *stop fighting*.
The 30 s value exists only to short-circuit runaway EMA values;
nothing real reaches it.

Floor stays at 600 ms (still bounded by typical YT/iOS seek-completion
residual until adaptive-L learning lands in the server-driven rewrite).

Tradeoff: peer-to-peer divergence on bad links is now bounded only by
their actual jitter. Worse-looking numbers in pathological cases, but
the alternative was visible audio stutter as we kept slamming seeks
into a link that couldn't keep up. User experience strictly better.

Server-only / no extension republish.

---

# v6.6.3

### Hotfix: revert v6.6.2 overshoot — was oscillating

User report: clients were oscillating between ~1500 ms behind and
~800 ms ahead, never settling. Diagnosis:

v6.6.2's `seek_target = expected − drift` assumed drift = −L (where L
is seek processing time). That's true *after a previous failed seek*,
but NOT for first-time drift coming from a late join or buffering.
There drift can be 1500+ ms while L is 500-700 ms; overshooting by
the full drift puts us 800 ms ahead, next iteration overshoots back
to 1500 behind, infinite oscillation.

Reverted to no-overshoot: just seek to `expectedPosition`. After the
seek, drift converges to a residual ≈ −L (server's clock kept
advancing during the seek processing window). To prevent re-seeking
on that residual, bumped tolerance floor 100 → 600 ms and ceiling
500 → 1000 ms — wide enough to absorb typical YT/iOS L without
constant seeking.

Tradeoff: peer-to-peer divergence now bounded at ~2 s worst case
instead of ~1 s. Wider than ideal, but stable beats oscillating. The
proper fix is the upcoming server-driven rewrite with adaptive
per-client L learning — server observes drift after each seek
command, learns each client's real L, includes correct overshoot in
subsequent commands.

Server-only / no extension republish.

---

# v6.6.2

### Drift-compensating seek overshoot — converges in one shot

User report on v6.6.1: "ios client sees that it's out of sync, attempts
to sync, but always seeks to the time that is out of sync by our drift."

Right diagnosis. A seek isn't instantaneous: by the time the player
lands at the target, the server clock has advanced by ~L seconds
(the seek processing window). When drift = −L (we're L behind
*because of* that lag), seeking straight to `expectedPosition` lands
us at `expected_at_seek_start` while the server is now at
`expected_at_seek_start + L`. We end up L behind again. Same drift,
re-seek, same lag, same residual — infinite loop, audible as a
stutter on the lagging client.

Fix: `seek_target = expected − drift`. Symmetric. For drift = −800 ms
we seek to `expected + 800 ms`; for the rare positive case we seek to
`expected − drift`. By the time the seek lands, real position equals
expected_at_completion. Drift converges to 0 in one shot for the
common case; the rare "ahead due to clockSync error" case slightly
overcorrects but the next iteration's small negative drift self-damps
through the same formula.

Restored `MAX_SEEK_STREAK` from 1 → 3 since each seek now actually
converges instead of leaving residual L. Streak still resets after
10 s of quiet.

Server-only / no extension republish.

---

# v6.6.1

### Hotfix: stop seek-loop on iOS, stop spurious pause broadcasts

v6.6.0's first user observation: "jumps all over the place and then
paused". Two compounding bugs:

**Seek loop on iOS YT embeds.** `getCurrentTime` lags the actual
seek by 1-2 s on mobile Safari. Reconcile would seek, cooldown
elapses (1 s), re-measure drift, *still huge* (because the seek
hadn't visibly landed yet), re-seek, repeat. Fixed by calling
`pauseFor(2000)` after every seek so the player gets a quiet window
to actually land before we re-evaluate. Also added a streak cap:
after 3 consecutive seeks without settling, give up for this
session (resets after 10 s quiet) — better than thrashing on a
device where seeks fundamentally aren't sticking.

**Spurious pause broadcast on seek.** Reconcile-driven seeks
weren't suppressing player state events. On iOS the seek triggers
a PAUSED → BUFFERING → PLAYING flicker; the unsuppressed PAUSED
got pushed as `EV_VIDEO_PAUSE`, server broadcast pause to the
room, everyone paused. Fixed by wrapping the reconcile `seekTo`
callback to call `suppression.suppress("playing")` before the
seek, swallowing the flicker.

Server-only / no extension republish.

---

# v6.6.0

### Drift correction: seek-only, exponential cooldown, no more rate correction

Major sync rewrite. Rate correction is gone, offset EMA is gone,
and the resulting model is much simpler — and much closer to "what
the user actually sees".

**Why ditch rate correction?** Mobile Safari and ad-supported YT
embeds silently ignore `setPlaybackRate`, so the loop fires forever
without making progress. The visible "rate correction stuttering"
was almost always a *hard seek* firing once drift overshot the
threshold while we thought we were rate-correcting. Removing the
illusion: just seek when we actually need to, rate-limit how often
we can, run at native 1.0× the rest of the time.

**Why ditch offset EMA?** It was supposed to absorb structural
decoder lag (~100 ms) but it can't distinguish that from "real
positional desync we've given up correcting". When you joined a
playing room a second late, the EMA learned the 1 s desync as
"structural" → adjusted drift = 0 → reconcile thought everything
was fine → desync became permanent and *invisible*. The whole
mechanism was hiding bugs we should be fixing.

**The new model.** Use raw drift. Tolerance is an adaptive band
driven by the jitter EMA only: `4 × max(local_jitter, room_jitter)`
clamped to `[100 ms, 500 ms]`. Inside tolerance: in sync, do
nothing. Outside for 300 ms sustained: hard seek. Seeks gated by
exponential cooldown — 1 s, 2 s, 4 s, 5 s (cap) — with the streak
reset after 10 s of quiet. Net: typical session is *one* seek
(late join), worst case settles to one seek every 5 s.

**Convergence guarantee.** With ceiling at 500 ms, peer-to-peer
divergence is bounded at ≈ 1 s worst case (two peers drifting in
opposite directions); typical case is ≈ 200-400 ms because the
floor wins on calm links. After every seek, drift snaps back to
~0 and bounces around 0 with magnitude ≤ jitter. No more 1500 ms
"learned offsets" hiding desyncs.

**Panel updates.**
- Bands diagram redesigned with three zones — green (jitter),
  yellow (tolerated), red (seek) — plus a state chip ("In sync" /
  "Within tolerance" / "Re-syncing soon" / "Re-syncing now") that
  shows cooldown remaining when relevant.
- "Hard seek at" row removed (it was the same as tolerance now).
- "Seek cooldown" row appears when a streak is active.
- Per-peer "Offset" row auto-hides for browser peers (always 0
  now); still shown for extension peers (where it's a manual
  config).
- "Local clock sync" multi-line chart simplified — no more
  offset trace.

**Tradeoff.** Devices with very slow decode pipelines play
~100 ms behind everyone else's display, and we no longer
compensate. The 100 ms gap is invisible in practice and we were
never compensating cleanly anyway — we were just hiding it.

Server-only / no extension republish.

---

# v6.5.54

### Settings modal scroll position survives LV updates; (peer) tag on max-drift

**Settings modal scroll preservation.** The modal-box re-renders on
every drift report (1 Hz/peer), and without an explicit scroll
guard the browser would clamp scrollTop on every update — visible
as the panel jumping to the top whenever the user toggled a
collapsed `<details>` and an LV diff happened to land in the same
frame. Replaced the v6.5.48 `scrollIntoView` workaround in
`PreserveDetails` (which mis-aligned tall panels to "top of
viewport" the moment they exceeded modal-box height) with a new
`PreserveScroll` hook on `<div class="modal-box">`: tracks
scrollTop continuously via a passive scroll listener, snapshots
in `beforeUpdate`, and restores in `updated` on the next frame so
post-layout clamping is reverted. Toggling sections in the
settings modal now leaves the user where they were.

**"Room max |drift|" tags the driver.** The row was just a number;
now it shows `(peer)` and highlights amber when a peer's `|drift|`
exceeds the local user's — same updating-status treatment as
"Room jitter (consensus)" so it's clear at a glance whether
*you're* setting the bar or someone else is.

Server-only / no extension republish.

---

# v6.5.53

### Hotfix: pass play_state to settings_modal (KeyError → reload loop)

v6.5.52's new "Server position" row in the stats panel reads
`@play_state` to decide whether to extrapolate the freshest peer's
position forward to render time. But `settings_modal` doesn't
declare `:play_state` as an attr, so accessing `@play_state`
inside it raised `KeyError` on every re-render of the modal in
production. Each `:sync_client_stats` (1 Hz / peer) blew up the
LV process; the auto-reload-on-disconnect timer in `app.js` then
reloaded the page every 30 s, in a loop.

Fix: declare `attr :play_state, :atom, default: :paused` on
`settings_modal/1` and pass `play_state={@play_state}` from
`room_live`.

Server-only / no extension republish.

---

# v6.5.52

### Drift tolerance honors room-wide drift spread, not just jitter

v6.5.51's room consensus only looked at **jitter** (tick-to-tick
`|Δdrift|`). A peer 600 ms behind with a steady signal has tiny
jitter — so the consensus stayed tight, drift tolerance stayed at
the 250 ms floor, and the calm peer kept rate-correcting against
the slow peer's offset. Wrong signal.

**Two-signal consensus.** Server now publishes both
`room_jitter_ms` (max peer jitter EMA) and `room_max_drift_ms`
(max peer `|drift|`). Reconcile takes
`max(K_jitter × jitter, K_drift × maxDrift)` as the input to the
adaptive dead zone — so the band widens for either kind of
spread. K factors differ because the inputs aren't the same:
- `K_jitter = 4` — many sigmas of headroom over noise
- `K_drift  = 1.5` — just enough margin to clear the worst peer's
  sustained offset
Same idea for hard-seek (`K_hard_jitter = 30`, `K_hard_drift = 5`).

**Panel updates.**
- New "Room max |drift|" row, amber when > 250 ms.
- "Drift tolerance" now annotates the driver: `(local jitter)`,
  `(peer jitter)`, `(peer drift)`, `(floor)`, or `(ceiling)` —
  amber when a peer is setting the bar. Same updating-status
  treatment as the jitter rows.
- New "Jitter" row inside each connected-client card so you can
  see per-peer noise alongside their drift / RTT / offset.
- "Server position" was being shown per-peer with values 0.3–1 s
  apart — looked like an NTP bug, was actually report-arrival
  timing (each peer's report processed at a slightly different
  server moment). Moved to a single canonical row at the top of
  the Connected clients section, extrapolated forward from the
  freshest peer report. Per-peer rows lose the misleading column.

Server-only / no extension republish.

---

# v6.5.51

### Room-wide jitter consensus, offset bootstrap fix, scroll-stable glossary

Three connected fixes:

**Drift tolerance is now driven by *room* jitter, not local jitter.**
The previous adaptive logic was per-client: each peer scaled its
own tolerance to its own jitter EMA. That meant a calm peer (joe,
jitter ≈ 8 ms) sat at the 100 ms tolerance floor and constantly
rate-corrected against a jittery peer's drift; a noisy peer
(iphone on cellular) had its own narrow tolerance and kept
slamming into the hard-seek threshold whenever buffering pushed
its drift past it.

Now: server computes `room_jitter = max(noise_floor)` over all
non-stale peers, pushes it to every client on each
`:sync_client_stats`, and Reconcile uses
`max(local, room) × K_dead` as the input to its adaptive dead
zone (and same for hard-seek). Calm peers tolerate the room's
noisiest signal instead of fighting it; noisy peers don't keep
provoking buffering with a too-tight tolerance. New "Room jitter
(consensus)" row in the panel shows the value, highlighted amber
when a peer is setting the bar.

Floors also bumped to match the UI's existing 250 ms warning
threshold (dead zone min 100→250 ms, hard-seek min 2000→3000 ms).
And the offset-EMA cap moved 500→1500 ms so high-bias peers
(mobile decode pipelines) can actually have their structural
latency learned and subtracted.

**Offset EMA bootstrap fix.** The EMA was gated on
`!isRateCorrecting`. A peer with a real structural bias sat
ABOVE the dead zone forever → constantly rate-correcting →
never stable conditions → EMA never converged → bias never got
subtracted → still above tolerance. Catch-22. Removed the gate;
the EMA's slow alpha (~5 s horizon) averages out the transient
catch-up motion of rate correction, and the existing
OFFSET_CAP_MS guard still rejects genuine outliers. Combined
with the wider room tolerance, biased mobile peers should now
settle to a stable equilibrium with offset learned and rate
correction off.

**Glossary scroll fix.** Closing the "What do these mean?"
`<details>` inside the modal could leave the scroll container
clamped past the new (shorter) content, making it feel like the
page jumped. Added a click handler in the `PreserveDetails` hook
that calls `scrollIntoView({block: "nearest"})` on the next frame
so the summary stays where the user clicked it.

Server-only / no extension republish.

---

# v6.5.50

### Adaptive drift thresholds + redesigned correction-bands diagram

The drift-tolerance and hard-seek thresholds were static constants
(50 ms / 3000 ms), with only event-driven hysteresis to widen them
post-seek or while rate-correcting. That's wrong: the *whole point*
of hysteresis on a sync system is that it should adapt to what
each client actually sees. A peer with 700 ms of network jitter
needs a wider tolerance than 500 ms; a peer on the same LAN as the
server doesn't need 250 ms.

**Adaptive thresholds.** Reconcile now tracks a per-tick jitter
EMA — `|drift_t − drift_{t-1}|`. Robust to bias (offset is already
subtracted) and to slow drift (a steady ramp produces a small,
constant Δ). The effective dead zone is roughly `4 × jitter`,
clamped to `[100 ms, 1500 ms]`. The effective hard-seek threshold
is roughly `30 × jitter`, clamped to `[2 s, 8 s]`. Post-seek and
mid-correction hysteresis still apply as additive bumps on top.

Knock-on benefit: the offset EMA finally has a chance to converge
on cross-coast links. Old 50 ms dead zone meant rate correction
fired on almost every tick, and offset learning is gated on
`!isRateCorrecting` — so the EMA stayed pinned at 0 and structural
latency never got subtracted. With an adaptive baseline, calm
moments exist for the EMA to learn during.

**Stats panel: jitter row + cleaner band diagram.** Added a new
"Jitter (Δdrift EMA)" row showing the live noise estimate. The
correction-bands diagram was redesigned with proportional sections
(5 % / 20 % / 50 % / 20 % / 5 %) so the dead zone is always
visible regardless of how small ±dead is in absolute terms. Big
state chip up top reads "In sync" / "Rate-correcting" /
"Hard-seek territory" with matching color; threshold values
labeled under section boundaries; section captions ("rate
correct", "in sync", "rate correct") below.

Also fixed: `handle_info({:sync_client_stats, ...})` was missing
`dead_zone_ms`/`hard_seek_ms`/`rate_correcting` from the stored
client map, so the "Hard seek at" line at the top of the panel
showed the static fallback (3000 ms) even when the bands diagram
below it had the live value (4000 ms while correcting). Same
data source now feeds both.

Glossary updated to describe the adaptive logic.

Server-only / no extension republish.

---

# v6.5.49

### Stats for nerds: tolerance / hard-seek track hysteresis, persist glossary

Two follow-up tweaks on v6.5.48:

**Drift tolerance / Hard seek now track the live values.** The
top-of-panel "Drift tolerance" line was hardcoded to `250ms` —
which was the UI warning threshold, not Reconcile's actual dead
zone (`50ms`, widened to `500ms` for 5 s after a hard seek). It
now reads the local browser's effective threshold from its own
most-recent drift report and renders `±50ms` normally,
`±500ms (post-seek)` highlighted when widened. A new "Hard seek
at" row does the same: `±3000ms` normally, `±4000ms (correcting)`
when rate-correction has nudged the threshold up. Same source of
truth as the band-diagram below, so the numbers and the band
widths now move together.

**Glossary persists across re-opens.** The collapsed "What do
these mean?" `<details>` was resetting to closed every time the
settings modal re-opened. Added `id="stats-glossary"` and
`phx-hook="PreserveDetails"` so its open state survives LV
re-renders, matching the parent `Stats for nerds` panel.

Server-only / no extension republish.

---

# v6.5.48

### Stats for nerds: correction bands diagram, glossary, |drift|, fix join-time hitch

A few iterations on the v6.5.47 sync visualization plus a real bug fix:

**Glossary.** The Stats-for-nerds panel now ends with a collapsed
"What do these mean?" section explaining drift, offset, RTT,
server pos, correction interval, drift tolerance, and the
sparklines. No more guessing what each number is.

**`|drift|` aggregate.** "Drift avg / min / max" became
"|Drift| avg / min / max" — the sign is meaningless across a
multi-peer roll-up, and signed values made min/max read backwards
(min was the *most negative*, looking like everyone was barely
behind when in fact one peer was way behind). Per-client rows
keep the signed value where direction still tells you something.

**Correction-bands diagram.** A new visualization under the
local clock-sync chart shows the dead-zone / rate-correct /
hard-seek bands as a horizontal dial, with vertical dividers at
±dead-zone and ±hard-seek thresholds, and a white tick marking
the current local drift. The active band is rendered at full
opacity; inactive bands at ~18 %, so the eye snaps to "where am
I right now". A status chip below reads things like *in sync*,
*rate-correcting*, *hard-seek territory*. Crucially, the band
widths are sourced from the player's *effective* thresholds —
not the constants — so when hysteresis grows them (post-seek
dead zone widens 50 → 500 ms; hard-seek threshold widens
3000 → 4000 ms while rate-correcting), the green / amber bands
visibly expand and the chip explicitly calls it out:
*"dead zone widened (post-seek): 500 ms"*. To support this the
drift-report payload now carries `dead_zone_ms`, `hard_seek_ms`,
and `rate_correcting`, plumbed through the existing
`:sync_client_stats` broadcast.

**Fix: join-time hitch when peers join a playing room.** Tracing
why hitches happen on join surfaced a real bug. After
`_applyPendingState` runs `suppression.suppress("playing") +
seekTo + play`, YouTube routinely fires
`PLAYING → BUFFERING → PLAYING` (the buffering coming from the
seek). The first PLAYING was consumed by suppression and
scheduled the 200 ms settle timer; the BUFFERING branch in
`_onPlayerStateChange` returned early without touching
suppression, so the settle fired during the buffer and the
*second* PLAYING leaked through as a `pushEvent(EV_VIDEO_PLAY,
{position: <still-settling>})`. That broadcast as `:sync_play`
to every peer, who all `seekTo(stalePosition) + play()` —
visible as a hitch the moment a new peer's video became ready.

Fix: `Suppression.cancelSettle()` clears the pending settle
timer; `_onPlayerStateChange`'s buffering branch calls it before
returning. With the settle held until the post-buffer state
arrives, the second PLAYING is suppressed correctly and the
spurious `:sync_play` no longer fires. The 3 s safety timeout
still releases suppression in the worst case, so we can't get
permanently stuck.

Server-only / no extension republish.

---

# v6.5.47

### Stats for nerds: graph RTT / drift / offset over time

The Stats-for-nerds panel now visualizes sync history, not just
the latest snapshot. Useful for diagnosing the kind of cross-coast
flakiness that motivated v6.5.46.

**Local clock-sync chart** at the top of the panel: a 60-second
multi-line chart showing this browser's RTT (blue), drift (amber),
and learned offset (violet) sourced from the existing `clockSync`
samples and `Reconcile` instance. Auto-scaled per metric, with a
live legend underneath. Inline SVG, ~360×80 px.

**Per-peer drift sparkline** inside each connected-clients row: a
60-sample sparkline of that peer's `drift_ms`, color-graded
green / amber / red to match the existing numeric drift cell. Lets
you see at a glance who's drifting and when, instead of just the
single most-recent value.

The browser-side drift report now includes `rtt_ms` (median over
`clockSync.samples`) so each peer's RTT is also visible to others
in their row. Server forwards every `:sync_client_stats` broadcast
to a new `sync:client_stats` `push_event`; a small `StatsPanel`
hook owns ring buffers keyed by `<user_id>:<tab>` and redraws the
relevant SVG on each sample. SVG containers use `phx-update="ignore"`
so server re-renders of the panel don't clobber the drawings. No
chart libraries — pure inline SVG, ~150 LOC.

Server-only / no extension republish.

---

# v6.5.46

### Smoother sync for high-RTT-variance peers (cross-coast 3+ users)

Three users on different coasts reported "weird skipping" while
watching together. Tracing the drift-correction loop turned up
two compounding holes in the existing hysteresis:

**`driftHistory` was being wiped every second.** The 5-sample
rolling median is supposed to absorb per-tick jitter, but
`setServerState` cleared the history on every call — and the
server broadcasts `:sync_correction` once a second to refresh
each client's reference point. With 100 ms ticks, the median
was being computed on 1–4 samples for half of every cycle. A
single bad RTT sample after the reset could dominate the
median and trip the hard-seek path.

**The hard-seek path acted on a single tick.** Drift > 2 s on
one tick → resync → seek. Cross-coast links have higher RTT
variance, so spikes near the threshold are common and were
landing as visible "skips".

Three fixes in `assets/js/sync/reconcile.js`:

* `setServerState` now takes `{ resetHistory }`. Default
  `true` preserves existing semantics for play / pause / seek.
  Periodic refreshes (`sync_correction`, `state_heartbeat`)
  pass `false`, leaving the median filter warm so it can
  actually smooth jitter between corrections.
* New `HARD_SEEK_CONFIRM_TICKS = 3` gate: the hard-seek flow
  only triggers after 300 ms of sustained over-threshold
  drift. Single jitter spikes get filtered. Once a resync has
  confirmed real drift, the seek still happens immediately on
  the next tick (no second wait).
* `HARD_SEEK_THRESHOLD_MS` 2000 → 3000 (and
  `HARD_SEEK_THRESHOLD_WHILE_CORRECTING_MS` 3000 → 4000).
  Rate correction (±10 %) handles 3 s of drift in ~30 s
  anyway; this gives variable-latency peers more headroom
  before falling back to a hard seek.

Net: jitter spikes no longer cause skips, and the rolling-
median hysteresis can finally do its job. Trade-off is ~300 ms
extra latency before recovering from a *real* desync —
invisible compared to a skip.

Server-only / no extension republish.

---

# v6.5.45

### Validate roulette / vote candidates are embeddable + have a thumbnail

Pool entries (used as roulette / voting candidates) could land
in a round without a thumbnail, or — worse — flip the player
into the embed-blocked fallback when the spinner / vote winner
ended up being a video YouTube no longer allows external
playback for. Both happened because the pool sources didn't
require either field at upsert and the pick path didn't re-
validate.

Two layers of defence:

**At upsert.** `Byob.Pool.valid_entry?` now requires a non-
empty `thumbnail_url` and rejects entries whose `embeddable`
flag is explicitly `false`. The trending source now requests
the `status` part from the YT Data API so it actually knows
the answer (curated + subreddit either have status from
elsewhere or already build a fallback thumbnail URL).

**At pick.** `start_round` over-fetches 3× the target and
walks each candidate through `Byob.YouTube.Videos.fetch/1`
in parallel (`Task.async_stream`, max 12 concurrent, 3 s
timeout). Cached lookups are essentially free; uncached are
HTTP but parallel, so total latency stays sub-second for
typical pool sizes. Any candidate the API returns
`embeddable: false` for, or that we can't pull a thumbnail
URL for from any source, is dropped before the round
broadcasts. Missing pool fields (duration / title / thumb)
get backfilled from the API response in the same pass.

Graceful degradation: if the API itself is down (quota /
network error), candidates that already have a thumbnail
in the pool row are kept rather than dropping the entire
round to "no candidates available". The worst case under
that path is a non-embeddable winner, which the existing
LV embed-blocked fallback UI handles.

Server-only / no extension republish.

---

# v6.5.44

### Tab-title notification badge while backgrounded

When the room tab is in the background (other tab focused, or
window minimised) and a notable event happens — someone joins
or leaves, a video is queued, the queue advances, a roulette
or vote winner is decided — the document title is now prefixed
with `(N) ` so the count shows up in the OS / browser tab list.
On switching back to the tab, the count resets to 0 and the
title goes back to "byob | bring your own binge".

Implementation: server pushes a new `notify` event from
`handle_room_presence` (joined / left) and from
`handle_activity_log_entry` for action ∈ `[:added, :now_playing,
:roulette_winner, :vote_winner]`. Excluded from notifications
on purpose: `:play / :pause / :seeked / :renamed /
:round_cancelled / :finished / :skipped / :played` — those fire
constantly during normal viewing and would spam the title.

Client-side `TabNotifier` hook (mounted on a hidden div in
the room LV) tracks `document.hidden` via `visibilitychange`,
counts unread `notify` events while hidden, and re-renders
`document.title`. Reset is automatic on the next visibility
flip.

Server / LV / main-page-JS only — no extension republish.

---

# v6.5.43

### Validate `:video_ended` by item id, not queue index

Intermittent symptom: with two videos queued behind a playing
one, finishing the current would *occasionally* skip the first
in queue and play the second. Reproducible if a second tab was
backgrounded while the first played to its end.

Root cause was that `current_index` is always 0 server-side
after each `advance_queue` (it always pulls the just-finished
item out and sets the next item to index 0), and the client's
`data-current-index` attribute is also set to 0 by the
`_onVideoChange` handler. So the `current_index: index` clause
guard at room_server.ex `:video_ended` matched on every
`:ended` regardless of which item the client was *actually*
reporting on. As long as `pending_advance_ref` was nil at the
time the message was processed, the server happily started a
fresh 5 s countdown.

The race that triggered the skip:

1. A finishes. Tab 1 (foreground) pushes `:video_ended`,
   server schedules advance for `t = 5 s`.
2. Tab 2 was backgrounded — its 500 ms `setInterval` is
   throttled, so the seek-detector tick that would have
   noticed A reaching `dur - 1` never fires before
   `t = 5 s`.
3. `t = 5 s`: server fires `:advance_pending` → queue
   advances to B, `pending_advance_ref` is cleared.
4. `t = 6 s`: Tab 2's tick *finally* runs, sees A still at
   its final position (the iframe didn't auto-progress),
   pushes a stale `:video_ended`. Server's index check
   trivially matches (both still 0) and `pending_advance_ref`
   is now nil → another 5 s countdown is scheduled.
5. `t = 11 s`: that countdown fires, queue advances B → C.

User sees: A finishes → B plays for ~6 seconds → C takes
over. From that vantage it looks like the first item in
queue (B) was skipped.

Fix is server-side validation by item id and client-side
sending it:

- `Byob.MediaItem` already had a per-item `id`. The video
  player hook now stores `_currentItemId` whenever it loads
  a video and sends `{ item_id: this._currentItemId }` in
  every `:video:ended` push (replacing the always-stale
  `index`).
- `RoomServer.handle_call({:video_ended, ref_value})`
  accepts either an item id (binary) or a queue index
  (integer, kept for clients that haven't reloaded yet).
  Match-by-id requires the *current* item's id to equal
  the reported id; a stale `:ended` from a tab still
  watching an already-advanced-past item resolves to a
  different id and is rejected as stale.
- Extension content script tracks `currentItemId` from
  `command:initial-state` / `command:synced` /
  `command:video-change` and sends it with `video:ended`
  too, plumbed through the channel.

Server / LV / extension all need the new build for the fix
to land everywhere.

---

# v6.5.42

### Live content support (YouTube live, Twitch)

Live streams broke the time-based sync engine: server-broadcast
seeks would knock peers off the live edge, drift correction
would constantly fight the player's own live management, and
position-based ended detection would never fire because
duration grows with wall clock. The fix is a `is_live` flag
that gates time-based sync on both server and client paths,
plus runtime auto-detection so the flag can flip in either
direction without user intervention.

**MediaItem.is_live**: New struct field. URL parser seeds it
from a path heuristic — `youtube.com/live/<id>` and
`twitch.tv/<channel>` (any path except `/videos/`) start out
as live. Live broadcasts living under `/watch?v=<id>` flip via
runtime detection (below).

**Server skips for live**: Seek `RoomServer.seek/3` calls
short-circuit, `:state_heartbeat` and `:sync_correction` skip
the broadcast. Play / pause continue to sync — that's all the
state a live stream actually needs to share between peers.

**Runtime auto-detection** (LV embed): poll `getDuration()`
every 3s during playback. If duration grows at ~wall-clock
rate (0.5x to 1.5x of elapsed seconds), live. If stable
(grew < 0.5s), VOD. Inconclusive samples (e.g. metadata
loading from 0 to 3600 in one tick) wait for the next
sample. Pushes `video:live_status` to server when detected
state changes; server broadcasts to peers via
`{:live_status, ...}` so every player flips in lockstep.

**Runtime auto-detection** (extension content script):
`video.duration === Infinity || isNaN(duration)` is the HLS
live signal — Twitch live streams expose Infinity, VODs
finite. Same `video:live_status` channel push routes through
to other peers.

**Bidirectional switching**: when a live broadcast ends and
duration stabilizes, detection flips `_isLive` back to false.
The `if (this._isLive) return;` gate I added to the YT
"ended" state-change handler stops blocking, position-based
end detection re-engages, and the queue advances normally.

**Twitch via extension popup**: Twitch URLs go through the
existing `:extension_required` path — same popup flow, just
with reconcile + drift suppression while live. No new source
type.

Server changes + LV-side changes ship in v6.5.42; the
extension content-script changes ship in the same build but
require an extension republish to take effect for users on
twitch.tv. YouTube live works without an extension update
(LV embed handles it).

---

# v6.5.41

### Only hook tabs opened from a byob room

The content script gated activation on a `chrome.storage.local`
config that was URL-keyed: any tab anywhere on the matching URL
within a 30 minute window claimed it. So a stale entry from an
earlier byob session would activate sync on a Crunchyroll tab
opened by another tool (e.g. another sync extension's external
player popup) — even when the user wasn't currently in any byob
room.

Replaced the URL-based handoff with per-tab BG tracking:

- byob.video page postMessages `byob:open-external`. Content
  script forwards to BG via `chrome.runtime.sendMessage`,
  which records the *opener* tabId.
- The new tab's content script asks BG `byob:check-managed`.
  BG resolves via `sender.tab.openerTabId`: only tabs whose
  opener was a byob.video tab that recently requested an open
  get a `{managed: true, config}` response.
- `chrome.tabs.onRemoved` cleans up the marking when the tab
  closes. Long-lived state lives in `chrome.storage.session`
  so SW restarts don't lose it mid-session.

Stale entries can no longer leak across tabs — the opener
relationship is the gate, not URL plus timestamp.

Extension republish for both stores; no server changes.

---

# v6.5.40

### Drop `tabs` permission (Chrome Web Store rejection)

The `tabs` permission was added in v6.5.30 alongside the
`BYOB_FOCUS_EXTERNAL` self-heal path that calls
`chrome.tabs.get(tabId)` from the service worker. The only
field that call reads is `tab.windowId`, which is a non-
sensitive Tab property and is available without the `tabs`
permission. None of the other `chrome.tabs.*` calls in
background.js (`onRemoved`, `remove`, `update`) require
`tabs` either, and no code path reads `url`, `title`,
`favIconUrl`, or `pendingUrl` from a Tab object.

Chrome Web Store rejected v6.5.30 on this exact basis
(violation Purple Potassium). Dropped from both manifests
to comply.

Extension republish for both stores; no server changes.

---

# v6.5.39

### Warm clockSync immediately on LV reconnect

`reconnected()` was tearing down the old `ClockSync` and creating
a fresh one but not starting it — relying on the server's
mount-time `SYNC_STATE` push to land and trigger `_onSyncState`,
which in turn awaited `clockSync.start()`. After a deploy that
round-trip can stall by several seconds, and until
`clockSync.isReady()` flips back true the drift-report interval
in `mounted()` early-returns — which makes this client
disappear from other peers' Stats-for-nerds Connected clients
panel for the duration of the gap.

`reconnected()` now calls `clockSync.start()` and
`maintainSync()` directly. If `_onSyncState` lands later it'll
re-call `start()` harmlessly (a second burst overlays this one
and the existing `ready` flag stays true throughout).

Main-page-JS-only / no extension republish.

---

# v6.5.38

### Stats-for-nerds: render Connected clients from the user list

The "Connected clients" section in Stats for nerds was rendering
from the recent-drift-report map filtered to the last 5 s. After
a deploy, both LVs disconnect for several seconds and every
client's last drift report ages past 5 s. When reports resume,
they update the row only for clients whose `clockSync` warmed
back up promptly — a tab that's slow to re-warm (background
throttling, slow reconnect, paused player not driving the
interval) effectively disappears from the panel even though
they're plainly online.

Now the panel iterates the connected-users list instead and
overlays drift data per row. Users with a recent drift report
get the full numbers; users without get a "no drift data"
placeholder under their name. The post-deploy blackout becomes
visible as the placeholder, not silence.

Server-only / settings-modal-template-only.

---

# v6.5.37

### Reset `_endedFired` on any detected seek

`_endedFired` only got reset when the seek detector observed
`pos < dur - 2` on a 500 ms tick. A rapid sequence of seeks (e.g.,
the YT replay button briefly leaves the player past `dur` →
`fireEnded` → `_endedFired = true`, then the user immediately
seeks back to near the end faster than the next tick) could
sandwich the reset branch — the next tick saw `pos > dur - 2`,
didn't reset, and the natural end-of-video play-through silently
no-op'd because `_endedFired` was still `true`. Result: queue
hung at the visual end of a video that had clearly finished.

Any time the seek-detector recognizes a large position jump (the
seek itself), `_endedFired` and `_endedAt` are cleared. A user
seeking is unambiguous evidence they aren't at the end anymore,
so a subsequent natural play-through to `dur - 1` re-fires
`video:ended` correctly.

---

# v6.5.36

### Doc / changelog scrub

CHANGELOG, CLAUDE.md, and the extension listing copy now read
straightforwardly without comparisons to other sync extensions or
references to internal recon work. Pure prose change — no code
touched.

---

# v6.5.35

### Bump leave grace from 1.5 s → 5 s

Real-world WAN reconnects (5G handoffs, VPN flip, browser tab
reload) commonly take 2-4 seconds, well past v6.5.12's 1.5 s
window. False "X left" toasts were firing whenever a friend's tab
breathed funny. Bumped the deferred-leave timer to 5 s.

Drift correction thresholds (50 ms dead zone, 2 s hard-seek)
unchanged — the actual sync feels fine, the only symptom was the
spurious presence churn.

---

# v6.5.34

### Tighten the YT ended-stall fallback

v6.5.33's fallback gated on `playerState === "playing"` and a
30-s-or-5%-of-duration window. Both were wrong: the actual stall is a
**paused/ended** local state with the server still expecting playing
(YT silently parked at the final frame), and the 30 s window had no
business being that wide.

Tighter conditions now:
- position is within the **last 5 seconds** of `getDuration()`,
- local `playerState` is `paused` or `ended`,
- `this.expectedPlayState === "playing"` (so an intentional user
  pause near the credits — which would have flipped
  `expectedPlayState` to `"paused"` via the onStateChange `:pause`
  push — doesn't trigger),
- position hasn't advanced for ~3 s (6 consecutive 500 ms ticks).

---

# v6.5.33

### Two-column placeholder card + stall-fallback for YT ended detection

**Layout.** The "Open Player Window" card moved off the centered
column so the button sits on the **left** and the explanatory copy
on the **right**, both inside the alert box. The card now sits near
the bottom of the player (its column flexes to fill, with the card
nailed below it) instead of crowding the title/status. Padding
inside the alert is bumped slightly.

**Stall-fallback for ended.** Some YouTube videos park at a final
position a couple seconds short of `getDuration()` and never advance
— the existing `pos >= dur - 1` backstop missed them, leaving the
queue stuck without ever firing `video:ended`. The seek detector
now also fires ended if all of:
- position hasn't moved for ~3 s (6 consecutive 500 ms ticks),
- player state is `playing`,
- we're within the last 30 s (or last 5 %) of `getDuration()`.

Real buffering near the start / mid-video doesn't qualify (we gate
on the near-end window). Stall counter resets on `onLoadStart` so a
new video never inherits the previous one's tick count.

---

# v6.5.32

### Roulette / vote winners get duration overlay on the queue thumbnail

Manual `add_to_queue` for a YouTube URL fired
`Byob.YouTube.Videos.fetch/1` on a `Task.start` and updated the queue
item via `:oembed_result` so title / thumbnail / duration land within
a tick. Pool-driven enqueues (`append_pool_winner/2` for roulette and
voting winners) skipped that fetch — and curated-playlist candidates
have `duration_s: nil` because the YouTube `playlistItems` endpoint
doesn't return durations. The result: roulette winners from curated
playlists landed in the queue without the `M:SS` overlay on their
thumbnail.

`append_pool_winner/2` now fires the same metadata fetch, so the
overlay (and any missing title/thumb) shows up shortly after the
winner is enqueued.

---

# v6.5.31

### Nickname suffix shows up in Stats for nerds → Connected clients

The Nicknames hook scoped its scan / MutationObserver / click delegation to
its own element (`#byob-nicknames-root`), but the settings modal — where
the Stats for nerds panel lives — is rendered as a sibling of that
element, not a descendant. So usernames inside the modal never got the
` (nickname)` suffix. Hook now scans / observes / delegates from
`document.body`, picking up the modal, autoplay-help dialog, and any
future top-level overlay.

---

# v6.5.30

### Self-heal stuck "Focus Player Window" state

If the SW was suspended when the popup tab closed, it could miss
both `port.onDisconnect` and `chrome.tabs.onRemoved` — leaving the
server's `open_tabs` with a phantom entry. `ready_count.needs_open`
then kept claiming the user had a popup, so the placeholder button
stayed on "Focus Player Window" indefinitely; clicking it tried to
focus a tab that wasn't there.

`byob:focus-external` handler now walks `hookedTabs`, calls
`chrome.tabs.get(tabId)` per entry, and on any rejection (tab gone)
cleans the entry out of `hookedTabs` and pushes
`video:tab_closed` + `video:unready` to the channel. Within a tick
the server rebroadcasts `ready_count` without the phantom, the
button label flips back to "Open Player Window", and the next
click opens a fresh popup.

---

# v6.5.29

### Restyle the placeholder's player-window button

Wrapped the inline button + hint copy in a daisyUI `alert` card so
they read as a unit (mirroring the outlined banner the button used
to live in before v6.5.28). The hint copy is now two explicit lines
("Extension required for this site." / "Click play on the video for
the extension to hook it.") instead of a single wrapping paragraph.

---

# v6.5.28

### "Open / Focus Player Window" button moved inside the player placeholder

Previously the button lived in an `alert mb-3` banner above the player
column. At certain window aspect ratios that banner could be pushed
off-screen or hidden under the sidebar, leaving users unable to
re-open the popup window.

The button is now rendered by `assets/js/players/extension.js` directly
inside the black placeholder box (under the title, status line, and
progress bar), so it's always visible whenever the room's current
video is `extension_required`.

The button reuses the same flow as the old `ExtOpenBtn` — auth
context (room id, token, username) comes from the player div's
`data-*` attributes, the popup-state label flips between
"Open Player Window" and "Focus Player Window" via the same
server-side `ready_count` payload, and the click posts
`byob:focus-external` (BG-mediated focus) when a popup is open or
`byob:open-external` + `window.open(…, "byob_player", …)` otherwise.

The LV banner is gone; the small "Extension required for this site"
hint moves into the placeholder as a small footer line.

---

# v6.5.27

### Fix Nicknames hook locking the page

The Nicknames hook attached a `MutationObserver` to its element to
catch LV-driven DOM changes — but `_refresh()` itself adds/removes
sibling suffix spans inside that subtree, which re-fired the
observer synchronously, calling `_refresh()` again, and so on until
the page froze.

Two guards added:
1. `_refreshing` flag wrapping the mutation pass — observer
   disconnects before we mutate and reconnects after, so our own
   add/remove operations don't echo back into the observer.
2. `_scheduleRefresh()` coalesces a burst of LV mutations into a
   single microtask so even multi-element diffs settle in one pass.

Setting a nickname (or just rendering the page after this lands)
no longer hangs.

---

# v6.5.26

### Reset external-player progress bar on third-party → third-party transition

When the room moved between two extension-required videos (CR ep 1 →
ep 2, etc.) the placeholder kept the previous video's progress fill
and `1:17 / 23:40` timeline until the new popup re-hooked. Hook now
clears `_lastExtPlayerState` and re-renders inside `_onVideoChange`
so the placeholder collapses to "Waiting for external player…" until
fresh state arrives from the new tab.

---

# v6.5.25

### Local nicknames + suppress YT auto-replay during autoplay countdown

**Local nicknames.** Each user row now has a small `nickname` button
next to other users. Clicking it pops a prompt and saves the entered
text to `localStorage` under `byob_nicknames`. Wherever a username
is rendered (user list, Stats-for-nerds connected clients, activity
log lines) a muted ` (<nickname>)` suffix appears alongside it.
State is per-browser, never sent to the server, so it doesn't
affect anyone else's view.

A new `Nicknames` JS hook on the room root walks
`[data-byob-username]` elements on mount, on every LV update, and
via a MutationObserver, then appends/removes a sibling
`.byob-nickname-suffix` span per the localStorage map.
`[data-byob-nickname-btn]` buttons are wired through the same hook.

**YT auto-replay no longer cancels the autoplay countdown.** When
the LAST queue item finished, YouTube's end-card UI was occasionally
flicking the player back into a `playing` state on its own (related-
video preview, end-card hover, etc.). The hook treated that as a
user replay and pushed `:play` to the server, which cancelled the
advance timer; the video then played again, ended, scheduled a
fresh countdown, and only then ended the queue.

Hook now records `_endedAt` on the ended transition and treats any
`playing` event landing within 500 ms of it as an auto-replay —
suppresses the `:play` push and pauses the player so the queue can
finalize. A real user click on YT's replay button (always seconds,
not milliseconds, after ended) still cancels the countdown as
v6.5.18 intended.

---

# v6.5.24

### Stats panel no longer prunes browser drift rows on every users_updated

`PubSub.handle_users_updated/2` extracted the row owner via
`String.split(key, ":", parts: 2)`, which on a browser drift-report
key (`session:tab:browser`) gave just `"session"` — never matching
the connected `@users` keys (`session:tab`). So every join/leave
pruned every browser-side row, leaving only your own (whose first
report happened to land between two prunes) plus extension clients
(whose keys really are two-part).

Owner is now "everything before the last `:`", same parse the
template uses, so multi-colon LV user_ids resolve correctly and the
panel actually shows everyone connected.

---

# v6.5.23

### Show deployed commit hash in settings

Settings modal's version line now reads `vX.Y.Z (abc1234)`, where the
hash links to the corresponding github commit. The version itself
still links to the CHANGELOG.

`Byob.Build.sha/0` resolves the hash at compile time from (in order)
`GIT_SHA` env var, then `git rev-parse --short HEAD` if `.git` is
present, otherwise `nil` — releases built outside the deploy flow
just don't render the parens. `Dockerfile` accepts a `GIT_SHA` build
arg, and `just deploy` calls `fly deploy --build-arg GIT_SHA=$(git
rev-parse --short HEAD)` so production carries the correct ref.

---

# v6.5.22

### Rename "Details for nerds" → "Stats for nerds"

Settings panel summary, container id (`stats-for-nerds`), and stale
comment references all renamed.

---

# v6.5.21

### Rename Details-for-nerds section to "Connected clients"

The drift-stats section was historically titled "Extension clients"
because only the extension reported. Since v6.3.0 the LV main player
also reports its drift via `video:drift_report`, and v6.5.20 made
those rows resolve their username correctly. The label is now
"Connected clients" (and the empty state "No clients reporting")
so it's not misleading when the only viewer is watching YouTube
directly in the LV.

---

# v6.5.20

### Details-for-nerds: usernames resolve correctly for browser drift reports

The "Extension clients" panel showed `(unknown)` for browser-side
drift-report rows because the LV per-tab `user_id` is itself
`session:tab`, and the panel built the `client_id` key as
`user_id:tab_id` — yielding `session:tab:browser`, three colon-
separated parts. The template's `String.split(..., parts: 2)` then
extracted only `"session"` as `owner_id` and looked it up in
`@users`, which is keyed on the full `session:tab`.

Two fixes:

- The `sync_client_stats` broadcast now carries `username` directly
  (from `RoomServer` state for extensions, from `socket.assigns` for
  the LV drift-report path). The panel uses it when present and
  falls back to the `@users` lookup for older rows.
- The owner/tab split parses `client_id` as "everything before the
  last `:` is the owner, the last segment is the tab" so multi-colon
  user_ids resolve correctly even without the broadcast username.

---

# v6.5.19

### Firefox manifest: bump strict_min_version for `data_collection_permissions`

The AMO validator flagged that
`browser_specific_settings.gecko.data_collection_permissions` requires
Firefox 140 (desktop) and Firefox for Android 142, but the manifest
declared `strict_min_version: 128`. Bumped to 140.0 desktop / 142.0
Android (added `gecko_android`). Cleared the validator warnings; the
"no data collection" disclosure stays in the manifest.

---

# v6.5.18

### Roulette landing fix + tab-close fallback + YT replay cancels autoplay

**YT replay no longer gets skipped past.** When a YouTube video ended,
byob fired its 5 s autoplay countdown — but YouTube also rendered its
end-card replay button right where the user was looking. Clicking it
restarted the video locally; the countdown timer kept running and
yanked everyone to the next queue item 5 s later. Now the server's
`:play` handler calls `maybe_cancel_pending_advance/1` so a fresh
play during the countdown kills the advance timer (broadcasting
`autoplay_countdown_cancelled` to clear the overlay too). The hook
also resets `_endedFired` on the playing-state transition, so a
subsequent end-of-replay-run still pushes `video:ended` correctly.

### Roulette ball lands on the right slice + tab-close fallback signal

**Roulette off-by-one.** `RouletteWheel._tickLanding` settled the ball
at `theta0 + v0/k` after the running phase finished, but
`_simulateSlice` (and `Round.simulate_landing_slice/2` on the server)
both compute the winning slice using `(v0/k)(1 - e^-4)`. The
`(1 - e^-4)` factor is ~0.9817, so the ball over-rotates by ~1.83%
of `v0/k` before settling — enough to land one slice past the
server-determined winner near a slice boundary. The settle now uses
the same truncated rotation, so the visual landing matches the
server's slice exactly.

**Popup-close detection fallback.** Some browsers / SW-suspension
states miss the `port.onDisconnect` that fires when a popup tab
closes — when that happens, BG never sends `video:tab_closed`, the
server's `open_tabs` keeps the stale entry, the ready_count
broadcast still claims the user has a popup, and the LV's
"Focus / Open" buttons stay stuck on "Focus" forever.

`background.js` now also listens for `chrome.tabs.onRemoved`. It
flushes any stale port entries for that tab, removes from
`hookedTabs`, and pushes `video:tab_closed` + `video:unready` to
the channel. The browser's tab-removed event is independent of SW
lifecycle, so this catches the cases where the port disconnect
silently went missing. Both `manifest.json` and
`manifest.firefox.json` gain the `tabs` permission.

---

# v6.5.17

### "Focus player window" actually focuses + works across YT/CR transitions
### + extension detection works on any host

Three fixes in one round.

**1. Focus actually focuses.** YT's COOP severs both `.closed` and the
parent's ability to call `.focus()` across the boundary, and the
content-script side can't navigate to the popup either. New flow: a
`byob:focus-external` window-postMessage hops through the page-level
content script (`chrome.runtime.sendMessage`) to BG, which calls
`chrome.tabs.update(tabId, {active: true})` +
`chrome.windows.update(windowId, {focused: true})` on the user's
hooked tab. Works regardless of COOP. `ExtOpenBtn` and the YT fallback
button both use this on click when the user already has a popup;
otherwise they open fresh.

**2. ExtOpenBtn label survives YT→CR popup navigation.** Previously
the label polled `window._byobPlayerWindow.closed`, which YouTube's
COOP poisoned permanently — even after the popup re-navigated to
Crunchyroll, the parent's WindowProxy never recovered. The button
showed "Open Player Window" and clicking duplicated. Now the label
is driven by the server's `ready_count` payload (specifically
`needs_open`): if the user's username isn't in that list, they have
a hooked-video popup somewhere — label says "Focus Player Window".
The BG's port-disconnect detection on actual close fans out via
the channel, so closing all popups flips the label back without any
client-side `.closed` polling.

**3. Extension detection works on any host.** `content.js` previously
only set `data-byob-extension` on `byob.video` or `localhost`. LAN
access (192.168.x.x), ngrok tunnels, dev domains, etc. all looked
"extension not installed" to the page. The LV root template now
renders `<html data-byob-app="1">`, and `content.js` checks for
that marker (in addition to the legacy hostname allowlist) before
broadcasting extension presence. Marker is a no-op for unrelated
sites, so this doesn't expand the fingerprint surface.

---

# v6.5.16

### YT fallback — server ready_count drives "Focus" label

v6.5.15 dropped the `.closed` gate everywhere because YouTube's
COOP severs it, but doing the same on the YT fallback's click
handler (via the unified `_openInExternalWindow`) caused every
"Focus player window" click to actually open a fresh popup —
COOP also breaks named-target reuse, so `window.open(url,
"byob_player")` creates a new window instead of focusing the
existing one. And the click never resets the label after the
user manually closed the popup, since `!!window._byobPlayerWindow`
stays truthy.

`ExtOpenBtn` is back to its v6.5.14 form — `.closed` works fine
for Crunchyroll and similar non-COOP sites, and the named-target
window reuse works there too.

The YT fallback now derives both label and click behavior from
the server's `ready_count` payload: if the user's username is
**not** in `needs_open`, they already have a hooked-video tab —
label says "Focus player window" and clicking shows a toast
("Player window already open — check your taskbar") instead of
duplicating. When the user actually closes the popup, the BG's
port disconnect flushes through to the server which rebroadcasts
`ready_count` with the username back in `needs_open`, flipping
the label and re-enabling open-new behavior.

`_onVideoChange` and the page-unload handler keep the v6.5.15
"don't gate close on `.closed`" behavior — those paths actually
need to close YT popups, where `.closed` lies.

---

# v6.5.15

### Stop trusting `WindowProxy.closed` across COOP boundaries

YouTube serves the watch page with `Cross-Origin-Opener-Policy:
same-origin`. When the popup opened from the embed-blocked
fallback navigates there, the parent's `WindowProxy.closed` flips
to `true` even though the popup is still wide open. That made the
"Focus player window" label flicker back to "Open in player
window" within ~500 ms, and (worse) made `_onVideoChange`'s
`if (… && !window._byobPlayerWindow.closed)` guard skip the popup
close on subsequent transitions off the YT video.

Every site that touches `_byobPlayerWindow` now keys on the
reference itself instead of `.closed`:

- `youtube_error.js` label poll: `!!window._byobPlayerWindow`.
- `video_player.js` `_onVideoChange` close + the page-unload
  handler: drop the `.closed` guard, just call `close()`. Closing
  an already-closed window is a no-op, so the unconditional call
  is safe.
- `app.js` `ExtOpenBtn`: same. The click handler is also unified —
  it always posts `byob:open-external` and calls
  `window.open(url, "byob_player", …)`. The named-target reuses an
  existing popup (or opens a fresh one if the previous reference
  was stale), then `focus()`-es it. No more separate "if open,
  just focus" branch that could get tricked by COOP.

The label poll now also re-queries `[data-byob-yt-label]` by
selector each tick instead of holding a closure-captured DOM
reference, so a fallback-UI rebuild during `handleYTError`'s
retry path doesn't leave a stale label sitting at the wrong
text.

---

# v6.5.14

### Close extension tabs on every transition off third-party + dynamic
### "Open / Focus player window" label on the embed-blocked fallback

Two related fixes.

**Tab close** — `background.js`'s `CHAN_VIDEO_CHANGE` handler used
to call `closeExtensionTabs()` only inside an `autoplayCountdownActive`
branch. Manual queue→Play Now of a YouTube video, or "Set room to
this page" pointing at a YouTube URL, both fell through to a
metadata-only broadcast and left the third-party popup open. Now
the rule is simpler: if the new video is **not** `extension_required`,
close every connected extension tab — regardless of how the
transition was triggered.

**Dynamic label** — the "Open in player window" button on the
embed-blocked YouTube fallback (age-restricted etc.) had a static
label, so a user could click it twice and end up with two popups.
It now polls `window._byobPlayerWindow` every 500 ms and flips to
**"Focus player window"** when one is already open — same UX as
the existing `ExtOpenBtn`. The poll is cleaned up on hook destroy
and on every `_loadVideo`.

---

# v6.5.13

### YouTube URL matching ignores playlist / timecode / autoplay context

`normalizeUrl/1` now collapses every YouTube URL form to
`https://www.youtube.com/watch?v=<id>`:

- `/watch?v=<id>&list=…&index=…&t=…` → canonical
- `youtu.be/<id>` → canonical
- `/shorts/<id>`, `/embed/<id>`, `/live/<id>`, `/v/<id>` → canonical

Previously the literal-string comparison flagged the room URL
(`/watch?v=abc`) and the page URL (`/watch?v=abc&list=…`) as
different videos and tripped the "You've left the room's video"
toast on age-restricted YouTube embeds opened in the popup window
(which gets the playlist context appended automatically).

Non-YouTube hosts keep the existing behavior — strip hash + a
trailing slash, otherwise compare the full URL — since other
sites (Crunchyroll, etc.) typically distinguish episodes via the
path itself, not query params.

---

# v6.5.12

### 1.5 s grace period before honoring a leave

When a user's socket briefly drops and reconnects within seconds (a
common case on flaky networks or quick page reloads), the room
treated each transition as a real leave/join: "X left" + "X joined"
toasts spammed, the activity log doubled up, and — worst — if the
room was down to 2 users, the leave path's ≤1-user pause logic
fired and stopped playback for everyone.

`RoomServer.leave/2` now schedules a `{:finalize_leave, user_id}`
message via `Process.send_after` (1.5 s timeout) instead of running
the leave side-effects synchronously. `RoomServer.join/4` cancels
any pending finalize for the same `user_id` (LV reconnect path,
where `user_id` is stable) before its own logic runs. The
finalize handler only fires the deferred work if the user is still
absent at the timeout — so:

- LV reconnects within the window: no state change, no toasts.
- Extension reconnects (which generate a fresh `user_id`) within
  the window: the new socket joins under the same username; when
  the old `user_id`'s timer fires 1.5 s later, `username_connected?`
  returns true, so the "left" toast and ≤1-user pause are
  suppressed.
- Genuine disconnects (no reconnect): toast fires after 1.5 s as
  before, and the room pauses if it's down to one human.

The activity-log `:joined` entry is now also gated on
`was_present` so reconnects don't spam the feed.

`pending_leaves` was added to the GenServer struct (initialized
empty, restored as empty on persist-reload). The state file format
gains a no-op key on disk; older snapshots `Map.merge` cleanly with
the new defaults.

---

# v6.5.11

### Embed-blocked YouTube fallback opens in the byob popup window

The "Watch on YouTube" button on the embed-blocked fallback (age-
restricted videos, embed-disabled-by-uploader) was a plain
`<a target="_blank" href="https://youtube.com/watch?v=…">`. It
opened a fresh browser tab with no room context, so the extension's
content script had nothing in `chrome.storage` and sync didn't
auto-engage — the user just landed on YouTube as if they'd typed
the URL themselves.

Now (when the extension is detected) the button:

1. Posts `byob:open-external` with the room id / server URL / token
   / username — same payload as the regular "Open in extension"
   flow, written into `chrome.storage` by the content script.
2. Opens the URL in the `byob_player` named popup window (1280×800,
   no menubar/toolbar) and focuses it.
3. Re-uses the existing window if one is already open.

Button label is now **"Open in player window"** to match the actual
behavior. The `#player` element gained `data-room-id`,
`data-server-url`, `data-token`, `data-username` so the fallback UI
(built dynamically inside the player div) can read the same auth
context the regular `ExtOpenBtn` button uses.

---

# v6.5.10

### Clearer follow-toast copy + ready-count in the main page's external-player status

The auto-navigate toast now reads
**"Synced to room — now playing this page"** (or "Synced to room —
now playing: <title>" when the title is already known). Previous
"Followed room to new video" was ambiguous about whether the room
moved to the user or the user moved to the room.

The main page's `_onExtPlayerState` now appends a readiness summary
to the extension placeholder's status line, mirroring the
third-party sync bar's tooltip:

```
Playing in external window — 2/3 ready · 1 needs to open · Bob needs to hit play
```

Plumbing: `RoomServer` already broadcasts `{:ready_count, ...}`. The
LV now subscribes via `handle_info({:ready_count, …})` →
`PubSub.handle_ready_count/2` → `push_event(socket, "ready:count", …)`.
The hook stashes the payload (`_lastReadyCount`) and re-renders
through a new `_renderExtStatus/0` whenever either an
`ext:player-state` or `ready:count` event lands.

The suffix is empty when nothing useful can be added (no extension
users yet, or the count hasn't arrived). When everyone's synced it
collapses to "— N/N ready".

---

# v6.5.9

### Toasts stack instead of overlapping + Undo button on SponsorBlock skips

Both windows now route every toast through a shared
`column-reverse`/`flex` container so concurrent messages stack
vertically (newest at bottom) instead of stomping each other.

Main window (`assets/js/ui/toasts.js`): single `#byob-toast-container`
at bottom-center. `showToast` and `showSkipToast` append into it.

Third-party page (`extension/content.js`): single
`#byob-toast-stack`. The join, presence, "followed room to:", and
URL-mismatch toasts share it. All keep the same purple styling;
multiple presence events ("Alice joined", "Bob closed window",
"Followed room to: …") now visibly queue.

Bonus: `showSkipToast(category, onUndo)` now accepts an optional
callback. When `checkSponsorSkip` auto-skips a SponsorBlock segment,
the toast renders a small **Undo** button that seeks back to the
segment's start. `lastSkippedUUID` is preserved so the next 250 ms
sponsor-check tick won't immediately re-skip — the user can watch
through the segment uninterrupted.

---

# v6.5.8

### Toast on the destination page after the room auto-navigates the tab

When v6.5.4's "reuse the existing extension tab" path swaps
`location.href` in response to a room URL change, the post-nav page
now shows a brief purple toast — same style as the "X joined" /
"X closed window" presence toasts — explaining what happened.

A relay key `byob_pending_nav_toast` is written to `chrome.storage`
just before the navigation; the new content script reads it on
init, surfaces "Followed room to: <title>" (or
"Followed room to new video" if the title hasn't been scraped yet),
and removes the key. 15 s TTL keeps a stale relay from firing on
some unrelated future page load.

---

# v6.5.7

### Fix v6.5.6 regression — other users' tabs weren't auto-navigating

v6.5.6 added an unhook-on-URL-mismatch step inside
`checkUrlMismatch/0`, which `setSyncedUrl/1` calls. Order of events
in the `COMMAND_VIDEO_CHANGE` handler ended up:

1. `setSyncedUrl(msg.url)` — `_syncedUrl` flips to the new URL.
2. `checkUrlMismatch()` runs internally — old `location.href` no
   longer matches → `unhookVideo()` → `hookedVideo = null`.
3. Navigate gate `if (msg.navigate && hookedVideo && ...)` fails
   because `hookedVideo` was just nulled.

Result: User A's tab (already on the destination) navigated
correctly (no-op), but User B's tab (still on the old episode)
unhooked and stopped — they had to click the toast button to move.

Capture `wasPlayerTab = !!hookedVideo || synced` once, before
`setSyncedUrl` runs, and gate navigation on that. `synced` is sticky
across the unhook so it's a stable "this tab is acting as a player"
marker.

---

# v6.5.6

### Don't hook videos on the wrong URL

When the user clicked through to the next episode in the same SPA tab
while the room's current video was still playing on the previous URL,
the content script's `MutationObserver` would discover the new video
element on the destination page and hook it. The next play / pause /
seek event from that hijacked element would propagate to the server
as if it were the room's current video — corrupting state for
everyone in the room.

`hookVideo/1` now bails when `urlMatches/0` returns false. The
URL-mismatch poll (`checkUrlMismatch/0`) also unhooks any
already-hooked video on transition into mismatch, and re-hooks any
`<video>` it finds when the user navigates back onto the room's URL.
A new sync-bar state `out_of_sync` ("Out of sync", amber) makes the
state explicit alongside the existing persistent toast.

Net effect: while you're browsing to the next episode, your local
playback events stay local. Pick "Back to room video" to rejoin or
"Set room to this page" to redirect the room — sync resumes cleanly
either way.

---

# v6.5.5

### Fix v6.5.4 — main player was racing the extension and closing the tab anyway

`VideoPlayer._onVideoChange` (LV main hook) unconditionally called
`window._byobPlayerWindow.close()` and broadcast
`byob:clear-external` whenever the room's video changed. Even after
v6.5.4 had `background.js` send `navigate: true` for ext → ext
transitions, the LV path won the race and shut the popup before the
content script could navigate.

Gated both calls on the new media item's source type. If the new
item is `extension_required`, we keep the popup window open and the
`chrome.storage` config intact so the extension's content script can
swap `location.href` in place. For YouTube / Vimeo / direct video,
behavior is unchanged: close the popup and clear storage so the
user falls back to the main LV player.

---

# v6.5.4

### Reuse extension tabs on third-party → third-party transitions

When a queue auto-advances or a "Set room to this page" lands on
another extension-required URL, we no longer close the third-party
tab and force the user to click "Open in extension" again — the
content script just navigates the existing tab to the new URL.

`background.js` now classifies the new media item by source_type:

* **`extension_required`**: broadcast `command:video-change` with
  `navigate: true` to all hooked tabs. Each content script updates
  `chrome.storage`'s `target_url` (so the post-nav reload still
  activates the sync), then sets `location.href` to the new URL.
  Tabs already on the destination URL skip the navigation.
* **YouTube / Vimeo / direct**: keep the existing close-on-autoplay-
  advance behavior so the user falls back to the main LV player.
* **Manual mid-play change to a non-extension type**: just broadcast
  the metadata refresh; don't force close (the URL-mismatch toast
  remains the user's escape hatch).

Only tabs with `hookedVideo` actually navigate — a non-player tab on
the same origin (e.g. a Crunchyroll browse page) gets the metadata
refresh but isn't yanked to a watch URL it didn't ask for. A small
100 ms delay between the storage update and the navigation gives
`chrome.storage.local.set` time to flush before the new content
script's `tryActivate` reads it.

---

# v6.5.3

### Activity log entries for "Set room to this page"

`update_current_url/3` now logs `:played` (same action as queue → Play
Now) instead of `:added`. The activity feed reads "<user> played
<title>" rather than "<user> added <url>", which mis-suggested a queue
add.

The room scrapes the page title later via `video:media_info`. The
existing oembed-update path rewrote `:added` entries when the title
arrived; widened to also rewrite `:played`. The
`update_current_media/2` handler (which is what `video:media_info`
calls) didn't touch the activity log at all — it now rewrites both
`:added` and `:played` entries whose `detail` still holds the URL,
and broadcasts `{:activity_log_updated, ...}` so the LV panel
refreshes. After scraping, the feed reads "<user> played <title>"
instead of "<user> played https://crunchyroll.com/watch/…".

`fetch_sponsor_segments/1` and `fetch_comments_for_current/1` are now
called too — both no-op for non-YouTube sources, so safe for the
extension-required CR/Crunchyroll case but useful when the new URL
happens to be a YouTube link.

---

# v6.5.2

### Fix "Set room to this page" doing nothing after queue ended

Two bugs:

1. After a video ended and the queue cleared, `current_index` becomes
   `nil`. The original `update_current_url/3` `with` clause bailed in
   that case — the message was logged but no state change happened.
   Rewritten to handle both cases:

   * Queue active → rewrite the current item in place (URL +
     re-parsed source_type/source_id, clear scraped title/thumbnail).
   * Queue ended/empty → append a new MediaItem and point
     `current_index` at it.

   Either way the room flips to `:playing` at `current_time: 0` so
   everyone joins the new video without a separate play click.

2. `pending_advance_ref` from the just-finished video was never
   cancelled, so its 5 s timer would later run `advance_queue` and
   either skip past our new video or flip the room back to
   `:ended`. Now cancelled (along with `sync_correction_ref`) before
   the URL update lands.

`schedule_sync_correction/1` reschedules; `add_to_history/2` records
the new item. `queue_updated` and `video_changed` are broadcast so
every client (LV main player + extension tabs) re-syncs.

---

# v6.5.1

### Settings panel polish — username on extension clients + smart popup reset

The "Extension clients" rows in Details for nerds now show the username
(in primary text) followed by `(ext_id_short:tab_id_short)` in muted
text, with the full client_id in a `title=` tooltip. Looks like:

```
host (edbb2f8a:ff79ce7f)
  Drift                    -209ms
  Server pos               117.3s
  State                    playing
```

The "Forget cleared popups" section is now driven by a `DismissedPopups`
JS hook. It scans `localStorage` for the keys it knows about
(currently just `byob_autoplay_help_dismissed`); items whose key isn't
actually set are hidden, and if no key is set the whole section hides
itself. So if you've never dismissed any "don't show again" dialog,
the section disappears entirely. When at least one is set, you see a
bulleted list naming each cleared popup and a single "Re-enable"
button that wipes them.

Adding new dismissable popups is a one-line change — declare the
localStorage key on a `<li data-storage-key="…">` and the hook handles
visibility + reset.

---

# v6.5.0

### Keep extension window open on queue end + "URL mismatch" toast

When a room's queue finishes with nothing next, we no longer close the
third-party tab — the user stays on whatever anime/tv site they were on
and can keep browsing. The sync bar flips to **Queue finished** and the
autoplay-countdown overlay is suppressed on the extension side (main LV
still shows the countdown as before).

When the tab navigates away from the room's canonical URL (SPA click
into the next episode, site autoplay, or manual browsing), a persistent
purple toast pops up with two buttons:

- **Back to room video** — reloads the tab to the room's canonical URL.
- **Set room to this page** — pushes the current URL to the server as
  the room's new current-media URL; every other user's main player and
  extension tabs re-sync to it.

The toast self-dismisses when the tab's URL matches the room's again
(e.g., after clicking "Back to room video" or after "Set room to this
page" succeeds). It only appears in the top frame — iframes can't
navigate the window anyway.

**How it works:**

- `Byob.Events.in_video_update_url/0` → new channel event.
- `RoomServer.update_current_url/3` — re-parses the URL via
  `Byob.MediaItem.parse_url/1`, resets `current_time` to 0, pauses
  playback, broadcasts `{:queue_updated, ...}` and `{:video_changed, ...}`.
- `ExtensionChannel.handle_in(@in_video_update_url, ...)` — plumbs the
  channel event to `RoomServer`.
- `sync:request_state` reply and `sync_state_payload/1` now include
  `current_url`, `current_source_type`, and `queue_size` so the
  extension knows what to compare against.
- `autoplay:countdown` payload now carries `has_next` — the extension
  gates its overlay on this (main LV ignores it, always shows).
- `extension/background.js`:
  - Caches `currentSyncedUrl` and propagates it into `command:initial-state`
    and `command:synced`.
  - On `queue:ended`, broadcasts `command:queue-ended` to content scripts
    instead of closing tabs.
  - On `video:change` without active autoplay countdown, broadcasts
    `command:video-change` with the new URL so content scripts can
    refresh their `_syncedUrl` reference.
  - New `VIDEO_UPDATE_URL` switch case pushes to the channel.
- `extension/content.js`:
  - `setSyncedUrl/1` tracks the canonical URL, kicks off a 1 s polling
    loop that compares `location.href` to `_syncedUrl`, and mirrors the
    URL into `chrome.storage` so full-page reloads still activate.
  - `showUrlMismatchToast/0` — persistent purple toast with the two
    action buttons, matching the style of the existing join and
    presence toasts.
  - `normalizeUrl/1` strips trailing slashes and hash fragments so
    cosmetic differences don't trigger false mismatches.
  - New sync bar state `queue_ended` — "Queue finished" status.

Cross-origin navigation (e.g., out of crunchyroll.com to google.com)
remains unhandled — the extension's content script only activates on
URLs whose pathname matches the launch target, so the toast can't show
on unrelated sites. Same-origin SPA navigation, manual same-site
browsing, and full reloads on the original origin are all covered.

---

# v6.4.0

### Magic-strings + magic-numbers refactor

Every cross-boundary event name (channel, LV push_event, extension port
message, page-world postMessage) and every meaningful timing/threshold
constant now lives in one place. A typo in a constant name is a
compile-time (Elixir) or import-time (JS) error instead of a silent
sync-breaks-for-no-obvious-reason bug.

**New modules:**

- `lib/byob/events.ex` — `Byob.Events` exposes every event string as a
  function (`Events.in_video_play/0`, `Events.sync_play/0`, …). Channel
  `handle_in/3` patterns require compile-time strings, so
  `ExtensionChannel` binds them to module attributes
  (`@in_video_play Events.in_video_play()`) and pattern-matches on those.
- `assets/js/sync/event_names.js` — `LV_EVT` table of every
  push_event/pushEvent/handle_event string + page-world postMessage type.
- `extension/content.js` and `extension/background.js` each carry a
  duplicated `EVT` table (MV3 content scripts can't import modules). Both
  tables are identical and comment-referenced for sync.

**Server-side conversions:**

- `extension_channel.ex` — all 15 `handle_in/3` heads and 11 `push/3`
  calls now reference the Events module.
- `room_server.ex` — presence-event broadcasts (`joined`, `left`,
  `ext_closed`), timing constants (`@state_heartbeat_interval_ms`,
  `@sync_correction_interval_ms`, `@persist_interval_ms`,
  `@rate_limit_reset_interval_ms`, `@sync_broadcast_debounce_ms`).
- `room_live/pubsub.ex` — every `push_event/3` now uses `Events.*`.
- `room_live.ex` — cross-boundary handle_event patterns
  (`@ev_video_play Events.ev_video_play()` style) and sync-state pushes.
- `room_live/playback.ex` — sync_pong push_event.

**Client-side conversions:**

- `video_player.js` — all 16 `handleEvent`/`pushEvent` calls and the
  `byob:clear-external` postMessage now reference `LV_EVT`; drift-report
  interval extracted to `DRIFT_REPORT_INTERVAL_MS`, YouTube pause-on-load
  retries to `PAUSE_ON_LOAD_*` constants.
- `sync/clock_sync.js` — `sync:ping` pushEvent uses `LV_EVT.EV_SYNC_PING`.
- `players/youtube_error.js` — embed error codes (100/101/150) and
  `video:embed_blocked` now named.
- `sponsor_block.js`, `app.js` — page-world postMessage types use
  `LV_EVT.PW_*`.

**Extension-side conversions:**

- `content.js` — all 30+ port postMessages, switch cases, and msg.type
  comparisons reference `EVT`; presence values (`joined`/`ext_closed`)
  reference `PRESENCE`. New timing block covers reconcile tick, debounce,
  guard windows, drift thresholds, rate clamps.
- `background.js` — all 18 `channel.push`/`channel.on` calls, content
  dispatch switch, and clock-sync constants now named.

Zero semantic changes — every string and number resolves to the same
literal value it did before. This is a pure readability + safety pass.

---

# v6.3.0

### Adaptive drift offset — learn structural latency, converge reported drift to zero

The sync-stats panel often showed a stable -200ms (or similar) per client, stably within the 250ms tolerance. That's render-pipeline lag — decode + buffer + display latency — not a clock-sync bug. It's structural. Before this release, we just lived within ±tolerance of the server projection; clients with different structural offsets sat at different wall-clock positions, eating into the hard-seek headroom.

Now each client learns its own offset via an EMA over raw drift during stable playback, then treats `rawDrift == offsetEma` as the neutral baseline. Rate corrections only fire for deviations from baseline. Applied in both reconcile paths:

- `assets/js/sync/reconcile.js` — browser-side (YouTube / Vimeo / direct video)
- `extension/content.js` — extension-side (Crunchyroll / arbitrary `<video>` sites)

Guardrails: alpha = 0.02 (~5s to converge at 100ms tick), cap at ±500ms, 10-sample warmup before applying, freeze learning during recent hard seeks / rate correction, reset on source change. The hard-seek path still uses the raw `expectedPosition` so catastrophic drift recovery still lands on the correct server position.

The extension now reports its learned `offset_ms` in `video:state`; the server subtracts it from computed drift before broadcasting to the LV panel. The browser-side `VideoPlayer` hook reports its own drift + offset every 1s via a new `video:drift_report` LV event, so the local player appears in the panel alongside extension clients. The panel now shows an "Offset" line per client when non-zero, and "Drift" reflects the residual after compensation — the signal that actually matters for mutual client sync.

Clock-sync logic, correction thresholds, generation-counter suppression, and the reconcile/hysteresis loop all remain untouched — the learned offset only shifts where the player *aims*. Uniform -200ms across clients → each learns -200 → all adjusted-drifts → 0 → no corrections fire. Mixed offsets (-50 vs -300) → each learns its own → all converge to the same wall-clock moment.

---

# v6.2.16

### "Forget cleared popups" button in settings

Settings modal gains a ghost button above the attributions/acknowledgements. One click clears every `byob_*_dismissed` localStorage key so "don't show this again" dialogs (currently just the autoplay-blocked help) show up again. The button disables itself after use and flips its label to "Popups will show again" for confirmation.

---

# v6.2.15

### Click-to-play overlays never sit on top of a playing video

Defense-in-depth against the "overlay stuck while video is actually playing" edge case:

- Added `_isLocallyPlaying/0` — returns true iff the YouTube/direct player's state is `playing` or `buffering`.
- Both overlay-show paths (`_maybeShowReadyOverlay` and `_showClickToPlay`) bail out early if `_isLocallyPlaying()` returns true.
- `_onPlayerStateChange` removes both overlays on any transition into `playing` or `buffering`. If the video starts playing while an overlay is on screen (autoplay unblocked itself, host triggered play, whatever), the overlay gets torn down within the same state-change tick.

---

# v6.2.14

### Join-ready overlay on paused-state join; thumbnail behind overlays

Joining a paused room often left users staring at an unclickable black box: the YouTube embed had loaded with autoplay=0, but before the tab received any user gesture the iframe ignored clicks on its own native play button and showed no thumbnail. Nothing visible, nothing clickable.

- New `.byob-join-ready` overlay fires on initial paused state when `navigator.userActivation.hasBeenActive` is false. "Click to join the room" — click activates the tab, briefly play-then-pauses the YouTube embed to force it to render the first frame, then seeks back to the room's current position. When the host plays, autoplay is now allowed.
- Both the join-ready overlay and the existing click-to-play overlay now paint the current video's thumbnail as their background (fetched from `mediaItem.thumbnail_url` or YouTube's hqdefault) with a dark dim layer on top. Users see *what* they're about to watch, not a black void.
- The join-ready overlay gets removed when a `sync:play` or user click arrives, so it doesn't linger after the embed becomes interactive.

---

# v6.2.13

### Show click-to-play overlay when another user starts playback into a blocked tab

Black-player / no-overlay bug when joining a room where another user later starts playback: if the joiner's tab hadn't been interacted with yet, the browser's autoplay policy silently blocked our `_play()` call and there was no signal for the user to do anything — just a dead black embed. The retry-and-show-overlay flow only existed on the initial `_onSyncState` path (room was already playing at join time), not on the `_onSyncPlay` path (room went from paused → playing after join).

Extracted the retry-then-show-click-to-play logic into `_retryPlayOrShowOverlay/1` and call it from both `_onSyncState` (state=playing) and `_onSyncPlay`. Pressing spacebar / clicking somewhere else on the page also gets autoplay working — but now there's an explicit visible overlay instead of an inscrutable black square.

---

# v6.2.12

### Revert v6.2.11 monotonic counter

v6.2.11 introduced a per-room `broadcast_seq` counter alongside `server_time` for the client-side stale check. In practice it made things less reliable than v6.2.10's simpler strict-`<` timestamp check, so this release reverts to v6.2.10 behavior.

No net code change vs v6.2.10 — this is just a version bump to make the manifest versions reflect the rollback.

---

# v6.2.10

### Stale-command check uses strict `<` (not `<=`)

Pause propagated to the sender's tab but not to other tabs: everyone rejected the `command:pause` as stale. The server's `System.monotonic_time(:millisecond)` has 1ms granularity, and a `sync:correction` tick + a `sync_pause` broadcast can land in the same millisecond. The correction arrived first (bumping `serverRef.serverTime` to T), then the pause arrived with the same T, and `msg.server_time <= serverRef.serverTime` treated the equal case as stale and dropped it.

Changed the comparison to strict `<`. Equal server_time is now processed — it's the common case when two server events fire on the same ms boundary.

---

# v6.2.9

### Auto-restore LV connected state after socket drops

Tooltip counted `1/1` instead of `1/2` after a user closed their CR player because their LiveView socket had briefly dropped during the tab-close noise and never got re-marked connected on the server — `ensure_room_pid` only re-joined when the room GenServer itself had died, not when the user's `connected` flag was stale.

`ensure_room_pid` now also calls a new `maybe_restore_connected/2` on every LV event. If `RoomServer.get_state` shows the current user with `connected: false` (or missing from `state.users` entirely), it rejoins silently. Since sync:ping fires every ~100ms while the LV is alive, a stale-disconnected user gets back to `connected: true` within one tick.

`RoomServer.join/4` grew a `silent: true` opt: skips the `:joined` activity log entry, SyncLog entries, and the "X joined the room" presence toast. The users/ready_count broadcasts still fire (that's the whole point — the room needs to re-learn the user is connected).

---

# v6.2.8

### Don't cancel pending pause on sync:correction

CR pause via the native player was intermittent again. The server broadcasts `sync:correction` every 1 second during playing state (reference refresh for drift reconcile). Content.js had an unconditional "cancel pending play/pause on any incoming message" at the top of its message handler — which clobbered the 500ms pause debounce every time a correction landed. Result: the debounce timer got cleared before it could send `video:pause` to the server, and ~2s later reconcile force-played the tab back.

Moved the cancel logic inside the `command:play` / `command:pause` case branches only, where a genuine play/pause command from the server really does override local intent. `command:seek` and `sync:correction` no longer disturb pending local transitions.

---

# v6.2.7

### Presence updates fire when a player tab closes (not only on full disconnect)

Two linked fixes: the ready-count tooltip now correctly transitions back to "needs to open player window" when a user closes their CR player, and the "X closed their player window" toast fires in that scenario too. Previously, if the user had any other extension-connected tab open (byob webapp, a second CR page, etc.), closing just the player didn't trigger any presence update — `video:all_closed` in the extension requires ALL ports to close, and the server's `open_tabs` lumped together "any port" and "actual player tab".

**Extension side.** `video:tab_opened` now fires on `video:hooked` rather than on port connect. Only tabs that actually hook a video element register as player tabs; non-player pages (CR browse, iframes without video) stay out of `open_tabs`. A per-SW `hookedTabs` Set tracks which tabs have registered.

**Server side.** `clear_tab_opened` now emits `{:room_presence, %{event: "ext_closed", ...}}` when the closing tab was the user's last `open_tabs` entry — even if the user still has other ext ports connected. `video:all_closed` stops emitting ext_closed itself (would have duplicated on the "closed my only player" path).

Net effect: closing a player window always fires the toast + tooltip refresh, regardless of what other tabs the user has open.

---

# v6.2.6

### Fix ≤1 pause rule; stale ready-count entries after tab close

Two bug fixes from last round's regressions.

**Pause-at-≤1 was counting raw user_ids, not distinct usernames.** Per-tab user IDs plus the extension SW user mean a single real person contributes 2–3 entries to `state.users`. "3 humans → 2" was computed as "6 user_ids → 4" → no pause. Changed `connected_count` to count `state.users |> Enum.filter(connected) |> Enum.map(username) |> Enum.uniq() |> length`.

**Ready-count tooltip stuck on "needs to click play" after close.** `clear_ready_tab` only ran when `video:unready` arrived. If the SW tore down fast enough that only `video:tab_closed` landed (dropped push, abnormal teardown), the entry in `ready_tabs` lingered — broadcasts after that point kept the user out of `needs_open` and showed nothing useful. `clear_tab_opened` now also deletes the corresponding `ready_tabs` entry as a belt-and-suspenders cleanup.

---

# v6.2.5

### Polling-based pause detector + "closed external window" presence event

Two follow-ups to recurring CR pause issues and the new presence toasts.

**Polling-based pause/play detector.** v6.2.1 routed Bitmovin's `paused`/`play`/`seeked` events into our handlers, but some CR UI paths pause the player without either the `<video>` element's `pause` event OR Bitmovin's `paused` event firing. The symptom: `hookedVideo.paused` is true (the poller reports `playing=false`), but no `video:pause` command ever reaches the server, so reconcile force-plays the tab back to playing after ~2s.

Added a defensive layer inside the existing 500ms time-report interval: track the last polled `hookedVideo.paused` state; on any transition dispatch `onVideoPause` or `onVideoPlay`. Guards (`commandGuard`, `isBuffering`, `expectedPlayState`) prevent echoes and buffer stalls from masquerading as user actions.

**New `ext_closed` presence event.** The "X left the room" toast fires only when the user has fully disconnected (no more presence). If they close just the external CR player window but still have the webapp open, the old toast never fired. Added a separate event `{:room_presence, %{event: "ext_closed", username: ...}}` broadcast when `video:all_closed` arrives — content.js shows "X closed their player window" in the same purple pill as the "Click play on the video to start syncing" toast, and the webapp shows it via the generic `toast` event.

Also bumped the presence toast z-index to 999999 and matched its padding to `showJoinToast` so the two toasts share a visual style.

---

# v6.2.4

### Presence toasts in webapp + pause when ≤1 users remain (reverts v6.2.3 approach)

The v6.2.3 approach (auto-pause when `open_tabs` empty) didn't fire in practice because stale entries and multi-tab port connections kept `open_tabs` non-empty even when no one was actually watching. Replaced with a much simpler rule: **after a user leaves, if the room is down to ≤1 connected user and state=:playing, pause.** Sync is pointless when there's nobody to sync with, and the lone remaining user can hit play whenever they want to watch solo.

- `2 → 1` pauses (the "one person just dropped, leaving you alone" case).
- `3 → 2` does not pause (other user still there to sync with).
- `1 → 0` pauses (original behavior, still triggers cleanup timer).
- Broadcasts `sync:pause` so the remaining client's UI updates.

Also wired the presence event to the webapp: LiveView now handles `{:room_presence, ...}` and pushes a `toast` event through the existing toast mechanism, so web-app users see "alice joined/left the room" the same way extension users do. Previously only the extension was wired up.

### Reverts from v6.2.3

- Removed the `state_heartbeat` `maybe_pause_if_no_active_playback` check.
- Removed the `leave`-time `open_tabs`-based pause hook (the new ≤1 rule covers it cleanly).
- Removed the `last_active_playback_at` field / the unused helpers.

The v6.2.2 duration clamp stays as defense-in-depth.

---

# v6.2.2

### Clamp server-side position projection to current media duration

When a room stayed `play_state=:playing` while nobody was actually playing (all tabs buffering, a pause that never got relayed, or a deploy gap where the load-advance jumped past the end), `current_position/1` would keep adding wall-clock elapsed with no upper bound. The next joiner received a "current_time" past the video's duration and, via reconcile, dragged every existing client to the end of the video (`video:ended` fired, queue advanced).

This is not a clock-sync issue. Server uses `System.monotonic_time(:millisecond)` (a large negative baseline) for both `last_sync_at` and `server_time`; the offset subtracts cleanly on the client. The bug was purely a missing duration bound.

- `current_position/1` now clamps to the current media item's duration when known.
- Load-advance from SQLite clamps to duration as well, so a deploy gap can't resurrect a room with `current_time > duration`.
- `sync_state_payload` and `handle_in("sync:request_state")` already consume `snapshot(state)`, which funnels through the clamped `current_position/1` — no separate fix needed there.

---

# v6.2.1

### Route Bitmovin pause/play/seeked events to sync handlers

When a user paused via Crunchyroll's native player controls, the `<video>` element's `pause` event wasn't reliably bubbling to our listener — Bitmovin's MSE pipeline pauses internally without always dispatching a DOM pause to the element we have hooked. Result: server kept believing `state=playing`, reconcile force-played the pausing tab every ~5s, and the user saw the video refuse to stay paused.

The page-world Bitmovin adapter already emits its own `paused` / `play` / `seeked` events via postMessage (it was doing so for `ready` + time updates only). Route those same events through to `onVideoPause` / `onVideoPlay` / `onVideoSeeked`, which carry the same echo-suppression and debounce guards as the native DOM handlers. Duplicate events from both paths are harmless — the debounce + `expectedPlayState` check dedupe.

---

# v6.2.0

### Presence toasts, username tooltip, and pruned Extension clients panel

Three UX improvements to make sync state self-explanatory:

- **Presence toasts** — when a user joins or leaves the room, a brief "alice joined the room" / "alice left the room" toast fades in at the bottom of the extension sync bar. Makes it obvious why the video paused (the "2/2" count drops, now you see which user disconnected). Server broadcasts `{:room_presence, ...}` on username transitions only — reconnects and additional-tab joins don't fire. Relayed through the channel to `background.js`, which forwards to the top-frame content script.
- **Ready-count tooltip shows usernames** — instead of `1 needs to open external player · 2 need to click play`, the tooltip now reads `1 needs to open player window (vm) · 2 need to hit play (host, alice)`. Server computes `needs_open` and `needs_play` username lists alongside the counts and threads them through to the extension.
- **Extension clients panel prunes stale rows** — the admin panel was showing stale client entries after users disconnected. Now filtered both in the LiveView template (5s freshness window) and when processing presence updates (entries whose owner disconnected get dropped from `sync_stats.clients`).

---

# v6.1.8

### `userInitiated()` only strict within 3s of sync; otherwise trust all events

v6.1.7 added cross-frame click tracking so iframe handlers could see activations that happened in the top frame. That still doesn't help when Bitmovin's shadow-DOM'd player controls call `stopPropagation()` at the shadow boundary — our `document`-level listener never sees the click, so `_lastUserActive` never ticks and `navigator.userActivation.isActive` also misses it. Result: CR-native pause button kept failing to propagate, while byob's sync-bar pause worked every time (because it posts directly to the port, bypassing `onVideoPause`).

The real insight: outside the first 3s after sync, there is no good reason to be paranoid about pause/play events. Our own command echoes are already caught by `commandGuard` and the `expectedPlayState === target` check. CR's autoplay-to-continue-watching fires in that first 3s window and nowhere else in normal usage. So:

- **Within 3s of `command:synced`**: `userInitiated()` requires an activation signal (per-frame `navigator.userActivation` or the cross-frame `_lastUserActive` broadcast). Blocks autoplay.
- **After 3s**: `userInitiated()` returns true unconditionally. User clicks — from any path, in any frame, through any shadow DOM — propagate normally.

Fixes the intermittent pause-via-CR-player-controls issue. sync-bar pause keeps working (it never went through `onVideoPause` anyway).

---

# v6.1.7

### Cross-frame user-activity tracking (fixes intermittent pause)

`navigator.userActivation.isActive` is per-frame. A user click on CR's player controls registers activation in whichever frame receives the event — but the content script that runs our event handlers lives in the iframe (`static.crunchyroll.com`), while clicks on CR's top-frame overlays register in the top frame. Same for spacebar: if the user's focus is in the top frame, the iframe never sees the activation.

Result: user pause clicks were being silently dropped by the `userInitiated()` check, and worked only intermittently (when the activation happened to land in the iframe).

- Each frame now listens for `click` / `keydown` / `pointerdown` / `touchstart` (capture phase) and broadcasts a `byob:user-active` ping via `chrome.runtime.sendMessage`.
- SW relays the ping to every content script via `broadcastToContentScripts`.
- Each frame keeps its own `_lastUserActive` timestamp, updated from local events and from cross-frame broadcasts.
- `userInitiated()` now returns true if either `navigator.userActivation.isActive` OR the last user-activity timestamp is within the 5s window. Catches activations happening in any frame of the tab.

---

# v6.1.6

### Use `navigator.userActivation.isActive` to distinguish user clicks from autoplay

Instead of a 2.5s minimum guard window after sync that was silently dropping user clicks, the event handlers now check the browser's transient user-activation signal directly. It's deterministic: true for real user gestures (click, keypress, touch), false for programmatic/autoplay-triggered events.

- `onVideoPlay` / `onVideoPause` / `onVideoSeeked` reject events without user activation and log "site-initiated — ignored".
- `command:synced` guard drops back to default 300ms (just echo suppression).
- No arbitrary time window where user actions are dropped.

Result:
- CR's autoplay at T+3s after sync: onVideoPlay fires, `userActivation.isActive === false`, event dropped. Reconcile's 2s mismatch grace then re-enforces paused state.
- User clicks pause/play any time: `userActivation.isActive === true`, propagates immediately through the 500ms debounce.
- Fixes the intermittent "pause doesn't work" — that was the guard window racing the debounce.

Browser support: Chrome 72+ and Firefox 118+; both are well below our `strict_min_version: 128` for Firefox.

---

# v6.1.5

### Drop the time-based settling window; echo suppression via commandGuard only

Previous versions had two overlapping suppression mechanisms:

- **`settlingUntil` / `isSettling()`** — a 5s time window after every `command:synced` where outbound DOM events were unconditionally dropped. Originally copied from v4.1.0. Side effect: user clicks during those 5s were silently lost ("I clicked play, nothing happened").
- **`commandGuard`** — a deterministic gate that auto-releases once the video's actual state matches the expected state.

Removed `settlingUntil` entirely. All echo suppression now goes through `commandGuard`. Added an optional minimum-duration parameter to `startCommandGuard(minMs)`:

- **`cmd:play` / `cmd:pause`**: default 300ms minimum. Guard releases as soon as state matches.
- **`command:synced`**: 2.5s minimum. Covers the window where Crunchyroll's player can fire an autoplay-to-continue-watching `play` event ~3 seconds after the player is ready. Without the minimum, that autoplay event would propagate to the server via `onVideoPlay`'s debounced send before reconcile's 2s-grace could catch it.

Also removed:
- The v6.1.4 `applySyncedState` retry enforcer loop (250ms ticks for 8s). Redundant now that `commandGuard` holds for 2.5s + reconcile catches any residual mismatch.

Net change: state transitions during sync are now determined by the commands we've executed, not by wall-clock timers. User clicks outside the ~2.5s sync guard propagate through debounce as normal.

---

# v6.1.4

### Make the reconcile loop an actual rectifier + longer initial enforcement

Users joined with the server paused at 441.4 and the receiver's video ended up playing at 442+ for ~50 seconds until someone manually interacted. Two compounding bugs:

**1. Initial enforcer gave up before CR's autoplay started.**

CR's autoplay-to-continue-watching fires 3–4 seconds after the player is ready. v6.1.2's `applySyncedState` enforcer ran for 3 seconds, stopping right as CR's autoplay kicked in. Extended to 8s. After 8s, if the site still won't honor the server state, accept actual and update the server (so other clients converge to the truth).

**2. Reconcile was returning early on persistent state mismatch.**

```js
if (actual !== expectedPlayState && expectedPlayState) return;
```

Ported straight from v4.1.0 with the rationale "don't fight the debounced event handlers". Problem: event handlers only fire on state *transitions*. CR's autoplay `play` event fired during the 5s settling window and was dropped by `isSettling()` returning true; no more events, no update, reconcile exits early forever.

New reconcile behavior:
- Track when the mismatch started (`_mismatchSince`).
- First 2s: grace period — let debounced event handlers fire and propagate. No action.
- 2–10s: enforce the server state — call `bitmovinAdapter.pause()` or `.play()` every reconcile tick (500ms).
- After 10s of failed enforcement: accept actual state, update the server, clear.

Net result: any divergence (autoplay, page JS calling play(), user bypassing extension, etc.) gets rectified within 2s under normal conditions, 10s worst case.

---

# v6.1.3

### Fix Bitmovin commands silently dropped across ISOLATED↔MAIN worlds

v6.1.2 added `applySyncedState` re-enforcement and the reconcile loop's hard-seek drift correction — both rely on `bitmovinAdapter.seek()` to actually land on the Bitmovin player. In Firefox MV3, the adapter's `CustomEvent` with a `detail` payload dispatched from the ISOLATED content-script world gets xray-wrapped when crossing into the MAIN page world. The page-world script receives the event but can't read `evt.detail` through the wrapper, so every command was silently discarded.

Symptom: receivers joining mid-playback landed on CR's continue-watching position (e.g. 630), reconcile logged `HARD SEEK drift=550s` twice, neither took effect, then `giving up, accepting site pos=644` and the room drifted to whatever CR wanted to play.

- **Switch both directions to `window.postMessage`**. Structured clone crosses worlds cleanly in both directions on Firefox and Chrome.
- Added `[byob-bm]` logs in the page-world script on every command received / dispatched, so the next failure mode is diagnosable from the server log via `debug:log` passthrough.
- MAIN→ISOLATED direction (bitmovin events) was actually fine with CustomEvent in this case (the "ready" and event payloads were coming through) — but switched for symmetry.

---

# v6.1.2

### Fix initial-sync race with Crunchyroll autoplay

Clients joining a room mid-playback landed at CR's continue-watching position (e.g. 588) instead of the room's position (e.g. 111.4). Two causes:

1. **Bitmovin adapter emitted `ready` too early.** As soon as `.bitmovinplayer-container.player` existed on the page, we signaled ready — but the source wasn't loaded yet (`duration=0`). The content script then issued `seek`/`pause` that the unloaded player silently discarded, and CR's subsequent autoplay loaded the continue-watching position unopposed.

   `crunchyroll-bitmovin-page.js` now waits for `getDuration() > 0` before emitting `ready`. Listens for `sourceloaded` / `ready` / `timechanged` events and also polls every 250ms as a fallback.

2. **Single-shot apply in `command:synced`.** One `seek + pause/play` call on the first tick, no re-enforcement. CR's autoplay fires immediately after, putting the video back in the "playing at 588" state.

   New `applySyncedState` helper re-applies the seek + play/pause state every 250ms for up to 3 seconds, clearing once actual state matches expected and position is within 2s of target. Similar in spirit to v4.x's `pauseEnforcer`, but covers both pause-and-play enforcement and position convergence.

Also made the `command:synced` payload authoritative — `expectedPlayState` is now always overwritten from the message, not only on first sync. Fixes the case where a stale client-side `expectedPlayState` survives across re-syncs.

---

# v6.1.1

### Ready-count tooltip: count unique users, not raw tab entries

`has_tab` and `ready` were using `map_size(open_tabs)` / `map_size(ready_tabs)`. The maps are keyed by tab_id with `ext_user_id` as the value, and a single user has multiple tabs (top frame + player iframe + possibly more). So with `total = 2` non-extension users and one of them having 2 tabs open, `has_tab = min(2, 2) = 2` — making the tooltip say "1 needs to click play" when it should say "1 needs to open window".

- Introduced `count_tab_owners/4` in `room_server.ex`. Resolves each owner back to a username via `state.users` and counts unique usernames. Also filters out owners that aren't currently connected, so stale entries from disconnects that haven't been cleaned up yet don't inflate the count.
- Applied the same logic in `extension_channel.ex`'s `sync_state_payload/1` for the initial join payload.

Stale-entry cleanup paths that already existed:
- `RoomServer.leave/2` drops `open_tabs`/`ready_tabs` entries owned by the leaving user_id.
- `handle_call({:join, ...})` drops stale same-username disconnected users and their tab entries on extension reconnect.
- Extension SW's `socket.onClose` proactively pushes `video:tab_closed` + `video:unready` for every known port before the channel dies.

The new `connected_ids` filter in the count is the belt-and-suspenders that keeps the display correct during the ~60s window between an abrupt disconnect and Phoenix's heartbeat-timeout-driven `terminate`.

---

# v6.1.0

### Reconcile-only sync engine + NTP clock + drift correction across all sites

v6.0.0 proved Bitmovin's API handles CR's MSE transitions cleanly. With that
root-cause fix in place, the entire pile of receiver-side DRM workarounds
that accumulated through v5.0.4–v5.0.31 was redundant. Stage 2 rips them
out and ports the v4.1.0 reconcile architecture on top of the Bitmovin
adapter — with drift correction enabled for every site, not just non-DRM.

**Sync engine (content.js) rewritten:**

- **Reconcile loop (500ms tick)** with three bands: <250ms dead zone
  (playbackRate = 1.0), medium drift (proportional 0.9–1.1x rate adjust),
  large drift ≥5s (hard seek). Hard seek routes through `bitmovinAdapter`
  when available (safe on CR), otherwise `<video>.currentTime=` (may fight
  some DRM sites; v4.x's "give up after 2 failures" fallback accepts the
  site's position and updates the server instead).
- **Send-on-change event handlers**: `onVideoPlay` / `onVideoPause` only
  send if local state actually differs from `expectedPlayState`, and only
  after a 500ms debounce. Rapid site-internal toggles (DRM, buffering,
  player init) no longer relay to the server.
- **Adaptive `commandGuard`**: after executing a server command, suppress
  outgoing events until the video state matches what we commanded, 300ms
  min / 5s max. Replaces the v5.x generation-counter `suppress()` system.
- **5s settling gate** on sync — read-only mode so the join sequence
  doesn't disrupt already-playing clients.
- **Stale-command detection** via `server_time` — commands older than our
  current `serverRef.serverTime` are ignored (except periodic corrections).

**Clock sync (background.js):**

- NTP-style 5-ping burst on channel join, median-RTT sample used as
  `clockOffset`. Maintenance tick every 30s while connected. Broadcast as
  `byob:clock-sync` to all content scripts. Reconcile refuses to
  drift-correct until clock is synced.

**Server integration:**

- Background now forwards `server_time` from `sync:play/pause/seek/correction`
  through to content scripts, and requests it in `sync:request_state` for
  `command:synced`. The server already produced these; we just pass them
  through.
- `video:request-sync` simplified — server response flows straight into a
  single `command:synced` instead of the v5.x `CMD:play|pause → CMD:synced`
  two-step. The receiving content script does the seek + play/pause itself.

**Deleted:**

- `extension/content_runtime.js` — DRM command sequencer + outbound play
  coordinator + `applyPauseAtPosition` + `queuePlayUntilReady`. All
  obsolete now that Bitmovin handles CR and reconcile handles everything
  else.
- `extension/tests/content_runtime.test.js`.
- From content.js: all stall detection/recovery (`_lastTickPosition`,
  `_stallTickCount`, `_stallRecoveryAttempts`, `tryStallRecovery`,
  `exitStallRecovery`, progressive silent-kick recovery, `_stallRecovery`
  gesture prompt); `suppress()` / `shouldSuppress()` / suppression gen
  counter; `markProgrammaticSeek` / `isProgrammaticSeekActive` /
  `_programmaticSeek`; `deferStall` / `_deferStallUntil` /
  `_queuedPlayRecoveryTimer` / `armQueuedPlayRecovery`; `_recentDrmSeekTarget`
  / `_recentDrmSeekAt`; `_isDrmSite` detection + branches;
  `pauseEnforcer`; `followerMode` / `followerStableTicks`; `_pendingSeekPos`
  / `_lastCorrectionSeek`; `_endedReported` per-instance flag.

**Net change:** content.js down from ~1500 to ~1100 lines. The sync engine
is simpler, more predictable, and drift correction now runs uniformly on
every site instead of being disabled on DRM to avoid wedges that don't
exist anymore.

---

# v6.0.0

### Crunchyroll: call Bitmovin's JS API instead of fighting `<video>.currentTime=`

Receivers on Crunchyroll wedged on every big seek-while-playing. Every fix from v5.0.4 through v5.0.31 (pre-seek, wait-for-seeked, queued-play-until-ready, progressive stall kicks, DRM sequencer) was working around the same root cause: setting `currentTime` on a playing MSE stream hands MSE an operation it can't complete cleanly, and the pipeline reports `playing=true` with frozen frames for many seconds. The architectural fix is to stop poking the underlying `<video>` element entirely and drive Crunchyroll's actual player engine via its own API — inject a page-world shim, call the vendor's player methods.

Recon in Crunchyroll's player iframe confirmed:

```js
document.querySelector('.bitmovinplayer-container').player  // Bitmovin v8 Player
// exposes seek, play, pause, isPlaying, isPaused, isStalled, getBufferedRanges,
// on, off, getCurrentTime, getDuration, etc.
```

Verified manually that `p.seek(p.getCurrentTime() + 300)` while playing completes cleanly and playback resumes at normal rate within 1 second — no wedge, no stall, no recovery needed.

- **New page-world content script `extension/sites/crunchyroll-bitmovin-page.js`** runs on `*.crunchyroll.com` via MV3 `world: "MAIN"`, polls for `.bitmovinplayer-container.player`, and bridges it to the isolated content-script world with `CustomEvent`s (`byob-bm:cmd` / `byob-bm:evt` / `byob-bm:ack`).
- **`content.js` gains a `bitmovinAdapter`** that exposes `seek/play/pause` through the bridge. Receiver `CMD:play/pause/seek` handlers route through Bitmovin when the adapter is ready; otherwise fall through to the existing `<video>` path for non-CR / pre-ready cases.
- **Sender-side DOM event handlers** are unchanged — Bitmovin's internal `p.seek()` still fires `pause/seek/seeked/play` on the `<video>`, which the existing defer-play coordinator handles correctly (test confirmed: `onVideoPause SEND → onVideoSeeking → onVideoPlay DEFER → onVideoSeeked SEND → Deferred play release → onVideoPlay SEND`).
- **Firefox moved to MV3** (`manifest_version: 3`, `host_permissions`, `strict_min_version: 128` for `world: "MAIN"` support). Chrome already MV3.
- **What's not touched (yet)**: stall recovery, DRM command sequencer, queued-play coordinator, pre-seek tracker, `_recentDrmSeekTarget`, markProgrammaticSeek windows. All still run; they become no-ops once Bitmovin handles the transitions. Stage 2 will delete them and port v4.x's reconcile-only architecture.

Stage 1 of the v6 rewrite. Stage 2 is the reconcile-only refactor + drift correction + cleanup.

---

# v5.0.31

### Recover faster when a queued DRM `play` times out but still comes up frozen

v5.0.30 put post-seek `play` behind the correct ready gate, but some Crunchyroll seeks still came out of the timeout release path into a visibly frozen "playing at the target" state. The generic stall detector eventually nudged them forward, but only after several flat state ticks.

- **Queued DRM plays now report whether they were released by readiness or by `ready-timeout`.**
- **Receivers arm a short one-off recovery watchdog after a `ready-timeout` release** so a play that stays pinned at the target can trigger the existing silent-kick recovery almost immediately.
- Added a regression test covering the timeout release reason.

# v5.0.30

### Keep post-seek DRM `play` on the full ready gate, not the short seek timer

v5.0.29 correctly routed a receiver's matching `play` into a queued DRM path after a remote `seek`, but that case still reused the short "wait for seek" timeout. When the seek had already been applied before `play` arrived, the receiver released too early and could wedge at the target instead of waiting for the site to become ready.

- **Receivers now have a dedicated DRM queued-play path for "already sought, now wait until ready".**
- **Matching `CMD:play` after a recent DRM `CMD:seek` now uses the full ready-gated release flow** instead of the short seek timeout.
- Added a regression test covering the "already at target, still wait for readiness" case.

# v5.0.29

### Keep `play` behind the DRM ready gate immediately after a remote seek

v5.0.28 fixed sender-side seek suppression, but the receiver still had a gap after successful ordered `seek -> play`: once a paused receiver had already applied `CMD:seek`, the following `CMD:play` saw no position delta and bypassed the queued DRM ready-wait path, calling `.play()` immediately and freezing at the target.

- **Receivers now remember a recent DRM `CMD:seek` target** for a short window.
- **A matching `CMD:play` is forced through the queued ready-wait path** even when `currentTime` already equals the target.
- Added a regression test for the forced queued-play case.

# v5.0.28

### Let real user scrubs escape the stale programmatic-seek window

v5.0.27 fixed the deferred outbound `play` timing, but a new edge case remained: if a synced `CMD:pause` had just aligned the sender, the sender's next real scrub could still inherit the old programmatic-seek suppression window. That caused `onVideoSeeking` / `onVideoSeeked` to be swallowed locally, so the room saw `play` without the matching `seek`.

- **A real user-triggered deferred DRM play now clears the old programmatic-seek window** before the subsequent scrub events fire.
- This allows the following `seeking/seeked` pair to propagate as a real outbound `video:seek`.

# v5.0.27

### Keep deferred DRM `play` queued once a real seek starts

v5.0.26 fixed the sender path in principle, but the short fallback timer was still too aggressive for large buffered Crunchyroll scrubs. In those cases the sender emitted `onVideoPlay DEFER`, then `onVideoSeeking`, but the 200ms timeout still fired before `seeked`, so the server again saw `play` before `seek`.

- **Deferred outbound DRM plays now switch to a longer seek-wait window once `seeking` fires.**
- **Plain play/pause still uses the short timeout** when no seek follows.
- Added a regression test covering the `play -> seeking -> delayed seeked` path.

# v5.0.26

### Defer outbound DRM `play` until `seeked` so buffered scrubs stay ordered

The remaining Crunchyroll failures were no longer coming from the receiver alone. During some large scrubs, the sender still emitted `play` before `seek`, which forced the receiver to guess whether it should hold or release playback while buffering the new segment. That guess still failed intermittently on long seeks that needed fresh media fetches.

- **DRM senders now briefly defer outbound `video:play` events** instead of sending them immediately.
- **When the local `seeked` arrives, the sender flushes the deferred play after sending `video:seek`,** so the server sees the stable `seek -> play` order even when the site fires `play` first.
- **If no seek follows, the deferred play still releases after a short timeout,** so ordinary pause/resume behavior stays immediate enough.

# v5.0.25

### Restore `CMD:pause` ordering to the last known-good sync path

The current Crunchyroll regressions pointed back to a behavioral drift from the old `v3.6.x` sync engine: receivers were applying paused-room alignment as `pause -> seek`, while the older working code used `seek -> pause` for actively playing videos. That ordering change appears to leave Crunchyroll in a bad state where the next play reports `playing=true` but never actually advances frames.

- **`CMD:pause` now restores the old working order for active videos:** seek first, then pause.
- **Already-paused receivers still align to the room position,** so the paused-room sync fix from v5.0.24 is preserved.
- Added a regression test for the restored pause ordering in `content_runtime`.

# v5.0.24

### Restore pause-and-seek behavior for paused-room sync

v5.0.23 improved queued DRM play release timing, but a regression in `CMD:pause` meant paused-room sync no longer aligned receivers to the room position. The service worker still sends only `CMD:pause` for paused rooms, so receivers that were paused at the wrong local position could stay there and drift into bad follower-mode state.

- **`CMD:pause` now pauses and aligns to the target position again.**
- **Already-paused receivers still seek to the room position** instead of no-oping.
- Kept the DRM queued-play readiness gate from v5.0.23 unchanged.

# v5.0.23

### Gate queued DRM play on actual readiness instead of a fixed delay

v5.0.22 fixed the `CMD:play -> CMD:seek` ordering problem on Crunchyroll, but some large remote seeks still wedged because receivers were releasing `.play()` after a fixed short delay even when the MSE pipeline had not buffered the target position yet.

- **Queued DRM plays now wait for readiness, not just time.** After a matched `CMD:seek`, the receiver polls for a ready-to-play condition before releasing `.play()`.
- **Long fallback timeout:** if Crunchyroll never exposes a ready state, the queued play still releases after a longer timeout instead of hanging forever.
- **Longer DRM programmatic-seek suppression:** delayed Crunchyroll `seeked` events are suppressed for longer so they do not leak back out as fake user seeks.

# v5.0.22

### Queue out-of-order DRM plays until the matching seek lands

Crunchyroll's scrubber emits `pause -> play -> seeking/seeked`, so receivers can observe `CMD:play` before the matching `CMD:seek`. v5.0.21 tried to pre-seek inside `CMD:play`, but large seeks still hit the 2s timeout and called `.play()` before the target segment was ready, wedging the receiver's MSE pipeline.

- **New DRM queued-play sequencer:** on DRM hosts, a paused receiver now holds an out-of-order `CMD:play` briefly when it targets a materially different position.
- **Matching `CMD:seek` consumes the queued play:** the receiver applies `currentTime = target` while still paused, waits a short settle window, then calls `.play()`.
- **Timeout fallback preserved:** if no matching seek arrives, the queued play releases normally so plain pause/resume still works.
- **Non-DRM sites are unchanged.**

Added a small Node regression harness for the extension command sequencer and an ExUnit safety test that backend `sync_play` and `sync_seek` broadcasts remain separate.

---

# v5.0.21

### Wait for `seeked` before `.play()` in pre-seek path + no-op trailing CMD:seek

v5.0.20's pre-seek in `CMD:play` helped for short seeks but still wedged on large ones. Observed in logs:

```
27.050 CMD:play pre-seek from 653.25 to 315.5
27.052 onVideoPlay SUPPRESSED (gen) pos= 315.5        ← .play() fires immediately
27.053 onVideoSeeking SKIP (programmatic) pos= 315.5
27.078 onVideoSeeking SKIP (programmatic) pos= 634.64 ← MSE reverts to old position
27.106 CMD:seek pos= 315.5 videoPaused=false videoPos=634.64 → currentTime=315.5 on playing → wedge
```

Calling `.play()` immediately after `currentTime=` on Crunchyroll's MSE makes the pipeline abort the seek mid-fetch and revert to the last buffered position (observed: 315.5 "unwound" to 634.64 within 25ms). The trailing `CMD:seek` then sees a playing stream at the wrong position and re-issues the seek on a **playing** pipeline, which is the wedge condition.

- **Wait for `seeked` event (with 2s timeout fallback) before `.play()` in the pre-seek path.** This lets MSE commit the new segment before playback starts instead of racing `.play()` against the seek fetch.
- **New `_preSeekTarget` tracker**: `CMD:seek` no-ops if its target matches a recent (<3s) pre-seek target. MSE may briefly report a stale/reverted `currentTime` while the seek finishes — we trust our intent over the getter.
- Extended `markProgrammaticSeek()` window to 3s for the pre-seek path so the MSE-generated `seeking` event at the "reverted" position gets suppressed.

---

# v5.0.20

### Fix seek-while-playing on Crunchyroll — pre-seek in `CMD:play` for out-of-order events

v5.0.19 handled the standard HTML5 scrubbing sequence (`pause → seek → play`), but Crunchyroll's scrubber fires events in a different order:

```
onVideoPause SEND pos= 703.997324
onVideoPlay SEND pos= 257.25      ← play fires before seeked
onVideoSeeking pos= 257.25
onVideoSeeked SEND pos= 257.25
```

CR's UI does something like `video.pause(); video.play(); video.currentTime = X` synchronously, so the events fire in that order. The server broadcasts in that order, and receivers apply `CMD:pause → CMD:play → CMD:seek`. That means `.play()` starts MSE at the stale position (703), then `currentTime = 257.25` hits a **playing** MSE pipeline — classic wedge. The receiver stalls at 257.25 with `playing=true` and no frame advancement.

- **`CMD:play`**: if paused and target position differs by >0.5s, set `currentTime = pos` before calling `.play()`. Seeking on a paused decoder is safe, and the trailing `CMD:seek` becomes a no-op.
- Still a no-op if already playing — don't touch `currentTime` on a playing MSE stream.
- Standard HTML5 event order (`pause → seeked → play`) still works identically: by the time `CMD:play` lands, `CMD:seek` has already put us at the right position, so the pre-seek threshold check skips.

Verified against v5.0.19 log showing the wedge pattern and progressive stall-recovery kicks failing to un-wedge a 447-second seek gap.

---

# v5.0.19

### Strip DRM pause debounce + postSeek suppression — forward events directly

Observed failure in v5.0.18: seek-while-playing on Crunchyroll sent only `video:seek` to the server. Event trace:

```
onVideoPause DEBOUNCE pos=763.52
onVideoSeeking DRM suppress set, cancelledPause=true pos=571.75
onVideoPlay SUPPRESSED (postSeek) pos=571.75
onVideoSeeked SEND pos=571.75
```

The browser emits a natural `pause → seek → play` sequence when the user scrubs. Our pause was 300ms-debounced, `onVideoSeeking` cancelled the debounce, and `_postSeekSuppressUntil` ate the subsequent `play`. Receivers got `CMD:seek` on a playing video and wedged MSE.

The simpler model: none of this. It listens to `play`, `pause`, `timeupdate`, `durationchange`, `ended` — and forwards each `play`/`pause` immediately. Commands map 1:1 to player ops: `play → .play()`, `pause → .pause()`, `seek → currentTime=`. No pause-seek-play dances, no kick seeks, no debounces.

- **`onVideoPause`**: removed 300ms DRM debounce and `_postSeekSuppressUntil` gate. Fires immediately.
- **`onVideoPlay`**: removed `_postSeekSuppressUntil` gate.
- **`onVideoSeeking`**: removed `_postSeekSuppressUntil` set and pause-timer cancel. Now a pure log.
- **`CMD:play`**: if paused, `.play()`. If already playing, no-op. No `currentTime=`, no kick.
- **`CMD:pause`**: if playing, `.pause()`. If already paused, no-op. No `currentTime=`, no enforcer loop.
- **`CMD:seek`**: `currentTime = pos`. No pause-seek-play.
- **Removed `drmSafeSeek`** entirely. The natural event sequence from the sender already produces the pause-seek-play pattern on receivers.
- Kept: generation-counter `suppress()` for echo prevention on programmatic play/pause, `markProgrammaticSeek()` time-window for seeking/seeked echo, `deferStall()` to skip stall recovery during legitimate buffering.

---

# v5.0.18

### Remove kick seeks — minimal-intervention sync

The minimal Crunchyroll handler is literally one line:
```js
if (msg.play && player.paused === true) player.play();
```
No `currentTime=` pre-assignment, no kick seek, no pause-seek-play dance. And it works 100% of the time.

Every kick seek I'd added was fighting MSE. Empirical proof from the last test: after `CMD:play` + `.then()` kick to `274.76`, the video position stayed at `274.75` **forever**. The kick went through but MSE refused to advance frames.

- **`CMD:play`: removed the post-play kick seek.** Also no longer re-assigns `currentTime` when already at target (within 0.1s) — matches "just call `play()`" approach.
- **`drmSafeSeek` paused-path: removed kick seek after `play()`.**
- **`drmSafeSeek` playing-path (pause-seek-resume): removed kick seek after resume's `play()`.**
- Kept stall detection + progressive-kick recovery as a safety net for natural wedges, but we no longer provoke MSE with kicks during normal flow.

---

# v5.0.17

### Fix stall detector racing against MSE's natural buffering

After a big seek on DRM, MSE takes 2–3 seconds to fetch the new segment. During that window the video reports `paused=false` and `currentTime=target` with no advancement — **exactly the stall signature**. The stall detector was firing mid-fetch and kicking the playhead forward, which MSE then had to undo when `play()` finally resolved and ran its own kick seek. Result: the playhead bounces around, MSE re-fetches multiple times, and the video ends up desynced or stuck.

Observed in logs: `CMD:play` called at T → stall detector fires kick at T+2s → `play()` resolves at T+2.5s and kicks backwards, putting MSE in a worse state than if we'd left it alone.

- **`deferStall(ms = 3000)` helper** sets a window during which the stall detector skips its check. Allows MSE to finish buffering/seeking without our interference.
- Called at the entry of `CMD:play`, `CMD:pause`, `CMD:seek`, and `drmSafeSeek`. Also called inside the resume path and the kick-seek `.then()` to cover the post-resolve operations.
- Stall detector now gates on `Date.now() >= _deferStallUntil`. Real stalls (pipeline wedged long after any programmatic action) still get caught.

---

# v5.0.16

### Fix stall recovery counter resetting after each kick

v5.0.15's "only reset the counter on normal advancement" logic had a hole: the attempt-1 kick is `+0.5s`, which matches normal-rate advancement (~0.5s per 500ms tick at 1x). The kick itself looked like one healthy playback tick, so `_stallRecoveryAttempts` reset to 0 every time, and the counter never reached attempt 2 or 3. Stalls repeated indefinitely with `attempt 1 delta= 0.5`.

- **Require 3 consecutive clean ticks** before resetting the attempt counter. A single healthy-looking tick after a kick is insufficient — the kick itself produces a 0.5s delta, and a briefly-unstuck pipeline that re-stalls would only produce one normal tick.
- Added `_cleanPlayTicks` counter; cleared whenever delta is out-of-range or a stall tick is detected.

---

# v5.0.15

### Fix stall recovery never escalating — progressively larger kicks

Stall recovery kicks of 0.2s weren't un-wedging Crunchyroll because the kick stayed within the already-buffered (stuck) MSE range, so MSE didn't refetch any segments. User manual seeks work because they're typically 1s+ and cross segment boundaries.

On top of that, the 0.2s kick itself moved the position past the 0.05 "stall" threshold, so `_stallRecoveryAttempts` was reset to 0 — next stall fired as "attempt 1" again forever. The counter never reached the give-up limit, and the kick size never grew.

- **Progressive kick sizes:** attempt 1 = 0.5s, attempt 2 = 1.5s, attempt 3 = 3.0s. Larger kicks force MSE to cross a segment boundary and refetch.
- **Only reset `_stallRecoveryAttempts` on normal playback advancement** (0.3–0.7s per 500ms tick ≈ 1x rate). Kick-seek-induced position changes no longer confuse the counter.

---

# v5.0.14

### Fix: joining a paused room would start playing against room state

On join to a paused room, the SW sent `CMD:seek` then `CMD:pause` back-to-back. If the user had just clicked play (to start their Crunchyroll tab), the video was playing at that moment, so `CMD:seek`'s DRM branch called `drmSafeSeek(pos, shouldPlay=true)` — which pauses, seeks, then **resumes playing**, ignoring the subsequent `CMD:pause` (which no-op'd because `drmSafeSeek` had the video momentarily paused mid-operation). Result: host's video plays while room state is paused; observers see stale paused state; divergence persists until host manually pauses.

- **SW sends just `CMD:pause` for paused rooms.** The pause handler already seeks to the target position, so the extra `CMD:seek` was redundant and actively harmful.
- **`CMD:pause` now pauses first, then seeks.** Setting `currentTime` on a playing DRM pipeline is the main MSE-wedge trigger — pausing first lets the seek land on a paused decoder.

---

# v5.0.13

### Fix extension on LAN access: use `window.location.origin` for server URL

The "Open Player Window" button was passing `ByobWeb.Endpoint.url()` (server-rendered) as the extension's `server_url`. In dev that's `http://localhost:4000` regardless of how the browser reached the server, so LAN-access clients would store `server_url=http://localhost:4000` and the extension's WebSocket would try to hit `ws://localhost:4000/extension` on the client machine — nothing there, connection silently fails, no `CONNECTED TO ByobWeb.ExtensionSocket` in logs.

- **Use `window.location.origin` in the `ExtOpenBtn` hook** so the extension connects back to whatever host the user used to reach byob (LAN IP, tunnel URL, production hostname). Works for localhost, LAN, HTTPS deploys.

This also explains why the "stuck on Syncing..." fallback added in v5.0.12 didn't fire — the extension socket was never connecting, so `requestSync()` wasn't being called in the first place on the affected client.

---

# v5.0.12

### Fix sync bar stuck on "Syncing..." forever

`command:synced` is sent by the service worker 500ms after the server replies to `sync:request_state`. If that message is lost (MV3 SW goes to sleep before the timeout, `tabId` mismatch between port and `broadcastToTab`, or a missing handler), the sync bar stays on "Syncing..." with no recovery. Additionally, the previous `command:synced` handler only updated the status when `hookedVideo` was set, so a top frame whose video lives in an iframe silently stayed stuck.

- **5-second fallback in `requestSync()`:** if `command:synced` hasn't arrived, force `synced = true`, enter follower mode, and transition the sync bar out of "Syncing...". Logs "command:synced never arrived" so the root cause is still visible in the debug stream.
- **`command:synced` updates status unconditionally** — defaults to "playing" if `hookedVideo` is null (video in iframe). The subsequent `byob:bar-update` from the iframe corrects to the real state.
- Cleared the fallback timer when `command:synced` does arrive.

---

# v5.0.11

### Fix kick seek aborting `play()` — "UI says playing but video is paused"

Setting `currentTime` on a video synchronously after `play()` (but before the play promise resolves) triggers `AbortError: fetching process aborted`. The play promise rejects, video stays paused, but the server already got our `onVideoPlay` event and broadcast `sync:play` — so byob UI says playing while the actual player is paused. Matching symptom: "doesn't ACTUALLY PLAY until I seek" after a pause/play cycle.

- **Kick seek moved inside `play().then()`** for both `CMD:play` and both `drmSafeSeek` branches. Now it only runs after `play()` resolves and only if the video actually started playing. Prevents the AbortError race.
- Still re-marks `markProgrammaticSeek()` around the kick so its `seeked` event doesn't echo out.

---

# v5.0.10

### Fix DRM wedge after large initial-sync seek

When a user joins a Crunchyroll room and their tab was at a different position (e.g. Crunchyroll resumed at 327s from last watch, but room is at 4s), `drmSafeSeek` pauses → seeks → resumes → but MSE can end up with `playing=true` and frames stuck at the target position. Old CMD:play had a "kick seek" (`currentTime = target + 0.01`) right after `play()` that forced MSE to refetch; v5.0.8 dropped it. This restores it inside `drmSafeSeek`.

- **Kick seek in `drmSafeSeek` resume path** — immediately after `play()`, set `currentTime = targetPos + 0.01` to restart MSE frame rendering. Applied to both the paused-then-play and playing-then-pause-seek-play branches.
- **DRM stall detection re-enabled with silent kick recovery.** If a wedge still happens (frames don't advance despite `playing=true`), silently seek `currentTime + 0.2` — no user prompt, no toast. Up to 3 attempts then gives up. Replaces the old annoying "click play to resync" gesture prompt that users reported as broken UX.
- **Re-mark programmatic-seek window** after the kick to ensure the kick's own `seeked` event doesn't echo out as a `video:seek`.

---

# v5.0.9

### Fix echo cascade: play/pause/seek no longer bounces between clients

The root cause of "play/pause only affects one tab" and the visible pause→seek→play flip-flops: every programmatic `currentTime = X` assignment on Crunchyroll fires a `seeked` event, and the single-gen `suppress(null)` was getting consumed by the (separately-suppressed) `play` event before the seeked arrived. The `video:seek` echoed back to the server and cascaded into `drmSafeSeek` pause-seek-play on every other client.

- **New `markProgrammaticSeek()` / `isProgrammaticSeekActive()`:** time-based window that absorbs `seeking`/`seeked` events independently of the single-gen play/pause suppression. Robust against event ordering (play may fire before seeked).
- **Replaced `suppress(null)` with `markProgrammaticSeek()`** in `CMD:play`, `CMD:pause`, `CMD:seek`, `drmSafeSeek`, `tryStallRecovery`, and the drift correction hard seek.
- **No-op early returns** in `CMD:play`, `CMD:pause`, `CMD:seek` when state+position already match (|Δpos| < 0.1s). Prevents the self-echo from the server's broadcast-to-all behaviour from re-running the seek+play pipeline on the originating tab.
- **`drmSafeSeek` early return for same-position seeks.** The CMD:play kick seek was previously cascading here and pausing both tabs for a no-op seek, producing the user-visible "my video paused briefly when I clicked play" flip-flop.
- **`CMD:pause` now also sets `markProgrammaticSeek`.** Previously it was missing seek suppression entirely, so the `currentTime = pos` assignment during a pause command on DRM echoed as `video:seek` → cascaded.

---

# v5.0.8

### DRM: pause-seek-play pattern for remote commands (fixes Crunchyroll wedges)

- **`drmSafeSeek` helper** added. Setting `currentTime` on a *playing* Crunchyroll stream wedges MSE — the video reports `paused=false` but frames stop. Pausing first flushes the decoder so the seek lands cleanly; we listen for `seeked` and resume.
- **`CMD:seek` on DRM while playing** now routes through `drmSafeSeek(pos, shouldPlay=true)`. Previously a bare `currentTime = pos` would strand the client at the new position, playing=true but stuck. Repro: one client seeks while another is actively playing → the receiver wedges indefinitely under v5.0.7 (stall detection was disabled on DRM).
- **`CMD:play` on DRM while playing with position delta > 0.1s** also uses `drmSafeSeek`. Fixes the scenario where one client seeks and emits `video:play` (because their video resumed after the seek), server rebroadcasts `CMD:play pos=X`, and other already-playing clients wedge when trying to jump to X.
- **Paused + seek path unchanged** — `currentTime =` on a paused DRM stream is safe and doesn't need the pause-seek-play dance.
- Resume has a 1s safety timer in case `seeked` never fires (seek cancellation, element unhook).

---

# v5.0.7

### DRM sites: minimal-intervention sync (minimal-intervention sync)

- **No auto drift correction on DRM.** `sync:correction` now returns early on DRM hosts (Crunchyroll, Netflix, Disney+, etc.) — no rate adjustment, no hard seek. The MSE pipeline wedges from any programmatic seek on a playing stream, and the resulting "click play to resync" loop was worse than the drift it was trying to fix. Drift accumulates silently; explicit user actions (play/pause/seek from another client) still propagate.
- **No stall detection on DRM.** Without our own auto-seeks wedging the pipeline, stalls shouldn't originate from us. The detector was also false-positiving on natural rebuffering and triggering the user-gesture prompt. Disabled on DRM; non-DRM sites still use it.
- **Rationale:** DRM playback handling has zero drift correction and zero stall handling, just direct `video.play/pause` and `currentTime =` assignment relayed from the room. Our aggressive clock-sync model is a net negative on DRM; this change adopts the same "don't fight the pipeline" approach.

---

# v5.0.6

- **Fix DRM stall recovery click loop:** On stall recovery, the user's click no longer re-seeks to the server's position (which just re-wedged the pipeline and caused another stall). Instead, the video resumes from its current position and we announce that position to the server. This breaks the click→stall→click→stall loop on Crunchyroll.
- **New `exitStallRecovery` path:** Both native player clicks and sync-bar play clicks route through the same exit — sets `synced=true`, clears stall flags, sends `video:play` with current position.

---

# v5.0.5

- **Fix DRM stall recovery loop:** `waitForNativePlay` was bypassing the gesture wait because a stalled video still reports `paused=false`. Now force-pause on DRM stall escalation so the gesture prompt actually waits for a real click. Stops the loop where stalled tabs would immediately flip back to `synced` and process incoming CMD:plays that couldn't un-wedge the pipeline.
- **Fix ready-count "0/0":** Hide the users badge when `total === 0` (no non-extension users to count).

---

# v5.0.4

### DRM sync improvements (Crunchyroll, etc.)

- **Stall detector:** New reconcile loop watches `currentTime` across 500ms ticks. When video reports `playing=true` but frames aren't advancing for 1.5s+, declares a stall and triggers recovery.
- **DRM stall → gesture prompt:** On DRM sites, skip programmatic pause→seek→play recovery (which doesn't un-wedge a stalled MSE pipeline). Show "Playback stuck — click play to resync" toast and `waitForNativePlay()`.
- **Non-DRM stall recovery:** Pause → seek to expected position → play sequence. Up to 3 attempts before escalating to gesture prompt.
- **No HARD SEEK on DRM:** Drift correction's hard-seek branch is skipped for DRM sites — it was just moving the stall target without un-wedging the pipeline. Rate adjustment (0.9–1.1x) still runs for normal drift.
- **Track expected position from corrections:** `_lastExpectedPos`/`_lastExpectedAt` fed by `sync:correction` messages, used as the seek target during stall recovery.

### Recovery escalation
- If `play()` rejects during recovery (common when MSE has aborted the fetch), escalate immediately to `needsGesture` — one user click re-requests state and resumes sync.

---

# v5.0.3

- **Drift summary:** Details for nerds shows avg/min/max drift across all extension clients.
- **Settings modal stays open:** PreserveModal hook keeps dialog open during live stat updates.
- **Details for nerds stays expanded:** PreserveDetails hook preserves open/closed state across re-renders.

---

# v5.0.2

- **Position-based ended detection:** Removed unreliable browser `ended` event listener. Video end detected via position check in time report (pos >= duration - 3s, duration > 60s, playing). More reliable on third-party sites.
- **Ready count fix:** Send `video:tab_closed` + `video:unready` for all ports before clearing channel on socket close. Fixes count staying at 2/2 after a user leaves.
- **Stale user cleanup:** Disconnected users with same username cleaned on rejoin (both extension and non-extension). Prevents gray circles in user list.

---

# v5.0.1

### Ready count
- **`video:ready` sent after stability**, not on first sync. Prevents premature 2/2.
- **Ready capped to `has_tab`** — can't be ready without an open tab.
- **Stale tab cleanup** — orphaned open_tabs/ready_tabs cleaned when extension users reconnect.
- **Total shows all users** — closing a video tab shows `1/2` not `1/1`.

### Drift correction
- **250ms tolerance** with proportional rate correction (0.9–1.1x).
- **1s correction interval** for tight sync.
- **Deterministic seek protection** — stale corrections ignored until server reflects user's seek position.
- **Correction hard seek max once per 5s** on sites that ignore `currentTime`.

### Sync stats panel
- **Per-client drift/state** computed server-side from `video:state` (works while paused).
- **Live updates** via PubSub — shows drift (color-coded), server position, play state.

### Sync bar
- **Debounced status** — brief DRM pauses don't flicker "Paused".
- **Bar updates only when synced** — unsynced clients don't flicker the seek bar.

---

# v5.0.0

**Revert to v3.6.3 sync engine + targeted improvements.**

The v4.x reconcile loop caused cascading issues on sites with DRM/buffering transitions. This release reverts to the proven v3.6.3 suppression-based sync engine and adds focused improvements.

### Drift correction
- **250ms drift tolerance** with proportional rate correction (0.9–1.1x). Hard seek for >3s drift.
- **1s correction interval** (was 5s) — server sends expected position every second for tight sync.
- **Follower mode:** Joining clients are read-only until stable (position+state match server for 3 consecutive ticks). Prevents join process from disrupting existing clients.

### Sync bar improvements
- **Debounced status display:** Brief DRM pauses don't flicker "Paused" — requires 2 consecutive paused updates.
- **Bar updates only when synced:** Unsynced clients don't send bar updates (prevents seek bar flickering).
- **Auto-play on join:** `command:play` tries `play()` even during `needsGesture` — if browser allows it, syncs immediately without manual click.

### Time-window suppression
- **Absorbs ALL matching events** for 1.5s instead of just the first. Sites with DRM/buffering fire multiple play/pause during transitions — all suppressed.

### Details for nerds
- **Per-client sync stats panel** in room settings: drift (ms, color-coded), server position, play state.
- Updates every 1s correction cycle.

### Backported from v4.x
- **innerHTML removed:** All `innerHTML` replaced with DOM creation methods (AMO compliance).
- **Persistence crash recovery:** `binary_to_term` wrapped in try/rescue; validates required fields.
- **Computed position on sync:** Returns `current_time + elapsed` for playing rooms.
- **Position-based ended detection:** Requires duration >60s and position >90%.
- **Video element replacement guard:** Resets `synced=false` on element swap.
- **Connection cooldown (3s):** Prevents reconnection storms.
- **Tab closing:** Extension tabs close on queue advance/end.


---

# v4.1.0

**Extension sync engine: NTP clock sync, reconcile loop, drift correction, buffering detection.**

### Reconcile loop
- **Single reconcile loop** (500ms tick) handles play/pause mismatch, buffering/stall detection, position drift, and paused position correction.
- **Debounced play/pause** (500ms): rapid site toggles (DRM, buffering transitions) cancel each other out. Only stable state changes reach the server.
- **State-change-only filter:** `onVideoPlay`/`onVideoPause` only send events that change `expectedPlayState`. Redundant confirmations from the site are silently dropped.
- **Paused position correction:** Both clients paused but different positions → hard seek to server position.
- **Playing drift correction:** Proportional playback rate (0.9–1.1x) for small drift, hard seek for >5s. Respects recent user seeks (no hard-seek for 5s after user action).

### Buffering detection
- **Stall-based detection:** If video position frozen for 1.5s (3 ticks), enters buffering state. Suppressed during settling (3s after join) and after seeks (5s buffer time).
- **Server pause on buffer:** Pauses server so other clients wait. `_bufferingPause` flag prevents the buffering client from fighting its own pause echo.
- **Buffer clear:** Resumes server from current position. Requires 3s of sustained playback before clearing.
- **Buffer timeout (10s):** Accepts site's actual position if stuck, seeks server to match.
- **Position-based ended detection:** Replaces browser `ended` event (unreliable on third-party sites). Checks `position >= duration - 3` with `duration > 60` guard.

### NTP clock sync
- **5-probe burst on connect**, median offset selection. 30s maintenance re-sync.
- **Synced clock for drift computation:** `serverMonotonic ≈ Date.now() + clockOffset`.
- **RTT reporting:** Each client reports RTT; room tolerance widens to 500ms if any client > 250ms.
- **Clock-sync gate:** Drift correction only runs after clock sync completes. Stall detection runs immediately.

### Server-authoritative model
- **Server timestamps on all commands:** play/pause/seek/correction include `server_time` (monotonic ms). Stale messages rejected.
- **Computed position on sync:** `sync:request_state` and join payload return `current_time + elapsed` for playing rooms.
- **Per-tab user ID:** `ext_user_id:tab_id` so two tabs in one browser are separate sync clients.
- **Adaptive command guard:** Holds until site settles (play state matches expected) for incoming server commands. Fixed guard for seeks.
- **3s settling period after sync:** Suppresses contradictory events during site initialization on join.

### Infrastructure
- **Connection cooldown (3s):** Prevents reconnection storms from cascading socket failures.
- **Delayed clock sync (2s):** NTP burst starts after connection stabilizes.
- **Persistence crash recovery:** Gracefully discards incompatible saved room data; validates required fields.
- **Debug logging:** `[byob]` logs in devtools + `[ext:debug]` in server terminal. Anonymized user IDs (SHA-256 8-char prefix).
- **Details for nerds panel** in room settings: sync tolerance, correction interval, per-client RTT.
- **Tab closing:** Extension tabs close when queue advances after autoplay countdown or queue ends.
- **innerHTML removed:** All `innerHTML` replaced with DOM creation methods (AMO validation).

### Known issues
- **Dual-tab same-browser:** Two tabs sharing one service worker (normal + incognito) can interfere during the second tab's join process. Needs "active player" tracking in the SW.
- **Seek-hostile sites:** Some streaming sites (e.g., aniwave) don't honor `currentTime` seeks, causing position mismatches that trigger cascading corrections.

---

# v4.0.1

- **Buffering overlay fix:** Overlay never appeared on third-party sites because the video runs in an iframe but the overlay only renders in the top frame. Added `byob:local-buffering` relay from iframe → service worker → top frame for instant overlay display.
- **Buffering field forwarded:** `background.js` was stripping the `buffering` field when relaying `video:state` to the server channel. Other clients never received buffering notifications.
- **Buffering clear messages:** `onVideoCanPlay` and `resolveCommandGuard` now immediately send `buffering: false` via port so the overlay clears promptly (was waiting up to 500ms for the next state report).

---

# v4.0.0

**Architecture overhaul: replace suppression/cooldowns with SW-level echo prevention + adaptive command guard.**

### Echo prevention
- **Service worker port filtering:** `broadcastExceptOrigin()` tracks which port originated each play/pause/seek and skips echoing the server response back to that port. Replaces all client-side suppression/cooldown logic.
- **Adaptive command guard:** After every play/pause/seek command, a 500ms guard blocks outgoing events. After 500ms, checks if video state matches expected state — if mismatched, enters buffering mode and keeps checking every 200ms until resolved.

### Buffering detection
- **State mismatch approach:** Buffering = "expected playing but video is actually paused." Detected by the adaptive command guard after commands, and by native `waiting`/`canplay` events for mid-stream buffering.
- **Cross-client overlay:** When one client buffers, a purple spinner overlay appears on all clients. Relayed via `sync:buffering` channel event.
- **Local buffering relay:** Iframe → service worker → top frame relay ensures overlay displays correctly on sites where video is in an iframe.

### State reconciliation
- **200ms reconciliation loop:** Continuously compares actual video state against expected play state. After 1s mismatch, attempts correction. If `play()` fails (autoplay policy), drops to gesture-required state.
- **Constants refactor:** All magic strings in content.js replaced with frozen constant objects (State, SyncStatus, Msg, El, Hosts, Color, Copy, Evt, Tag).

---

# v3.6.3

- **Extension sync fix:** Seek suppression used `suppress(null)` which swallowed ALL subsequent events (play/pause) after a seek. Now uses distinct `"seeked"` state so only seeked events are suppressed.
- **Extension pause enforcer fix:** Enforcer no longer calls `suppress()` on each tick, which was resetting suppression every 200ms and swallowing user play/pause events. Play cancels the enforcer immediately.
- Deduplicate activity log entries (same user+action within 2s is suppressed — fixes double "joined" from longpoll→websocket upgrade)
- Removed favicon from all header bars (root layout + room nav)

---

# v3.6.2

- Updated logo and favicon
- Removed favicon from header bar (text logo only)
- Fixed visibility change handler pushing `time` instead of `position` (caused crash on tab return from background)

---

# v3.6.1

**Bugfixes + embeddable filter.**

- **Auto-pause on empty room:** When all users disconnect (including non-clean exits like killing the browser), the room auto-pauses and freezes the position. No more video "playing" in the background GenServer with nobody watching.
- **Non-embeddable video filter:** YouTube Data API now requests the `status` part to check the `embeddable` flag. Non-embeddable videos are filtered during pool ingestion so they don't appear in roulette/voting.
- **Vimeo preview card:** URL bar now shows Vimeo preview (was only matching YouTube). Homepage and URL dropdown list Vimeo as a supported source.
- **Queue scroll fix:** Queue panel wrapper was missing flex layout classes, preventing overflow scroll.

---

# v3.6.0

**Extension sync overhaul, Vimeo support, debug logging.**

### Vimeo embed support
- **Vimeo player:** Paste a Vimeo URL and it embeds natively — play, pause, seek, sync, duration, thumbnails. Uses the Vimeo Player SDK. URL preview shows title, thumbnail, and duration in the search bar.
- **Vimeo oEmbed:** Server-side metadata fetch via `vimeo.com/api/oembed.json`. Query params stripped to avoid Vimeo API rejections.

### Extension sync overhaul
- **Autoplay gesture flow:** Third-party sites (Crunchyroll, Dailymotion, etc.) blocked programmatic `video.play()`. Extension now shows a purple "Play the video to start syncing" toast and waits for the user's natural play click. One-click flow, DRM-safe.
- **Sync bar controls:** Play/pause button, clickable progress bar with purple fill, time counter. Only visible after sync. "Finished — next in 5s" countdown on video end.
- **Ready count indicator:** Shows `ready/total` with person icon (gray → green). Per-tab tracking via explicit `video:tab_opened`/`video:tab_closed`/`video:ready` messages. Tooltip details: "1 of 2 ready · 1 needs to click play".
- **Page metadata scraping:** Extension scrapes title/thumbnail from external pages (Crunchyroll-specific selectors + generic OG fallback), updates queue/history items on byob.video.
- **Stability:** Auto-reconnect on Chrome MV3 service worker restart. Tab-scoped `command:synced` (iframe → top frame, not cross-tab). Stale extension user cleanup on rejoin. bfcache error suppression.
- **Extension user hidden:** Extension connections use real username and are filtered from the room user list and count.

### YouTube sync fixes
- **Stutter fix:** Joining a paused room used `cueVideoById` (thumbnail only); resuming caused load-from-scratch → buffering → echo loop. Now uses `loadVideoById` + immediate pause.
- **Suppression overhaul:** Time-window suppression auto-clears via setTimeout 200ms after terminal state (was stuck for 3s safety timeout). Player readiness gate (`_playerSettled`) set before suppression check so events aren't blocked during load. `checkAndRetry` stops once player settles.
- **Ended state:** Heartbeat no longer overrides `expectedPlayState` after video ended, preventing restart during autoplay countdown.

### Infrastructure
- **Debug logging:** New `Byob.SyncLog` module. Video URLs SHA-256 hashed (12-char prefix). Logs play/pause/seek/join/heartbeat. Extension channel events logged. Dev logger set to info level with timestamps.
- **HTML entity fix:** OEmbed title extraction decodes `&#039;`, `&amp;`, numeric entities.
- **Voting fix:** Votes broadcast immediately (removed throttle). Early-close excludes extension users. Roulette winner text hidden until animation completes; reveal delay increased to 8s.
- **Queue scroll fix:** Queue panel wrapper missing flex layout classes, preventing scroll.

---

# v3.5.1

**Roulette polish + sync hardening.**

- **Roulette:** 3-second "Loading candidates…" overlay at the start of a round so users see the panel mount and have time to scroll down. Slice text now runs radially (aligned with each pie slice, flipped on the left half so glyphs stay left-to-right) with two-line word-aware splitting — up to ~36 chars legible per slice. Voting picks **5** candidates; roulette stays at **12**. Server scrolls the round panel into view on `:round_started` when nothing is currently playing (no queue, ended, or fresh room).
- **Roulette physics:** `Byob.RoomServer.Round.simulate_landing_slice/2` ports the same exponential-decay formula the JS hook runs, and the server uses its result to pick the winner — whichever slice the physics lands on **is** the winner, rather than picking first and solving physics to match. Identical IEEE 754 arithmetic in Elixir and JS produces bit-identical slice indexes on both sides. Winner slice gets a yellow outline + glow pulse only after the ball fully settles; a pie-slice countdown (same visual as the autoplay one) runs until the server finalizes and enqueues.
- **Fix:** clicking **Play Now** on a new video while the previous video was in its autoplay countdown dropped the user onto the "Queue finished" screen five seconds later (the countdown timer fired and advanced past the just-added video). Now any `add_to_queue` that replaces the now-playing item cancels the pending advance + broadcasts `:autoplay_countdown_cancelled`.
- **Fix:** YouTube player states `-1` (unstarted) and `5` (cued) render as a static thumbnail but were returned as `null` from `getState()`. The reconciliation loop skips null-state checks, so a player stuck on the thumbnail never got force-played. Both states now map to `"paused"` — if the room's expected state is `"playing"`, the 500 ms mismatch gate kicks in and force-plays. Likely root cause of the reported "my friend was paused while I was playing" desync.
- **Fix:** if the YouTube player stays in `"buffering"` for more than 5 seconds while expected state is `"playing"`, seek to the server's expected position and force-play. Prevents infinite-buffer stalls from blocking sync.
- **Fix:** on tab becoming visible again after backgrounding, resync the clock (3 fresh probes) and echo current local state (`video:play` / `video:pause`) back to the server. Prevents throttled-timer-induced desync in backgrounded tabs.
- **Video help:** first time a browser blocks autoplay and the "Click to join playback" overlay shows, we now also open a one-time help dialog with browser-specific instructions (Chrome/Edge/Firefox/Safari) for enabling autoplay on byob.video. "Don't show again" defaults to checked, persisted in `localStorage`.
- **Comments layout:** `min-h-[220px]` on mobile, flex-fill on desktop (removed the `lg:min-h-[260px]` that was overflowing the main column and breaking the sidebar's sticky scroll).
- **Ops:** `YOUTUBE_API_KEY` is now read in all envs (was prod-only) so dev can populate the pool. Test suite writes to a dedicated `priv/byob_test.db` so pool test seeds can't leak into dev.
- **Infra:** Fly instance scaled to 1 GB RAM.

---

# v3.5.0

**Roulette & Voting modes.** Two new ways to pick a video in a room:

- **Roulette** — click 🎰 in the room nav to open a shared wheel of 12 random candidates. Each candidate appears first as a readable card over the wheel, then shrinks into its slice. The ball orbits and physics-lands on the winner (exponential angular friction + inward spiral + damped pocket-bounce). Winner slice glows, a pie-slice countdown runs, then the winner auto-enqueues.
- **Voting** — click 🗳️ for a 15-second vote. Everyone can vote for any candidate. Highest-tally winner enqueues; random tiebreak; empty rounds end cleanly.

**Candidate pool.** Background `Byob.Pool.Scheduler` GenServer scrapes three sources on a schedule and writes to a new `video_pool` SQLite table:
- YouTube Trending (US, hourly + jitter)
- Reddit top-of-day from `r/videos`, `r/mealtimevideos`, `r/deepintoyoutube`, `r/listentothis` (hourly + jitter)
- 12 hardcoded curated playlists (daily + jitter)

Pick uses weighted sampling: **14-day freshness decay** (curated exempt) × **30-day repeat decay** on `last_picked_at`, so the same video rarely resurfaces soon after it's been picked in any room.

**Non-intrusive UI.** Round panel slots above the YouTube comments in the main column — never modal, never interrupts playback. Per-user collapse button. Only the starter can cancel an active round. Winner enqueues silently; activity log captures `:roulette_started / :roulette_winner / :vote_started / :vote_winner / :round_cancelled`.

**Ops.**
- `YOUTUBE_API_KEY` now loads in all envs (was prod-only) so dev can populate the pool.
- Test suite uses a dedicated `priv/byob_test.db` so test seeds can't leak into the dev DB.

---

# v3.4.19

- Server persistence now snapshots the **computed current position** (not the stale `current_time` field from the last event) plus a wallclock timestamp. On restart, the load path advances the position by elapsed wallclock for videos that were playing — so a fresh process picks up within seconds of where it actually was, not where it was at the last play/seek event.
- `play_state` from the persisted state is **preserved** on load (was previously always reset to `:paused`). If the room was playing when the deploy happened, it resumes playing from the advanced position.
- Persist interval **30s → 5s** for fresher disk state in the worst-case "deploy right before a scheduled persist" window.
- `schedule_sync_correction` is started on restore when the loaded state is `:playing`, so drift-correction broadcasts resume immediately on restart.
- Defensive: load path uses `Map.merge` so older persisted struct shapes (missing newer fields like `:pending_advance_ref`) load cleanly instead of `KeyError`-ing on init.

---

# v3.4.18

- On LiveView reconnect (e.g. after a server deploy), the client now pushes its current local play state and position back to the server via `video:play` / `video:pause`. Rationale: after a deploy the server reloads from SQLite with `play_state: :paused` and a possibly stale `current_time` (up to 30s old, or 0 if the video started recently). Without this echo, no one ever told the server the real position — so a fresh-joining tab would `sync:state` down the stale value. Combined with v3.4.17's is-a-real-transition guard on `:play`, the echo is safe: it's accepted when the server needs updating, ignored when it's already in sync.
- Added a `console.debug("[byob] _loadVideo", …)` diagnostic so the computed `startSeconds`, server-reported `current_time`, and clock-sync offset show up in browser devtools. Temporary aid for tracking the remaining edge cases in the refresh-after-deploy path.

---

# v3.4.17

- Server resilience: `:play` / `:pause` handlers now only update `current_time` on a real state transition (paused → playing, playing → paused). A client that's already seeing the video as playing and echoes `video:play` again can no longer overwrite the room's position. This is why the v3.4.16 refresh fix only worked once **everyone** refreshed — pre-v3.4.16 clients were sending position=0 back to the server during normal playback, and the server happily accepted it, poisoning state for fresh joiners. Seek events still update position explicitly.

---

# v3.4.16

- Fix: YouTube `onReady` callback now receives the wrapped player so the hook can assign `this.player` BEFORE `_applyPendingState` runs. Previously the onReady fired synchronously inside the `YT.Player` event — while the hook was still blocked on the `await YouTubePlayer.create(...)` — so `this.player` was still the old/null value and the initial `_seekTo` / `_play` in `_applyPendingState` were no-ops. This was the root cause of refresh-starts-at-0 and refresh-doesn't-autoplay.

---

# v3.4.15

- Fix: reconcile loop's "resync-before-hard-seek" safety check was swallowing every hard seek. Each tick with drift > 2s triggered a fresh NTP burst instead of seeking, then the next tick saw the still-huge drift and triggered another burst — infinite loop, never actually seeking. Now after a recent resync (< 3s ago) the reconcile loop trusts the drift measurement and performs the hard seek. This is why a refreshed client could stay stuck out of sync: the reconcile's self-correction was disabled.

---

# v3.4.14

- Fix (for real this time): page refresh during active playback now starts the YouTube embed at the correct position directly, via the `start` playerVar. Previously the embed loaded at 0 and we relied on a post-load `seekTo` — which got swallowed when autoplay was blocked or the player wasn't yet in a seekable state. The reconcile loop still tightens sub-second drift after load.

---

# v3.4.13

- **Server-driven autoplay countdown**: when a video ends, the server waits 5s before advancing to the next item. Clients render a bottom-right pie-slice overlay that fills clockwise over 5s, with the remaining seconds in the middle. All clients see the same countdown — no client-side timers, no race conditions, no duplicate log entries if multiple clients report `video_ended` for the same index.
- Fix: skip / play-index during an active countdown cancel it and advance immediately (or jump to the clicked item)
- Fix: refresh-during-playback starting from 0 instead of syncing to the current position — `_applyBufferedState` now sets `_pendingState` BEFORE calling `_loadVideo`, so the YouTube embed URL is generated with autoplay=1 when the server says the video is playing
- Fix: right sidebar stretches the whole page when comments are expanded — constrained to `lg:h-[calc(100vh-3.5rem)]` + `lg:sticky top-0 self-start` so it stays viewport-height regardless of main column height

---

# v3.4.12

- Activity log: new `:finished` event recorded whenever a video naturally ends ("Finished: <title>"), rendered with a ✓ icon. Skipping is unchanged — it continues to log `:skipped`.

---

# v3.4.11

- Fix: activity log now records the auto-advance to the next queue item when a video ends naturally ("Now playing: <title>"). Previously `advance_queue` was silent — only the very first auto-start (empty queue → first item) logged it.

---

# v3.4.10

- Tooltip on the comments expand button: "Expand comments viewer" / "Hide comments viewer" — uses daisyUI `tooltip tooltip-left` so it appears on hover without the 1–2s native `title` delay

---

# v3.4.9

- Activity log: clicking a queue item now records a distinct `played` event ("user played <title>") with a primary-colored play icon, instead of misleadingly reading "user resumed <title>"

---

# v3.4.8

- Sync: RoomServer broadcasts a lightweight state heartbeat every 5s. Clients adopt the server's `play_state` if theirs disagrees, and refresh the reconcile loop's reference point so drift extrapolation stays accurate between natural state changes. Any client that missed a broadcast (reconnect, transient drop, backgrounded tab) now self-heals within 5s — no need to wait for the next play/pause/seek event.

---

# v3.4.7

- Fix: "click play on next video" required after deploy — the auto-reload on disconnect was triggering after just 5s, destroying the YouTube iframe and losing the autoplay permission granted by earlier user gesture. Bumped the threshold: **30s when idle**, **120s while a video is actively playing**. LiveView normally reconnects in seconds after a deploy, so in the common case no reload happens and playback continues uninterrupted — the VideoPlayer hook's `reconnected()` callback handles resync on top of the existing iframe.

---

# v3.4.6

- Context menu: "Re-add to Queue" renamed to just "Add to Queue"
- Comments expand now clamps to a fixed 400px tall with internal scroll (was min-height 500px, which grew to fit all comments)

---

# v3.4.5

- Richer right-click context menu per item type:
  - Now Playing: Restart, Copy URL
  - Up Next: Play Now, Remove from Queue, Copy URL
  - History: Play Now, Add to Queue, Copy URL
- Fix URL extraction when two URLs are concatenated with no separator (e.g. pasting `https://youtu.be/ahttps://youtu.be/b`) — the last URL now wins instead of the whole string being treated as one garbage URL

---

# v3.4.4

- Video duration badge overlaid on thumbnails in the URL preview card, Now Playing, Up Next, and History (YouTube-style, bottom-right)
- URL preview shows channel name · "2 years ago" style relative upload date under the title
- New `Byob.YouTube.Videos` module fetches duration and `publishedAt` via the Data API with 24h ETS cache; falls back to oEmbed if the API key is missing or quota is out
- Fix: expand (+) button on the comments panel now uses a ResizeObserver instead of a Tailwind media query — shows whenever the panel is actually cramped, regardless of viewport height or aspect ratio
- Fix: right-click context menu now works on the Now Playing item and History items (was only Up Next)
- Fix: activity log now records a "play" event when you click an item in the queue (was silent)

---

# v3.4.3

- Sync: NTP maintenance every 10s (down from 30s) so drift is caught faster
- Sync: 3-probe mini-burst on `visibilitychange` — catching up to a backgrounded tab no longer needs a hard snap
- Sync: 3-probe mini-burst before any hard seek confirms "this is real drift, not clock skew" before yanking the playhead
- Sync: proportional `playbackRate` correction (scaled to drift size) replaces fixed 0.95/1.05 — smoother approach to zero, no overshoot
- Sync: rolling median over the last 5 drift samples kills instantaneous jitter, lower dead zone (50ms) for faster reaction
- Sync: direction-stability gate prevents rate-correction rubber-banding when drift crosses zero
- Fix custom right-click menu on queue items: switched hook from `oncontextmenu` property to `addEventListener` with proper teardown

---

# v3.4.2

- Play Now / Queue now blur the input so dropdowns close cleanly
- Loading skeleton no longer pulses transparent (only the gray shapes animate)
- Expand (+) button in bottom-right of comments on short viewports: click to make the comments panel taller and allow the page to scroll; click again (rotated to x) to collapse back
- The button only shows when the viewport height is under 800px, or when comments are already expanded

---

# v3.4.1

- Fix Play Now / Queue using stale URL when clicked before the 300ms debounce (form now submits with the current input value — no more "first URL wins when you paste a second")
- Fix UI sticking in a loading skeleton when the YouTube oEmbed fetch fails — preview now renders with a fallback title and working Play Now / Queue
- Fix overlapping dropdowns: the supported-sites hint no longer renders behind the error card, and only shows when the input is empty
- Dropdowns (hint, skeleton, preview, error) hide when the URL field isn't focused

---

# v3.4.0

- URL input dropdown now opens instantly on focus (CSS-driven, no server round-trip)
- Loading skeleton appears on the first keystroke, not after the 300ms debounce
- Error card explains why a URL was rejected:
  - byob room links (common accidental paste): "That's a byob room link — paste a video URL instead."
  - DRM-protected services (Netflix, Disney+, Max, Hulu, Prime Video, Apple TV+, Peacock, Paramount+): "{Service} uses DRM and can't be synced."
  - Non-URL / invalid input: "Doesn't look like a video URL."
- Paste support for URLs inside arbitrary text — the last `http(s)://` URL in the field is used, with trailing punctuation trimmed
- Play Now / Queue / Enter submit the extracted URL, so `hey watch this https://youtu.be/abc` works
- Hitting Enter on invalid input is a silent no-op (the error card already explains why)

---

# v3.3.5

- Keep Fly.io machine always running (disable auto-suspend, min 1 machine) — no cold-start delay on first visit

---

# v3.3.4

- Fix clear button visibility during focus/re-render (stable DOM id + client-side toggle)

---

# v3.3.3

- Clear button visible while input is focused (no DOM churn on re-render)

---

# v3.3.2

- Clear button stays visible while input is focused
- Fix clear button vertical centering in URL input

---

# v3.3.1

- Fix clear button vertical centering in URL input

---

# v3.3.0

- Clear button (x) on the right side of the URL input bar

---

# v3.2.0

- Per-browser toggle to show/hide YouTube comments (persisted in localStorage, configurable in settings)
- Collapse/expand arrow on comments panel header (non-persistent, defaults to open)

---

# v3.1.3

- Restore gap between video player and comments panel
- Fix bottom padding alignment between comments and sidebar

---

# v3.1.2

- Fix sidebar bottom padding alignment with comments panel

---

# v3.1.1

- Fix comments panel alignment with player
- Cap comments at 300px on mobile, fill to window on desktop
- URL input text no longer clears when clicking away

---

# v3.1.0

- Comments panel fills to window height on desktop, capped at 40vh on mobile
- Comments persist across page reloads (re-fetched on mount)
- URL preview dropdown hides on blur without clearing data
- Extension required link detects browser and opens correct store page
- Theme toggle syncs with saved preference on page load
- Removed comment count from comments header

---

# v3.0.0

### Architecture refactor
- Split `room_live.ex` (1200 → 336 lines) into 7 focused modules: UrlPreview, Playback, Queue, Username, PubSub, Components, Comments
- Split `video_player.js` (1050 → 712 lines) into player modules (YouTube, Direct, Extension), SponsorBlock, toasts, queue finished screen
- Sync engine classes (ClockSync, Suppression, Reconcile) in separate ES modules
- Common player interface: create/play/pause/seek/destroy across all player types
- SQLite schema versioning with migration runner framework
- Scaling constraints documented in docs/scaling.md

### YouTube comments panel
- Always-visible scrollable comments section below the video player
- Fetched server-side via YouTube Data API v3 (requires YOUTUBE_API_KEY)
- ETS cache with 15-minute TTL per video
- Graceful quota degradation — panel silently hidden when daily quota exhausted
- "Load more" pagination
- Relative time formatting (2h ago, 3d ago, etc.)

### Fixes
- URL preview dropdown hides on blur (click away to dismiss)
- Fixed stale tests for queue behavior and room ID validation
- All 76 tests passing

---

# v2.0.7

- Queue finished screen shows video title and thumbnail instead of raw URL
- Default YouTube thumbnail at load time (no waiting for oembed)
- Push metadata updates to JS hook when oembed results arrive

---

# v2.0.6

- Activity log: "Now playing: TITLE (added by NAME)" for auto-play/queue start
- "resumed" instead of "played" for manual unpause
- No more "joe played" noise on auto-play
- Auto-play from empty queue logs "Now playing" properly

---

# v2.0.5

- CLAUDE.md project context for AI assistants with release workflow docs
- Concise README with extension store links

---

# v2.0.4

- Only log seeks >3s that don't start from 0:00 (filters video load, SponsorBlock skips, initial sync)
- Auto-detect extension install on embed-blocked page (polls, updates UI without refresh)
- Privacy policy clarifies server-side analytics only (no tracking cookies/pixels)

---

# v2.0.3

- Embed-blocked UI: detects extension, shows "Watch on YouTube" or "Get Extension" with correct store link
- Auto-detects extension install and updates UI without refresh (polls every 2s)
- No click-to-play overlay on embed-blocked videos
- Analytics for embed-blocked events with source_type
- Detect seeks while playing, suppress duplicate play/pause log spam
- Hide YouTube URLs in sidebar when title available
- Auto-reload page after 5s server disconnect
- Concise README with extension store links
- Updated privacy policy

---

# v2.0.2

- Detect seeks while playing (3s threshold) — no longer missed in activity log
- Suppress duplicate play/pause log entries (only log actual state transitions)
- Hide YouTube URLs in sidebar when title is available (cleaner queue display)
- Non-YouTube sites and titleless items still show URL
- Auto-suspend machine when idle, cap to 1 machine (cost savings)
- Auto-reload page after 5s server disconnect (deploy/restart)

---

# v2.0.0

## Analytics

- PostHog analytics integration for anonymous usage tracking
- Tracks: room creation/join, video source types, playback actions, extension detection
- Does NOT track: video URLs/titles, usernames, browsing history, any extension data
- Browser-level distinct_id (same person across tabs)
- Extension detection from page JS (not extension code) — no extension privacy changes needed
- Configurable via `POSTHOG_API_KEY` env var (disabled when not set)
- Updated privacy policy with full analytics disclosure
- Self-hosted instances have no analytics unless configured

---

# v1.4.3

- Seek events in activity log with from/to timestamps (e.g. "joe seeked 1:23 → 4:56")

---

# v1.4.2

- Deduplicate user list by username (no more stale/disconnected dupes)
- Prevent taking a username already in use by another user
- Activity log entries wrap (line-clamp-2) instead of truncating
- Activity log "added" entries update to show video title when metadata loads
- Timestamps show seconds (e.g. "at 5:42:03 pm")

---

# v1.4.1

- Fix Play Now / Queue buttons requiring multiple clicks (race condition between blur and form submit)
- Buttons now use phx-click with stored URL — no form submission, deterministic single-click behavior

---

# v1.4.0

## Queue management and embed fallback

- Clicking a queue item replaces now-playing (old item removed), all others stay as Up Next
- Play Now replaces now-playing, puts new video at front of queue
- Only auto-advance (video end) removes the finished item
- Age-restricted / embed-blocked YouTube videos: fallback UI with "Watch on YouTube" button and extension sync hint
- YouTube IFrame error codes 100, 101, 150 detected and handled

---

# v1.3.5

## Queue and sync improvements

- Played items removed from queue (moved to history only)
- Play Now removes the old now-playing from queue
- Clicking a queue item to play removes the previous item
- No more duplicate items in Now Playing and Up Next
- Autoplay permissions: `Permissions-Policy: autoplay=*` header + iframe allow attribute
- Click-to-play overlay when browser blocks autoplay on join
- Per-tab user IDs restored for correct sync (no more feedback loops between tabs)
- Multi-tab users show "(you)" and "(other tab)" labels
- Username changes apply to all tabs of the same user
- Activity log: newest at bottom, auto-scrolls, video titles on play/pause, local timestamps
- Deterministic preview dropdown (no blur timing hack)
- URL preview shows full title (up to 3 lines)

---

# v1.3.4

- Fix stale room_pid after deploy/restart: auto-reconnect via attach_hook
- Always assign user_id (fallback anon ID if session missing)
- Activity log shows video title for play/pause events
- Activity log timestamps in local time
- Prettier queue finished screen
- Revert muted autoplay hack (caused volume issues)

---

# v1.3.3

- Fix Fly.io deploy health check: add `/health` endpoint excluded from force_ssl
- SSL redirect was causing health check redirect loop (301 to external domain)

---

# v1.3.2

- Fix double-skip on video end (position detector + YT_ENDED both fired)
- Deduplicate ended events via `_endedFired` flag and server-side index matching

---

# v1.3.1

- Muted autoplay fallback when joining a playing room (Chrome allows muted autoplay)
- Auto-unmute once playback starts
- Fly.io health check grace period to suppress startup warning

---

# v1.3.0

## Activity log, toasts, and queue polish

- Activity log in sidebar: tracks joins, leaves, play/pause, queue adds, skips, renames
- Toast notifications at bottom of screen for room events
- Right-click context menu on queue items: shows URL (grayed) + Copy URL
- Hide URLs from queue display (title only, URL via context menu)
- Smaller text for Up Next and History items
- Simplified duplicate tab notice (non-blocking)
- Attribution: Phoenix, daisyUI, Tailwind CSS credits in settings

---

# v1.2.0

## Queue UX and tab management

- Reuse YouTube player instance on queue selection — autoplay works without requiring a click
- "Finished playing" screen when queue ends, showing last video thumbnail and title
- Queue ended state clears "Now Playing" in sidebar
- Duplicate tab detection: new tab takes over, old tab gets disabled overlay with "Use this tab instead" button
- Per-browser user identity (all tabs share one user, no more duplicate users)
- Room API key moved below SponsorBlock settings in the modal
- Attribution text improvements

---

# v1.1.2

## Per-browser identity and duplicate tab warning

- Use localStorage for browser ID so all tabs share one user identity
- BroadcastChannel-based duplicate tab detection with warning banner

---

# v1.1.1

## API fix

- Return HTTP 201 (not 200) from `POST /api/rooms`
- Discord bot accepts both 200 and 201

---

# v1.1.0

## REST API

- **`POST /api/rooms`** — create a room, get back room_id, URL, and API key
- **`GET /api/rooms/:id`** — room info (current video, play state, user count)
- **`GET /api/rooms/:id/queue`** — full queue with current index
- **`POST /api/rooms/:id/queue`** — add URL (mode: "now" or "queue")
- **`DELETE /api/rooms/:id/queue/:item_id`** — remove from queue
- **`PUT /api/rooms/:id/queue/reorder`** — reorder items
- **`POST /api/rooms/:id/skip`** — skip to next
- **`POST /api/rooms/:id/play`** — play at position
- **`POST /api/rooms/:id/pause`** — pause at position
- **`GET /api/rooms/:id/users`** — list users
- **`PUT /api/rooms/:id/username`** — change API user's name
- **`GET /api`** — self-documenting endpoint page with curl examples
- Auth via `Authorization: Bearer <token>` or `?api_key=<token>`
- ETS-based rate limiting (5/min create, 20/min mutations, 60/min reads)
- Room API key shown in settings modal with copy button
- API users appear in the room's user list

## Fixes

- Auto-play first video when added to empty queue via "Queue" mode

---

# v1.0.1

- Chrome Web Store and Firefox AMO extension links
- Chrome Web Store submission docs
- Privacy policy link and version number in settings modal
- Centralized extension store URLs in `Byob.Links`

---

# v1.0.0

## Watch any video, together

byob is now at v1.0.0! Create a room at [byob.video](https://byob.video), share the link, and watch together.

## Supported sources

- **YouTube** — synced play/pause/seek with [SponsorBlock](https://sponsor.ajay.app) integration (auto-skip sponsors, colored seek bar segments)
- **Direct video files** — paste any .mp4, .webm, .ogg, .mov, or .mkv URL for synced playback with a built-in HTML5 player
- **Any streaming site** — Crunchyroll, anime sites, etc. via the [browser extension](https://github.com/joegoldin/byob.video/releases)

## Features

- Video queue with drag-to-reorder and auto-advance to next video
- SponsorBlock with per-room category settings (auto-skip, show in bar, or disable)
- Room history — click to replay past videos
- Random usernames, renamable, with online/offline status
- Dark mode by default (light mode available)
- Rooms persist across server restarts

## Extension highlights

- Sync bar overlay shows Playing/Paused status with timestamps
- Collapses to a small pill in the bottom-right corner
- Detects videos automatically in nested iframes and shadow DOM
- Pauses playback when all player windows close
- Authenticated WebSocket connection with signed tokens

## Self-hosted

byob is free, open source (MIT), and designed to be self-hosted. Deploy with Docker or Fly.io.

```
fly deploy
```

Source code: [github.com/joegoldin/byob.video](https://github.com/joegoldin/byob.video)

---

# v0.7.0

## Branding and polish

- Custom logo and favicon throughout the app and extension
- About section in settings modal with SponsorBlock attribution and license links
- Landing page redesign with logo, supported formats, and extension links
- GitHub link in header nav bar
- Centralized link configuration (`Byob.Links`) with browser-detected extension URLs
- SVGs served from `priv/static/images/` as single source of truth
- Extension icons generated from SVG at nix build time via imagemagick

---

# v0.6.0

## Direct video URL playback

- New source type: paste any direct video link (.mp4, .webm, .ogg, .mov, .mkv, .avi, .m4v)
- Built-in HTML5 `<video>` player with native controls, fully synced across users
- Play/pause/seek/ended events synced like YouTube — same reconcile and clock sync engine
- URL preview shows film icon with filename
- No extension needed for direct video files
- Centralized `VERSION` file — single source of truth for mix.exs, extension manifests, and nix flake

---

# v0.5.0

## Security hardening

- **Critical**: Fixed RCE via `binary_to_term` — added `:safe` flag in persistence
- **Critical**: Fixed SSRF — block internal/private IPs in OpenGraph URL fetching
- Token-based extension WebSocket auth via Phoenix.Token (24h expiry)
- Extension only writes storage config from trusted origins
- Extension presence indicator hidden from other websites
- Sync bar uses DOM APIs instead of innerHTML
- Validated SponsorBlock categories, room IDs, username lengths
- Queue capped at 200 items, history at 99 entries
- Rate limited room creation (5 per minute per session)
- DB path configurable via `BYOB_DB_PATH` env var
- Default to dark mode
- Fly.io deployment config with SQLite volume mount

---

# v0.4.0

## Inline nav bar and drag-reorder queue

- Room renders its own nav bar with logo, copy link, URL input, settings, and theme toggle all inline
- URL preview appears as dropdown overlay below search input
- Drag-and-drop reordering for queue items
- Online users sorted to top of list, self shown bold with (you)
- Users list scrolls when too many users
- Player maintains 16:9 ratio without black bars, JS-driven sizing

---

# v0.3.1

## Extension sync bar and external player UX

- Sync bar status progression: Loading -> Searching -> Syncing -> Playing/Paused
- Sync bar collapses to small pill on bottom-right
- Bar updates relayed via port system for cross-origin iframe support
- Fix suppression: only suppress expected event, let user actions through
- Focus existing external player window instead of opening duplicate
- Copy room link works after DOM teleport
- Extension sends video:ended to advance queue for external sites
- Pause playback when all external player windows close
- Pass media item metadata on refresh for external video placeholder
- Include thumbnail_url in serialized queue items
- Disable check_origin on extension WebSocket for production

---

# v0.3.0

## Browser extension for non-YouTube sites

- Extension content script detects `<video>` elements on any site via MutationObserver
- Shadow DOM support via attachShadow monkey-patch
- Works in nested iframes (all_frames: true) for sites like Crunchyroll
- Sync bar overlay on external player pages
- Cross-origin iframe communication via chrome.runtime.sendMessage relay
- Extension service worker maintains Phoenix Channel WebSocket to server
- Pause enforcer fights site autoplay after sync
- OpenGraph metadata fetching for non-YouTube URL previews
- External player popup window management

---

# v0.2.1

## Extension packaging and distribution

- Chrome extension packaged as .crx via chromium --pack-extension
- Firefox extension packaged as .xpi with AMO-compatible manifest
- Nix flake for building Chrome, Firefox, and Docker packages
- Justfile with build targets
- Extension config via chrome.storage instead of URL params
- Auto-close external player on video change

---

# v0.1.1

## Docker and deployment

- Dockerfile with multi-stage build (elixir:1.19 + Node.js 22)
- Fix colocated hooks: compile before assets.deploy

---

# v0.1.0

## Core watch party features

- Ephemeral rooms with shareable URLs
- YouTube embedded playback with synced play/pause/seek
- NTP-style clock synchronization (5-probe burst, median filtering)
- Generation counter event suppression to prevent sync echo loops
- Drift correction with playbackRate adjustment and hard-seek threshold
- Video queue with Play Now and Queue modes, auto-advance on end
- SponsorBlock integration with auto-skip and colored seek bar segments
- Per-room SponsorBlock category settings
- Room history with replay
- SQLite persistence for room state across server restarts
- Dark/light theme toggle
- Random usernames, renamable, with online/offline presence
- Per-tab user sessions via sessionStorage
- URL preview with YouTube oEmbed metadata

---

# v0.0.1

## Initial prototype

- Basic room creation and joining
- YouTube player embed with LiveView push events
