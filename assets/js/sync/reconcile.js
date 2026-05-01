// Drift measurement loop — server-authoritative model.
//
// Reconcile is now passive: it measures drift and jitter every tick and
// reports them via `getReport()`. The decision of when (and where) to
// seek lives on the server (`Byob.SyncDecision` in lib/byob/), which
// pushes `sync:seek_command` events the player executes via
// `executeSeek(target, server_time)`.
//
// What stays client-side:
//   * NTP-style clockSync (each client has its own clock; can't centralize)
//   * Position measurement via player.getCurrentTime()
//   * Drift = local − expected, computed from the canonical server
//     reference passed in via `setServerState`
//   * Jitter EMA: |Δdrift| per tick — sent to server so it can compute
//     the room consensus and per-client tolerance
//
// What moved to the server:
//   * Tolerance computation (K × jitter, clamps, post-seek bumps)
//   * Sustained-drift gating (over_tolerance counter)
//   * Cooldown ladder (1, 2, 4, 5 s caps + streak reset)
//   * Adaptive L learning (each device's seek processing time)
//   * Seek target = expected_now + (rtt/2 + learned_L)/1000

const TICK_MS = 100;
const NOISE_EMA_ALPHA = 0.1;     // ~1 s horizon
const POST_SEEK_QUIET_MS = 5000; // don't update jitter EMA for 5 s after a seek

export class Reconcile {
  constructor(playerAdapter) {
    // playerAdapter: { getCurrentTime(), seekTo(seconds), setPlaybackRate(rate) }
    this.player = playerAdapter;
    this.clockSync = null;
    this.serverPosition = 0; // seconds
    this.serverTime = 0;     // ms (server monotonic)
    this.interval = null;
    this.pausedUntil = 0;

    // Jitter EMA — tick-to-tick |Δdrift|. Reported to server every drift
    // report; server uses max(local, room) × K for tolerance.
    this.noiseFloorEmaMs = 0;
    this.noiseSamples = 0;

    // Latest drift reading. Reported to server.
    this.lastDriftMs = 0;
    // Last seek time (local) so we can pause jitter learning briefly
    // post-seek (the seek itself produces a big Δdrift that isn't real
    // network noise).
    this.lastExecutedSeekAt = 0;
  }

  setServerState(position, serverTime, clockSync, _opts = {}) {
    this.serverPosition = position;
    this.serverTime = serverTime;
    this.clockSync = clockSync;
  }

  // Legacy shim — server now owns room consensus. Stays for back-compat
  // with the existing video_player.js handler that still calls it.
  setRoomTolerance(_args = {}) {
    // No-op. Server already has all the data.
  }

  // Snapshot used by stats panel and drift report.
  getReport() {
    return {
      driftMs: this.lastDriftMs,
      noiseFloorMs: this.noiseFloorEmaMs,
    };
  }

  // Legacy shims kept so callers don't break. These all return 0 / no-op
  // because the server owns the equivalent state now.
  getOffsetMs() { return 0; }
  resetOffset() {}
  getEffectiveThresholds() {
    return {
      toleranceMs: 0,
      noiseFloorMs: this.noiseFloorEmaMs,
      roomJitterMs: 0,
      roomMaxDriftMs: 0,
      postSeek: Date.now() - this.lastExecutedSeekAt < POST_SEEK_QUIET_MS,
      seekStreak: 0,
      cooldownRemainingMs: 0,
    };
  }

  // Called when the server pushes `sync:seek_command`. Server has already
  // computed the right target (with rtt/2 + learned_L compensation) so we
  // just trust it and seek. Pause reconcile briefly so the seek's own
  // big Δdrift doesn't poison the jitter EMA.
  executeSeek(targetPosition, serverTime) {
    // Optional: factor in *any* additional in-flight time between server's
    // server_time stamp and now. clockSync.serverNow() gives server-time-
    // estimate now; the difference is the leftover travel slop that
    // wasn't captured by server's rtt/2 estimate.
    let adjusted = targetPosition;
    if (this.clockSync?.isReady?.() && typeof serverTime === "number") {
      const slopMs = Math.max(0, this.clockSync.serverNow() - serverTime);
      adjusted += slopMs / 1000;
    }

    const target = Math.max(0, adjusted);
    this.player.seekTo(target);
    this.lastExecutedSeekAt = Date.now();
    // Don't reset noise/drift — we want to keep measuring continuously
    // for the server's adaptive L learning.
  }

  // Temporarily disable measurement (e.g., during a local seek the user
  // initiated, so we don't push misleading data while the player resettles).
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
    this.lastDriftMs = 0;
    this.lastExecutedSeekAt = 0;
    try { this.player.setPlaybackRate(1.0); } catch (_) {}
  }

  // Just measure: drift + jitter. Send report to server (handled by the
  // VideoPlayer hook's existing 1 Hz interval). Server decides.
  _tick() {
    if (!this.clockSync || !this.clockSync.isReady()) return;
    if (Date.now() < this.pausedUntil) return;

    const now = this.clockSync.serverNow();
    const elapsed = (now - this.serverTime) / 1000;
    const expectedPosition = this.serverPosition + elapsed;
    const localPosition = this.player.getCurrentTime();
    const driftMs = (localPosition - expectedPosition) * 1000;

    // Jitter EMA. Skip during the post-seek quiet window — the giant
    // Δdrift from the seek itself isn't real noise and would inflate the
    // EMA, widening the tolerance and starving subsequent corrections.
    const inPostSeekQuiet = Date.now() - this.lastExecutedSeekAt < POST_SEEK_QUIET_MS;
    if (this.noiseSamples > 0 && !inPostSeekQuiet) {
      const tickDelta = Math.abs(driftMs - this.lastDriftMs);
      this.noiseFloorEmaMs =
        NOISE_EMA_ALPHA * tickDelta + (1 - NOISE_EMA_ALPHA) * this.noiseFloorEmaMs;
    }
    this.noiseSamples++;
    this.lastDriftMs = driftMs;
  }
}
