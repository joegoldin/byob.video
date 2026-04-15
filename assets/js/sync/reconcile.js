// Drift correction loop with proportional playbackRate and hard seek.
//
// Thresholds:
//   * Dead zone:    < 50 ms drift → rate = 1.0
//   * Rate correct: 50 ms – hardSeekThreshold → proportional rate (0.9 – 1.1)
//   * Hard seek:    > hardSeekThreshold  → seekTo; triggers resync to rule out clock skew
//
// Stability mechanics:
//   * driftHistory rolling median kills instantaneous jitter
//   * directionStable gate requires N consistent-sign samples before flipping rate
//   * Post-seek quiet window (widened dead-zone for 5 s) prevents re-trigger on bounce
//   * Before hard seek, we request a mini-burst resync. If drift is still huge after
//     the fresh offset lands, we seek. Otherwise the rate-correction path handles it.

const TICK_MS = 100;
const HISTORY_SIZE = 5;
const DEAD_ZONE_MS = 50;
const POST_SEEK_DEAD_ZONE_MS = 500;
const POST_SEEK_QUIET_MS = 5000;
const RATE_TIME_CONSTANT_S = 5; // drift/timeConstant scales into the rate delta
const RATE_MIN = 0.9;
const RATE_MAX = 1.1;
const HARD_SEEK_THRESHOLD_MS = 2000;
const HARD_SEEK_THRESHOLD_WHILE_CORRECTING_MS = 3000;
const DIRECTION_STABILITY_SAMPLES = 3;

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
    this.driftHistory = []; // rolling list of most-recent drifts (ms)
  }

  setServerState(position, serverTime, clockSync) {
    this.serverPosition = position;
    this.serverTime = serverTime;
    this.clockSync = clockSync;
    // State moved; drift history is stale
    this.driftHistory = [];
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
    const driftMs = (localPosition - expectedPosition) * 1000;

    // Rolling median filter to smooth out per-tick noise
    this.driftHistory.push(driftMs);
    if (this.driftHistory.length > HISTORY_SIZE) this.driftHistory.shift();

    const medianDriftMs = median(this.driftHistory);
    const absMedian = Math.abs(medianDriftMs);

    const postSeek = Date.now() - this.lastHardSeekAt < POST_SEEK_QUIET_MS;
    const deadZone = postSeek ? POST_SEEK_DEAD_ZONE_MS : DEAD_ZONE_MS;
    const hardSeekThreshold = this.isRateCorrecting
      ? HARD_SEEK_THRESHOLD_WHILE_CORRECTING_MS
      : HARD_SEEK_THRESHOLD_MS;

    // -----------------------------------------------------------------
    // Hard-seek path: confirm with a fresh clock sync before snapping.
    // -----------------------------------------------------------------
    if (absMedian >= hardSeekThreshold) {
      if (this.clockSync.resync) {
        this.resyncInFlight = true;
        this.clockSync
          .resync(3)
          .catch(() => {})
          .finally(() => {
            this.resyncInFlight = false;
            // Re-check drift on the next tick with the fresh offset;
            // no action here — let the loop decide.
          });
        return;
      }

      this._applyHardSeek(expectedPosition);
      return;
    }

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
