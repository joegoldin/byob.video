// Updates the #round-timer-label element every 250ms with the remaining
// seconds until `data-expires-at` (server monotonic ms). We compute
// `server_now = server_time + (Date.now() - mountedLocalTime)` — i.e. we
// take the server time reported at render and advance it by our local
// wallclock delta. That's close enough for this countdown since it
// doesn't need sub-second precision.

const RoundTimer = {
  mounted() { this._setup(); },
  updated() { this._setup(); },
  destroyed() {
    if (this._interval) clearInterval(this._interval);
  },

  _setup() {
    if (this._interval) clearInterval(this._interval);

    const expires = parseInt(this.el.dataset.expiresAt || "0", 10);
    const serverTime = parseInt(this.el.dataset.serverTime || "0", 10);
    const phase = this.el.dataset.phase || "active";

    if (!expires || !serverTime || phase !== "active") return;

    const mounted = Date.now();
    const label = this.el.querySelector("#round-timer-label");
    if (!label) return;

    const tick = () => {
      const serverNow = serverTime + (Date.now() - mounted);
      const remaining = Math.max(0, expires - serverNow);
      const secs = Math.ceil(remaining / 1000);
      label.textContent = secs > 0 ? `${secs}s` : "—";
      if (remaining <= 0) {
        clearInterval(this._interval);
      }
    };

    tick();
    this._interval = setInterval(tick, 250);
  },
};

export default RoundTimer;
