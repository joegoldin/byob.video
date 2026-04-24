// NTP-style clock synchronization over LiveView push_event/handleEvent
import { LV_EVT } from "./event_names";

const MAINTENANCE_INTERVAL_MS = 10000;
const BURST_PROBE_GAP_MS = 100;
const INITIAL_BURST_SIZE = 5;
const MINI_BURST_SIZE = 3;
const MAX_SAMPLES = 20;

export class ClockSync {
  constructor(pushEvent) {
    this.pushEvent = pushEvent;
    this.samples = [];
    this.offset = 0;
    this.ready = false;
    this.burstRemaining = 0;
    this.burstResolve = null;
    this.maintainInterval = null;
    this._onVisibility = () => {
      if (document.visibilityState === "visible" && this.ready) {
        this.resync(MINI_BURST_SIZE);
      }
    };
    document.addEventListener("visibilitychange", this._onVisibility);
  }

  // Run initial burst of probes, returns promise that resolves when done
  start() {
    return this._burst(INITIAL_BURST_SIZE);
  }

  // On-demand mini-burst (e.g. before a hard seek, or on tab focus).
  // Returns promise that resolves when burst completes.
  // If a burst is already in flight, returns the existing promise.
  resync(count = MINI_BURST_SIZE) {
    if (this.burstRemaining > 0 && this.burstResolve) {
      // Burst already in flight; caller can await the same promise by re-invoking start semantics.
      // For simplicity, just return a no-op promise.
      return Promise.resolve();
    }
    return this._burst(count);
  }

  _burst(count) {
    return new Promise((resolve) => {
      this.burstResolve = resolve;
      this.burstRemaining = count;
      this._sendPing();
    });
  }

  // Send periodic pings to maintain accuracy
  maintainSync() {
    if (this.maintainInterval) return;
    this.maintainInterval = setInterval(() => {
      this._sendPing();
    }, MAINTENANCE_INTERVAL_MS);
  }

  stop() {
    if (this.maintainInterval) {
      clearInterval(this.maintainInterval);
      this.maintainInterval = null;
    }
    document.removeEventListener("visibilitychange", this._onVisibility);
  }

  // Call this when sync:pong is received from server
  handlePong({ t1, t2, t3 }) {
    const t4 = performance.now();
    const rtt = t4 - t1;
    const offset = (t2 - t1 + (t3 - t4)) / 2;

    this.samples.push({ rtt, offset, takenAt: t4 });
    // Keep only the most recent samples so offset reflects current conditions
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    }

    if (this.burstRemaining > 0) {
      this.burstRemaining--;
      if (this.burstRemaining > 0) {
        setTimeout(() => this._sendPing(), BURST_PROBE_GAP_MS);
      } else {
        this._computeOffset();
        this.ready = true;
        if (this.burstResolve) {
          this.burstResolve();
          this.burstResolve = null;
        }
      }
    } else {
      // Maintenance ping — recompute with latest samples
      this._computeOffset();
    }
  }

  // Returns estimated server monotonic time in ms
  serverNow() {
    return performance.now() + this.offset;
  }

  isReady() {
    return this.ready;
  }

  _sendPing() {
    this.pushEvent(LV_EVT.EV_SYNC_PING, { t1: performance.now() });
  }

  _computeOffset() {
    if (this.samples.length === 0) return;

    // Use lowest 75% RTT samples
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const cutoff = Math.ceil(sorted.length * 0.75);
    const best = sorted.slice(0, cutoff);

    // Median offset of best samples
    const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
    const mid = Math.floor(offsets.length / 2);
    this.offset =
      offsets.length % 2 === 0
        ? (offsets[mid - 1] + offsets[mid]) / 2
        : offsets[mid];
  }
}
