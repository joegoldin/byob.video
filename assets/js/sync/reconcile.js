// Drift correction loop with proportional playbackRate and hard seek.
//
// Thresholds:
//   * Dead zone:    < deadZone        → rate = 1.0
//   * Rate correct: deadZone – hardSeek → proportional rate (0.9 – 1.1)
//   * Hard seek:    > hardSeek        → seekTo; triggers resync to rule out clock skew
//
// Both deadZone and hardSeek are *adaptive* — derived from this player's
// observed tick-to-tick drift jitter (noiseFloorEma) so a calm link gets
// tight thresholds and a flaky link gets wide ones. We don't fight noise.
//
// Stability mechanics:
//   * noiseFloorEma is the EMA of |Δdrift| per tick — model-free jitter
//     measure, robust to bias and slow drift.
//   * driftHistory rolling median kills instantaneous jitter
//   * directionStable gate requires N consistent-sign samples before flipping rate
//   * Hard-seek confirm window: drift must exceed threshold for N consecutive
//     ticks before we even trigger the resync flow. A single jitter spike
//     (common on high-RTT-variance links, e.g. cross-coast) gets filtered.
//   * Post-seek quiet window (widened dead-zone bump for 5 s) prevents re-trigger on bounce
//   * Before hard seek, we request a mini-burst resync. If drift is still huge after
//     the fresh offset lands, we seek. Otherwise the rate-correction path handles it.
//   * setServerState only clears history on genuine state transitions (play /
//     pause / seek). Periodic reference refreshes (sync_correction every 1 s,
//     state_heartbeat every 5 s) leave history intact so the median filter
//     stays warm — otherwise it'd be wiped before it can smooth anything.
//
// Adaptive offset:
//   Each client has a structural latency (decode + render + measurement bias).
//   We learn it as an EMA of raw drift during stable conditions, then use
//   `drift - offsetEma` as the correction signal. Two clients with different
//   structural latencies converge on the same wall-clock moment instead of
//   each sitting at their own drift within tolerance.

const TICK_MS = 100;
const HISTORY_SIZE = 5;
// Adaptive thresholds. The dead zone and hard-seek thresholds are derived
// from this player's observed *tick-to-tick* drift jitter (noiseFloorEma),
// which is a model-free measure of how much our drift signal bounces
// independent of any bias or slow steady drift. Higher jitter → wider
// thresholds, so we don't fight noise. Calm local network → tight
// thresholds for fast convergence.
const NOISE_EMA_ALPHA = 0.1;          // ~10-sample (1 s) horizon
const NOISE_K_DEAD = 4;               // ~99 % CI of normal-distributed noise
const NOISE_K_HARD = 30;              // ≫ noise → real desync, not jitter
const MIN_DEAD_ZONE_MS = 250;         // floor matches UI's "in tolerance" green threshold
const MAX_DEAD_ZONE_MS = 1500;        // ceiling — peers shouldn't drift > 1.5 s
const MIN_HARD_SEEK_MS = 3000;        // never snap on < 3 s drift
const MAX_HARD_SEEK_MS = 8000;        // anything beyond 8 s is pathological
const POST_SEEK_DEAD_ZONE_BUMP_MS = 500; // additive on top of adaptive
const POST_SEEK_QUIET_MS = 5000;
const RATE_TIME_CONSTANT_S = 5; // drift/timeConstant scales into the rate delta
const RATE_MIN = 0.9;
const RATE_MAX = 1.1;
const HARD_SEEK_WHILE_CORRECTING_BUMP_MS = 1000; // additive on top of adaptive
const HARD_SEEK_CONFIRM_TICKS = 3;
const DIRECTION_STABILITY_SAMPLES = 3;
const OFFSET_EMA_ALPHA = 0.02;       // ~50 samples (5s @ 100ms) to track
const OFFSET_CAP_MS = 1500;          // refuse to learn beyond this (transient protection)
const OFFSET_WARMUP_SAMPLES = 10;    // ignore EMA until this many stable samples

export class Reconcile {
  constructor(playerAdapter) {
    // playerAdapter: { getCurrentTime(), seekTo(seconds), setPlaybackRate(rate) }
    this.player = playerAdapter;
    this.clockSync = null;
    this.serverPosition = 0; // seconds
    this.serverTime = 0; // ms (server monotonic)
    this.interval = null;
    this.isRateCorrecting = false;
    this.currentRateSign = 0; // -1 (slow), 0 (none), +1 (fast)
    this.lastHardSeekAt = 0;
    this.pausedUntil = 0; // temporarily disable reconcile
    this.resyncInFlight = false;
    this.lastResyncAt = 0;
    this.hardSeekCandidateTicks = 0; // consecutive ticks above hard-seek threshold
    this.driftHistory = []; // rolling list of most-recent drifts (ms)
    this.offsetEmaMs = 0;   // learned structural latency (ms)
    this.offsetSamples = 0; // count of stable samples contributing to EMA
    // EMA of |drift_t − drift_{t-1}| — captures tick-to-tick jitter
    // (independent of bias and slow drift). Drives the adaptive dead zone
    // and hard-seek threshold.
    this.noiseFloorEmaMs = 0;
    this.noiseSamples = 0;
    // Room-wide jitter consensus from the server (max of all peers'
    // noiseFloor over the last 5 s). Used as a floor on this client's
    // own jitter so calm peers don't rate-correct against a noisy peer's
    // signal. Set externally via setRoomJitter().
    this.roomJitterMs = 0;
    this.lastDriftMs = 0;   // most recent adjusted drift (for UI reporting)
    this.lastRawDriftMs = 0;
    // Latest effective thresholds (cached so getEffectiveThresholds is cheap).
    this._effectiveDeadZoneMs = MIN_DEAD_ZONE_MS;
    this._effectiveHardSeekMs = MIN_HARD_SEEK_MS;
  }

  // resetHistory: pass false for periodic reference refreshes (sync_correction,
  // state_heartbeat) where the drift signal is continuous across the update.
  // Default true preserves the original semantics for genuine state transitions
  // (play / pause / seek), where prior drift samples no longer apply.
  setServerState(position, serverTime, clockSync, { resetHistory = true } = {}) {
    this.serverPosition = position;
    this.serverTime = serverTime;
    this.clockSync = clockSync;
    if (resetHistory) {
      // State moved; drift history is stale. Keep offsetEma — it's a property
      // of the player pipeline, not of any particular server reference.
      this.driftHistory = [];
      this.hardSeekCandidateTicks = 0;
    }
  }

  // Current learned offset (for UI / reporting).
  getOffsetMs() {
    return this.offsetSamples >= OFFSET_WARMUP_SAMPLES ? this.offsetEmaMs : 0;
  }

  // Forget the learned offset (call on source/video change).
  resetOffset() {
    this.offsetEmaMs = 0;
    this.offsetSamples = 0;
  }

  // Apply the room-wide jitter consensus. Reconcile uses
  // `max(localJitter, roomJitter)` as the input to its adaptive thresholds,
  // so calm peers tolerate the room's noisiest signal. 0 falls back to
  // local-only behavior.
  setRoomJitter(ms) {
    this.roomJitterMs = Math.max(0, ms || 0);
  }

  // The thresholds the most recent tick actually applied. Both the dead
  // zone and the hard-seek threshold are adaptive (scale with observed
  // jitter) and additionally widened by event-driven hysteresis (post-seek
  // dead zone, mid-correction hard seek). Surfaced for the stats-for-
  // nerds panel so users can see *why* a band grew.
  getEffectiveThresholds() {
    const postSeek = Date.now() - this.lastHardSeekAt < POST_SEEK_QUIET_MS;
    return {
      deadZoneMs: this._effectiveDeadZoneMs,
      hardSeekMs: this._effectiveHardSeekMs,
      noiseFloorMs: this.noiseFloorEmaMs,
      roomJitterMs: this.roomJitterMs,
      isRateCorrecting: this.isRateCorrecting,
      postSeek,
    };
  }

  // Temporarily pause reconcile (e.g., during local seek)
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
    this.isRateCorrecting = false;
    this.currentRateSign = 0;
    this.driftHistory = [];
    this.hardSeekCandidateTicks = 0;
    this.offsetEmaMs = 0;
    this.offsetSamples = 0;
    this.noiseFloorEmaMs = 0;
    this.noiseSamples = 0;
    this.roomJitterMs = 0;
    this._effectiveDeadZoneMs = MIN_DEAD_ZONE_MS;
    this._effectiveHardSeekMs = MIN_HARD_SEEK_MS;
    try {
      this.player.setPlaybackRate(1.0);
    } catch (_) {}
  }

  _tick() {
    if (!this.clockSync || !this.clockSync.isReady()) return;
    if (Date.now() < this.pausedUntil) return;
    if (this.resyncInFlight) return;

    const now = this.clockSync.serverNow();
    const elapsed = (now - this.serverTime) / 1000;
    const expectedPosition = this.serverPosition + elapsed;
    const localPosition = this.player.getCurrentTime();
    const rawDriftMs = (localPosition - expectedPosition) * 1000;

    const postSeek = Date.now() - this.lastHardSeekAt < POST_SEEK_QUIET_MS;

    // Update EMA whenever raw drift is in a plausible structural-bias range
    // and we're not in the post-seek transient. We deliberately DON'T gate
    // on `!isRateCorrecting`: a peer with persistent structural bias (e.g.
    // mobile decode pipeline) sits ABOVE the dead zone forever, so gating
    // on "not correcting" meant the EMA never converged for exactly the
    // peers that needed it most. Bootstrap loop: bias > tolerance → rate-
    // correcting → no learning → bias never subtracted → still > tolerance,
    // ad infinitum.
    //
    // Letting EMA learn during rate correction is safe: the EMA's slow
    // alpha (~5 s horizon) averages out the transient catch-up motion
    // that rate correction induces, and the OFFSET_CAP_MS guard rejects
    // genuine outliers (post-seek transients, network glitches).
    const stableForLearning =
      !postSeek &&
      Math.abs(rawDriftMs) < OFFSET_CAP_MS * 2;
    if (stableForLearning) {
      if (this.offsetSamples === 0) {
        this.offsetEmaMs = rawDriftMs;
      } else {
        this.offsetEmaMs =
          OFFSET_EMA_ALPHA * rawDriftMs + (1 - OFFSET_EMA_ALPHA) * this.offsetEmaMs;
      }
      this.offsetEmaMs = clamp(this.offsetEmaMs, -OFFSET_CAP_MS, OFFSET_CAP_MS);
      this.offsetSamples++;
    }

    // Subtract learned offset so reconcile acts on drift from baseline, not
    // from the abstract server projection. Uniform -200ms across clients →
    // all learn -200 → all adjusted-drifts → 0 → no corrections fire.
    const effectiveOffsetMs =
      this.offsetSamples >= OFFSET_WARMUP_SAMPLES ? this.offsetEmaMs : 0;
    const driftMs = rawDriftMs - effectiveOffsetMs;

    // -----------------------------------------------------------------
    // Adaptive noise estimate: tick-to-tick |Δdrift|. Robust to bias
    // (offset already removed) and slow drift (a steady ramp produces
    // a ~constant Δ, which is the actual rate of change, not noise —
    // but conveniently still small). Big spikes here = real jitter.
    // -----------------------------------------------------------------
    const tickDelta = this.noiseSamples === 0 ? 0 : Math.abs(driftMs - this.lastDriftMs);
    if (this.noiseSamples === 0) {
      this.noiseFloorEmaMs = 0;
    } else {
      this.noiseFloorEmaMs =
        NOISE_EMA_ALPHA * tickDelta + (1 - NOISE_EMA_ALPHA) * this.noiseFloorEmaMs;
    }
    this.noiseSamples++;

    // Effective thresholds: scale with the larger of this client's own
    // jitter and the room consensus (so calm peers don't rate-correct
    // against a jittery peer's noise). Clamped, then widened by event-
    // driven hysteresis (post-seek, mid-correction).
    const effectiveJitterMs = Math.max(this.noiseFloorEmaMs, this.roomJitterMs);
    const adaptiveDeadZone = clamp(
      NOISE_K_DEAD * effectiveJitterMs,
      MIN_DEAD_ZONE_MS,
      MAX_DEAD_ZONE_MS
    );
    const adaptiveHardSeek = clamp(
      NOISE_K_HARD * effectiveJitterMs,
      MIN_HARD_SEEK_MS,
      MAX_HARD_SEEK_MS
    );
    const deadZone = postSeek
      ? Math.min(MAX_DEAD_ZONE_MS, adaptiveDeadZone + POST_SEEK_DEAD_ZONE_BUMP_MS)
      : adaptiveDeadZone;
    const hardSeekThreshold = this.isRateCorrecting
      ? Math.min(MAX_HARD_SEEK_MS, adaptiveHardSeek + HARD_SEEK_WHILE_CORRECTING_BUMP_MS)
      : adaptiveHardSeek;
    this._effectiveDeadZoneMs = deadZone;
    this._effectiveHardSeekMs = hardSeekThreshold;

    // Rolling median filter to smooth out per-tick noise (on adjusted drift)
    this.driftHistory.push(driftMs);
    if (this.driftHistory.length > HISTORY_SIZE) this.driftHistory.shift();

    const medianDriftMs = median(this.driftHistory);
    const absMedian = Math.abs(medianDriftMs);

    this.lastDriftMs = driftMs;
    this.lastRawDriftMs = rawDriftMs;

    // -----------------------------------------------------------------
    // Hard-seek path: require N consecutive over-threshold ticks before we
    // even start the resync flow. A single jitter spike (common on high-
    // RTT-variance links — e.g. cross-coast peers) gets filtered. Once we
    // do trigger a resync and drift is still threshold-worthy after, it's
    // real drift — seek and stop looping.
    // -----------------------------------------------------------------
    if (absMedian >= hardSeekThreshold) {
      const recentlyResynced = Date.now() - this.lastResyncAt < 3000;

      // Resync just happened and drift is still huge → real drift, seek now.
      if (recentlyResynced) {
        this._applyHardSeek(expectedPosition);
        return;
      }

      this.hardSeekCandidateTicks++;
      if (this.hardSeekCandidateTicks < HARD_SEEK_CONFIRM_TICKS) {
        return; // wait for sustained drift before acting
      }

      if (this.clockSync.resync) {
        this.resyncInFlight = true;
        this.clockSync
          .resync(3)
          .catch(() => {})
          .finally(() => {
            this.resyncInFlight = false;
            this.lastResyncAt = Date.now();
          });
        return;
      }

      this._applyHardSeek(expectedPosition);
      return;
    }

    // Drift dropped back under threshold — start the confirm counter over.
    this.hardSeekCandidateTicks = 0;

    // -----------------------------------------------------------------
    // Rate-correction path: proportional rate, direction-stable gate.
    // -----------------------------------------------------------------
    if (absMedian >= deadZone) {
      const sign = medianDriftMs > 0 ? 1 : -1;

      // If already correcting in this direction: just update rate.
      // If flipping direction: require history to agree before flipping.
      if (this.isRateCorrecting && sign !== this.currentRateSign) {
        if (!this._directionStable(sign)) {
          return; // wait for stability before flipping
        }
      }

      // Proportional rate: ±(drift / RATE_TIME_CONSTANT_S), clamped.
      const proposedRate = 1 - medianDriftMs / 1000 / RATE_TIME_CONSTANT_S;
      const rate = clamp(proposedRate, RATE_MIN, RATE_MAX);

      this.player.setPlaybackRate(rate);
      this.isRateCorrecting = true;
      this.currentRateSign = sign;
      return;
    }

    // -----------------------------------------------------------------
    // In dead zone: release correction.
    // -----------------------------------------------------------------
    if (this.isRateCorrecting) {
      this.player.setPlaybackRate(1.0);
      this.isRateCorrecting = false;
      this.currentRateSign = 0;
    }
  }

  _applyHardSeek(expectedPosition) {
    this.player.seekTo(expectedPosition);
    this.player.setPlaybackRate(1.0);
    this.isRateCorrecting = false;
    this.currentRateSign = 0;
    this.lastHardSeekAt = Date.now();
    this.driftHistory = [];
    this.hardSeekCandidateTicks = 0;
  }

  // True if the most recent DIRECTION_STABILITY_SAMPLES drifts all have the
  // same sign as `sign`.
  _directionStable(sign) {
    if (this.driftHistory.length < DIRECTION_STABILITY_SAMPLES) return false;
    const recent = this.driftHistory.slice(-DIRECTION_STABILITY_SAMPLES);
    return recent.every((d) => (d > 0 ? 1 : -1) === sign);
  }
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}
