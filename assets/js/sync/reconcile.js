// Drift correction loop — seek-only, no rate correction.
//
// Model:
//   * Track raw drift per tick: drift = local_position - server_expected.
//     No offset EMA: structural decoder lag (~50-200 ms) is below the
//     tolerance floor so it doesn't matter; bigger persistent offsets
//     are real desyncs that should be seeked away, not "learned".
//   * Track jitter as EMA of |Δdrift| per tick. Robust to bias and slow
//     drift; captures actual measurement noise.
//   * Tolerance = K × max(local jitter, room jitter), clamped to a
//     [floor, ceiling] band. No separate "rate correction" zone — once
//     drift exceeds tolerance for SEEK_CONFIRM_TICKS, we hard seek.
//   * Hard seek is gated by exponential backoff cooldown: 1s, 2s, 4s,
//     5s (cap). Streak resets after 60 s of quiet, so a single late-
//     join seek doesn't penalize itself if everything's calm afterward.
//
// Why no rate correction:
//   On many devices (mobile Safari, ad-supported YT embeds) setPlayback-
//   Rate is silently ignored or clamped, so the loop fires forever
//   without making progress and we eventually fall through to a hard
//   seek anyway — visible as a frame jump that the user attributes to
//   "rate correction stuttering". Skip the indirection: just seek when
//   we actually need to, rate-limit the seeks, and let the player run
//   at native speed in between.
//
// Why no offset EMA:
//   The EMA can't distinguish "structural decoder lag" (~100 ms, fine
//   to ignore) from "positional desync we've given up correcting"
//   (large, definitely NOT fine to ignore). It learned both as
//   "structural" and stopped correcting — hiding real desyncs. Better
//   to just use raw drift and accept that small (<tolerance) decoder
//   lag is below the threshold for action.

const TICK_MS = 100;
const NOISE_EMA_ALPHA = 0.1;             // ~1 s horizon
const NOISE_K_TOLERANCE = 4;             // tolerance = 4 × jitter (4σ headroom)
// Floor must be above the typical seek-completion residual (drift settles
// to ≈ −L after a no-overshoot seek). YT/iOS L runs 500-1000 ms, so a
// 600 ms floor keeps us in-band post-seek without re-seeking forever. The
// proper fix (adaptive L learning) lives in the upcoming server-driven
// rewrite; this is the conservative tolerance that works without it.
//
// No hard upper cap — if a peer's jitter is 2 s, fighting it with seeks
// makes things worse, not better. Tolerance scales freely with observed
// noise so the system *accepts* what each client can actually achieve.
// 30 s "ceiling" exists only to short-circuit pathological floats /
// runaway EMA values; in practice nothing real reaches it.
const MIN_TOLERANCE_MS = 600;
const MAX_TOLERANCE_MS = 30_000;
const POST_SEEK_TOLERANCE_BUMP_MS = 300; // bump after a seek to absorb the −L residual
const POST_SEEK_QUIET_MS = 5000;
const SEEK_CONFIRM_TICKS = 3;            // 300 ms sustained over tolerance before acting
const SEEK_COOLDOWN_BASE_MS = 1000;      // first cooldown after a seek
const SEEK_COOLDOWN_MAX_MS = 5000;       // cap — never wait longer than this
const SEEK_STREAK_RESET_MS = 10_000;     // 10 s quiet → cooldown ladder resets
const SEEK_POST_PAUSE_MS = 3000;         // post-seek: pause reconcile to let the player settle
// Allow multiple seeks per burst because each one converges fast with the
// overshoot below. Cap exists for the pathological "seeks fundamentally
// not taking effect" case where overshoot can't help.
const MAX_SEEK_STREAK = 3;

export class Reconcile {
  constructor(playerAdapter) {
    // playerAdapter: { getCurrentTime(), seekTo(seconds), setPlaybackRate(rate) }
    this.player = playerAdapter;
    this.clockSync = null;
    this.serverPosition = 0; // seconds
    this.serverTime = 0;     // ms (server monotonic)
    this.interval = null;
    this.pausedUntil = 0;    // temporarily disable reconcile

    // Jitter (noise) EMA — tick-to-tick |Δdrift|.
    this.noiseFloorEmaMs = 0;
    this.noiseSamples = 0;

    // Room consensus (set by VideoPlayer from `sync:room_tolerance`).
    // jitter joins our local jitter via max(); maxDrift is informational.
    this.roomJitterMs = 0;
    this.roomMaxDriftMs = 0;

    // Seek tracking.
    this.lastSeekAt = 0;
    this.seekStreak = 0;
    this.seekCandidateTicks = 0;

    // Cached for stats panel.
    this.lastDriftMs = 0;
    this._effectiveToleranceMs = MIN_TOLERANCE_MS;
  }

  // resetHistory is accepted for back-compat but no longer needed without
  // a drift-history median; the jitter EMA is continuous across reference
  // refreshes anyway.
  setServerState(position, serverTime, clockSync, _opts = {}) {
    this.serverPosition = position;
    this.serverTime = serverTime;
    this.clockSync = clockSync;
    this.seekCandidateTicks = 0;
  }

  // Apply room-wide consensus. jitter is folded into the tolerance via
  // max(local, room); maxDrift is informational only (no longer drives
  // tolerance — seeks fix sustained drift, they don't tolerate it).
  setRoomTolerance({ jitter = 0, maxDrift = 0 } = {}) {
    this.roomJitterMs = Math.max(0, jitter || 0);
    this.roomMaxDriftMs = Math.max(0, maxDrift || 0);
  }

  // Snapshot exposed to the stats panel.
  getEffectiveThresholds() {
    const postSeek = Date.now() - this.lastSeekAt < POST_SEEK_QUIET_MS;
    return {
      toleranceMs: this._effectiveToleranceMs,
      noiseFloorMs: this.noiseFloorEmaMs,
      roomJitterMs: this.roomJitterMs,
      roomMaxDriftMs: this.roomMaxDriftMs,
      postSeek,
      seekStreak: this.seekStreak,
      cooldownRemainingMs: this._cooldownRemainingMs(),
    };
  }

  // Legacy shims kept so callers don't break (offset row in panel hides
  // when 0; resetOffset is no-op).
  getOffsetMs() { return 0; }
  resetOffset() {}

  // Temporarily pause reconcile (e.g., during local seek).
  pauseFor(ms) {
    this.pausedUntil = Date.now() + ms;
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.noiseFloorEmaMs = 0;
    this.noiseSamples = 0;
    this.roomJitterMs = 0;
    this.roomMaxDriftMs = 0;
    this.lastSeekAt = 0;
    this.seekStreak = 0;
    this.seekCandidateTicks = 0;
    this._effectiveToleranceMs = MIN_TOLERANCE_MS;
    try { this.player.setPlaybackRate(1.0); } catch (_) {}
  }

  _tick() {
    if (!this.clockSync || !this.clockSync.isReady()) return;
    if (Date.now() < this.pausedUntil) return;

    const now = this.clockSync.serverNow();
    const elapsed = (now - this.serverTime) / 1000;
    const expectedPosition = this.serverPosition + elapsed;
    const localPosition = this.player.getCurrentTime();
    const driftMs = (localPosition - expectedPosition) * 1000;

    // Jitter EMA (skip the very first sample where Δ is undefined).
    if (this.noiseSamples > 0) {
      const tickDelta = Math.abs(driftMs - this.lastDriftMs);
      this.noiseFloorEmaMs =
        NOISE_EMA_ALPHA * tickDelta + (1 - NOISE_EMA_ALPHA) * this.noiseFloorEmaMs;
    }
    this.noiseSamples++;

    // Tolerance = K × max(local, room) jitter, clamped, with post-seek
    // bump. Wider on flaky links, tight on calm ones.
    const effectiveJitterMs = Math.max(this.noiseFloorEmaMs, this.roomJitterMs);
    const adaptiveTolerance = clamp(
      NOISE_K_TOLERANCE * effectiveJitterMs,
      MIN_TOLERANCE_MS,
      MAX_TOLERANCE_MS
    );
    const postSeek = Date.now() - this.lastSeekAt < POST_SEEK_QUIET_MS;
    const tolerance = postSeek
      ? Math.min(MAX_TOLERANCE_MS, adaptiveTolerance + POST_SEEK_TOLERANCE_BUMP_MS)
      : adaptiveTolerance;

    this._effectiveToleranceMs = tolerance;
    this.lastDriftMs = driftMs;

    // Streak decay: a long quiet window resets the cooldown ladder.
    if (
      this.seekStreak > 0 &&
      this.lastSeekAt &&
      Date.now() - this.lastSeekAt > SEEK_STREAK_RESET_MS
    ) {
      this.seekStreak = 0;
    }

    // In tolerance → nothing to do.
    if (Math.abs(driftMs) < tolerance) {
      this.seekCandidateTicks = 0;
      return;
    }

    // Out of tolerance → confirm sustained drift before acting.
    this.seekCandidateTicks++;
    if (this.seekCandidateTicks < SEEK_CONFIRM_TICKS) return;

    // Hard cap: if we've already tried MAX_SEEK_STREAK times without
    // settling, the seeks aren't taking effect on this device (iOS
    // YouTube embed delay, network unable to keep up, etc.). Stop
    // trying — no point making it worse. Streak resets after 10 s of
    // quiet, so this isn't permanent for the session.
    if (this.seekStreak >= MAX_SEEK_STREAK) return;

    // Sustained drift confirmed. Cooldown gate.
    if (this._cooldownRemainingMs() > 0) return;

    // Seek straight to expected. v6.6.2's overshoot formula
    // (target = expected − drift) was *wrong*: it assumed drift = −L
    // (where L is seek processing time). That holds after a previous
    // failed seek, but NOT for first-time drift from a late join or
    // buffering — there drift can be 1500+ ms while L is 500-700 ms.
    // Overshooting by 1500 puts us 800 ms ahead, next iteration
    // overshoots back to 1500 behind, infinite oscillation.
    //
    // No-overshoot result: drift converges to a residual ≈ −L (because
    // the seek itself eats L of expected's advancement). The tolerance
    // floor is set above typical L so the residual stays in-band and
    // we don't seek-loop. Real fix is server-driven sync with adaptive
    // L-learning per client; that's the next release.
    this.player.seekTo(expectedPosition);
    this.lastSeekAt = Date.now();
    this.seekStreak++;
    this.seekCandidateTicks = 0;
    this.pauseFor(SEEK_POST_PAUSE_MS);
  }

  _cooldownRemainingMs() {
    if (!this.lastSeekAt || this.seekStreak === 0) return 0;
    const cooldown = Math.min(
      SEEK_COOLDOWN_BASE_MS * Math.pow(2, this.seekStreak - 1),
      SEEK_COOLDOWN_MAX_MS
    );
    return Math.max(0, cooldown - (Date.now() - this.lastSeekAt));
  }
}

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}
