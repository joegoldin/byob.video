// Drift correction loop with playbackRate adjustment and hard seek
// Thresholds: do-nothing < 100ms, rate-correct 100-2000ms, hard-seek > 2000ms

export class Reconcile {
  constructor(playerAdapter) {
    // playerAdapter: { getCurrentTime(), seekTo(seconds), setPlaybackRate(rate) }
    this.player = playerAdapter;
    this.clockSync = null;
    this.serverPosition = 0; // seconds
    this.serverTime = 0; // ms (server monotonic)
    this.interval = null;
    this.isRateCorrecting = false;
    this.lastHardSeekAt = 0;
    this.pausedUntil = 0; // temporarily disable reconcile
  }

  setServerState(position, serverTime, clockSync) {
    this.serverPosition = position;
    this.serverTime = serverTime;
    this.clockSync = clockSync;
  }

  // Temporarily pause reconcile (e.g., during local seek)
  pauseFor(ms) {
    this.pausedUntil = Date.now() + ms;
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this._tick(), 100);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRateCorrecting = false;
    try {
      this.player.setPlaybackRate(1.0);
    } catch (_) {}
  }

  _tick() {
    if (!this.clockSync || !this.clockSync.isReady()) return;
    if (Date.now() < this.pausedUntil) return;

    const now = this.clockSync.serverNow();
    const elapsed = (now - this.serverTime) / 1000;
    const expectedPosition = this.serverPosition + elapsed;
    const localPosition = this.player.getCurrentTime();
    const driftMs = (localPosition - expectedPosition) * 1000;
    const absDrift = Math.abs(driftMs);

    const hardSeekThreshold = this.isRateCorrecting ? 3000 : 2000;
    const rateCorrectionThreshold =
      Date.now() - this.lastHardSeekAt < 5000 ? 500 : 100;

    if (absDrift >= hardSeekThreshold) {
      this.player.seekTo(expectedPosition);
      this.player.setPlaybackRate(1.0);
      this.isRateCorrecting = false;
      this.lastHardSeekAt = Date.now();
    } else if (absDrift >= rateCorrectionThreshold) {
      const rate = driftMs > 0 ? 0.95 : 1.05;
      this.player.setPlaybackRate(rate);
      this.isRateCorrecting = true;
    } else if (absDrift < 100) {
      if (this.isRateCorrecting) {
        this.player.setPlaybackRate(1.0);
        this.isRateCorrecting = false;
      }
    }
  }
}
