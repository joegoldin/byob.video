// Drift correction loop with playbackRate adjustment and hard seek
// Thresholds: do-nothing < 100ms, rate-correct 100-500ms, hard-seek > 500ms

export class Reconcile {
  constructor(playerAdapter) {
    // playerAdapter: { getCurrentTime(), seekTo(seconds), setPlaybackRate(rate) }
    this.player = playerAdapter;
    this.clockSync = null;
    this.serverPosition = 0; // seconds
    this.serverTime = 0; // ms (server monotonic)
    this.interval = null;
    this.isRateCorrecting = false;
    this.lastHardSeekAt = 0; // timestamp of last hard seek
  }

  setServerState(position, serverTime, clockSync) {
    this.serverPosition = position;
    this.serverTime = serverTime;
    this.clockSync = clockSync;
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
    } catch (_) {
      // player may be destroyed
    }
  }

  _tick() {
    if (!this.clockSync || !this.clockSync.isReady()) return;

    const now = this.clockSync.serverNow();
    const elapsed = (now - this.serverTime) / 1000;
    const expectedPosition = this.serverPosition + elapsed;
    const localPosition = this.player.getCurrentTime();
    const driftMs = (localPosition - expectedPosition) * 1000;
    const absDrift = Math.abs(driftMs);

    // Hysteresis: widen hard-seek threshold while rate-correcting,
    // narrow rate-correct re-entry after a recent hard seek
    const hardSeekThreshold = this.isRateCorrecting ? 1000 : 500;
    const rateCorrectionThreshold =
      Date.now() - this.lastHardSeekAt < 3000 ? 300 : 100;

    if (absDrift >= hardSeekThreshold) {
      // Hard seek
      this.player.seekTo(expectedPosition);
      this.player.setPlaybackRate(1.0);
      this.isRateCorrecting = false;
      this.lastHardSeekAt = Date.now();
    } else if (absDrift >= rateCorrectionThreshold) {
      // Rate correction: slow down if ahead, speed up if behind
      const rate = driftMs > 0 ? 0.95 : 1.05;
      this.player.setPlaybackRate(rate);
      this.isRateCorrecting = true;
    } else if (absDrift < 100) {
      // Within tolerance
      if (this.isRateCorrecting) {
        this.player.setPlaybackRate(1.0);
        this.isRateCorrecting = false;
      }
    }
  }
}
