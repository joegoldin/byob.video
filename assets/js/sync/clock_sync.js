// NTP-style clock synchronization over LiveView push_event/handleEvent
export class ClockSync {
  constructor(pushEvent) {
    this.pushEvent = pushEvent;
    this.samples = [];
    this.offset = 0;
    this.ready = false;
    this.burstRemaining = 0;
    this.burstResolve = null;
    this.maintainInterval = null;
  }

  // Run initial burst of 5 probes, returns promise that resolves when done
  start() {
    return new Promise((resolve) => {
      this.burstResolve = resolve;
      this.burstRemaining = 5;
      this._sendPing();
    });
  }

  // Send periodic pings every 30s to maintain accuracy
  maintainSync() {
    this.maintainInterval = setInterval(() => {
      this._sendPing();
    }, 30000);
  }

  stop() {
    if (this.maintainInterval) {
      clearInterval(this.maintainInterval);
      this.maintainInterval = null;
    }
  }

  // Call this when sync:pong is received from server
  handlePong({ t1, t2, t3 }) {
    const t4 = performance.now();
    const rtt = t4 - t1;
    const offset = (t2 - t1 + (t3 - t4)) / 2;

    this.samples.push({ rtt, offset });

    if (this.burstRemaining > 0) {
      this.burstRemaining--;
      if (this.burstRemaining > 0) {
        setTimeout(() => this._sendPing(), 100);
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
    this.pushEvent("sync:ping", { t1: performance.now() });
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
