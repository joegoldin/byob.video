// Roulette animation, four visual phases:
//
//   LOADING  — 3s "preparing candidates…" overlay. Gives everyone time to
//              read the header and scroll down; nothing moves yet.
//   PREVIEW  — cards fly one-by-one into their slices with a stagger; each
//              card reveals its slice's thumbnail+title on arrival.
//   LANDING  — on server `round:spin_land`, the ball appears at angle 0°
//              (top of wheel) at high velocity and decays via
//              ω(t) = ω₀·e^-kt. v₀ and k are both derived directly from
//              the server-broadcast `seed`, and the identical formula
//              runs in Elixir (Round.simulate_landing_slice/2) so
//              client + server agree bit-for-bit on the winning slice.
//   SETTLE   — small damped wobble (pocket bounce) + pie-slice countdown
//              until the server finalizes and enqueues the winner.
//
// The winner slice is *determined by the physics* — server runs the same
// sim to decide who to enqueue, rather than picking randomly and then
// animating toward that pick.

const LOADING_MS = 3000;
const CARD_DISPLAY_MS = 200;
const CARD_FLY_MS = 380;
const CARD_STAGGER_MS = 220;
const POST_PREROLL_PAUSE_MS = 300;

const SETTLE_MS = 500;
const FINALIZE_PIE_MS = 2500;

const CENTER = 100;
const OUTER_R = 96;
const INNER_R = 78;
const POCKET_BOUNCE_DEG = 4;

// Physics params derived from seed. Keep these in sync with
// `Byob.RoomServer.Round.simulate_landing_slice/2` in the Elixir server.
function derivePhysics(seed) {
  const v0Frac = (seed % 65536) / 65536;
  const v0 = 540 + v0Frac * 280;
  const durFrac = (Math.floor(seed / 65536) % 65536) / 65536;
  const duration = 3.0 + durFrac * 0.6;
  const k = 4.0 / duration;
  return { v0, duration, k };
}

const RouletteWheel = {
  mounted() { this._boot(); },
  updated() {},
  destroyed() { this._teardown(); },

  _boot() {
    this._slices = parseInt(this.el.dataset.slices || "12", 10);
    this._sliceDeg = 360 / this._slices;

    this._ball = this.el.querySelector("#roulette-ball");
    this._status = this.el.querySelector("#roulette-status");
    this._loading = this.el.querySelector("#roulette-loading");
    this._cards = Array.from(this.el.querySelectorAll(".roulette-card"));
    this._pie = this.el.querySelector("#roulette-pie");
    this._pieLabel = this.el.querySelector("#roulette-pie-label");
    this._pendingSeed = null;
    this._timers = [];
    this._pieFrame = null;
    this._raf = null;

    this._phase = "loading";
    if (this._status) this._status.textContent = "getting ready…";

    this._runLoading();

    this.handleEvent("round:spin_land", ({ seed }) => {
      if (typeof seed !== "number") return;

      // If we're still in loading or preview when server sends land, stash
      // the seed and let the preroll finish.
      if (this._phase === "loading" || this._phase === "preview") {
        this._pendingSeed = seed;
      } else {
        this._beginLanding(seed);
      }
    });

    this.handleEvent("round:cleanup", () => this._teardown());
  },

  _teardown() {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._pieFrame) cancelAnimationFrame(this._pieFrame);
    this._timers.forEach((t) => clearTimeout(t));
    this._timers = [];
    this._phase = "done";
  },

  // --- LOADING ---

  _runLoading() {
    // Loading overlay is rendered with opacity:1 by default; we fade it
    // after LOADING_MS, then start the preview phase.
    const t = setTimeout(() => {
      if (this._phase !== "loading") return;
      if (this._loading) this._loading.style.opacity = "0";
      this._startPreview();
    }, LOADING_MS);
    this._timers.push(t);
  },


  // --- PREVIEW: cards fly into slices ---

  _startPreview() {
    this._phase = "preview";
    if (this._status) this._status.textContent = "candidates…";

    this._cards.forEach((card, i) => this._scheduleCard(card, i));

    const totalMs = this._cards.length * CARD_STAGGER_MS + CARD_DISPLAY_MS + CARD_FLY_MS;
    const endTimer = setTimeout(() => this._afterPreview(), totalMs);
    this._timers.push(endTimer);
  },

  _scheduleCard(card, i) {
    const showAt = i * CARD_STAGGER_MS;

    const showTimer = setTimeout(() => {
      card.style.transition =
        "opacity 180ms ease-out, transform 240ms cubic-bezier(.2,1.2,.4,1)";
      card.style.opacity = "1";
      card.style.transform = "translate(-50%, -50%) scale(1)";
    }, showAt);

    const flyAt = showAt + CARD_DISPLAY_MS;
    const flyTimer = setTimeout(() => this._flyCardToSlice(card), flyAt);

    this._timers.push(showTimer, flyTimer);
  },

  _flyCardToSlice(card) {
    const idx = parseInt(card.dataset.sliceIndex || "0", 10);
    const tx = parseFloat(card.dataset.targetX || "0");
    const ty = parseFloat(card.dataset.targetY || "0");

    card.style.transition =
      `opacity 220ms ease-in ${CARD_FLY_MS - 200}ms, transform ${CARD_FLY_MS}ms cubic-bezier(.45,.02,.55,.95)`;

    card.style.transform = `translate(calc(-50% + ${tx}%), calc(-50% + ${ty}%)) scale(0.18)`;
    card.style.opacity = "0";

    setTimeout(() => this._revealSlice(idx), CARD_FLY_MS - 160);
  },

  _revealSlice(idx) {
    const thumb = this.el.querySelector(`.slice-thumb[data-slice-index="${idx}"]`);
    const dark = this.el.querySelector(`.slice-dark[data-slice-index="${idx}"]`);
    const text = this.el.querySelector(`.slice-text[data-slice-index="${idx}"]`);
    if (thumb) thumb.style.opacity = "1";
    if (dark) dark.style.opacity = "0.4";
    if (text) text.style.opacity = "1";
  },

  _afterPreview() {
    if (this._status) this._status.textContent = "any second now…";

    // If the server's `round:spin_land` has already arrived, kick off
    // landing after a brief pause so users see the fully-populated wheel.
    const t = setTimeout(() => {
      if (this._pendingSeed != null) {
        const seed = this._pendingSeed;
        this._pendingSeed = null;
        this._beginLanding(seed);
      } else {
        this._phase = "waiting";
      }
    }, POST_PREROLL_PAUSE_MS);
    this._timers.push(t);
  },

  // --- LANDING: physics-driven, seed-deterministic ---

  _beginLanding(seed) {
    const { v0, duration, k } = derivePhysics(seed);

    // Start ball at 0° (12 o'clock). In SVG coords where 0° = +X and
    // clockwise is +Y, 12 o'clock = -90°. Keep everything in degrees.
    this._land = {
      startTs: performance.now(),
      durationMs: duration * 1000,
      k,                   // 1/s
      v0,                  // deg/s
      theta0: -90,
      seed,
    };
    this._winningSlice = this._simulateSlice(seed);

    this._phase = "landing";
    if (this._status) this._status.textContent = "rolling…";
    if (this._ball) this._ball.style.opacity = "1";
    this._applyBall(-90, OUTER_R);

    const loop = (ts) => {
      if (this._phase === "landing") {
        this._tickLanding(ts);
      } else if (this._phase === "settling") {
        this._tickSettling(ts);
      }
    };
    this._loop = loop;
    this._raf = requestAnimationFrame(loop);
  },

  _simulateSlice(seed) {
    const { v0, duration, k } = derivePhysics(seed);
    const totalRotation = (v0 / k) * (1 - Math.exp(-4.0));
    let wrapped = totalRotation % 360;
    if (wrapped < 0) wrapped += 360;
    const slice = Math.floor(wrapped / this._sliceDeg);
    return slice % this._slices;
  },

  _tickLanding(ts) {
    const L = this._land;
    const t = (ts - L.startTs) / 1000;
    const T = L.durationMs / 1000;

    if (t < T) {
      // Physics: θ(t) = θ₀ + (v₀/k)(1 - e^-kt)
      const exp = Math.exp(-L.k * t);
      const theta = L.theta0 + (L.v0 / L.k) * (1 - exp);

      // Inward spiral: ball leaves outer track as it slows, ending on
      // the inner pocket radius.
      const progress = 1 - exp;
      const radius = OUTER_R - (OUTER_R - INNER_R) * progress;

      this._angle = theta;
      this._radius = radius;
      this._applyBall(theta, radius);
      this._raf = requestAnimationFrame(this._loop);
    } else {
      // Landing finished — ball has effectively stopped. Begin settle.
      // The final resting angle (as t→∞) is theta0 + v0/k.
      const finalAngle = L.theta0 + L.v0 / L.k;
      this._settle = { startTs: performance.now(), baseAngle: finalAngle };
      this._phase = "settling";
      this._raf = requestAnimationFrame(this._loop);
    }
  },

  _tickSettling(ts) {
    const S = this._settle;
    const t = (ts - S.startTs) / 1000;
    const T = SETTLE_MS / 1000;

    if (t < T) {
      const progress = t / T;
      const damp = Math.pow(1 - progress, 2);
      const wobble = Math.sin(progress * Math.PI * 4) * POCKET_BOUNCE_DEG * damp;
      this._applyBall(S.baseAngle + wobble, INNER_R);
      this._raf = requestAnimationFrame(this._loop);
    } else {
      this._applyBall(S.baseAngle, INNER_R);
      this._phase = "landed";
      if (this._status) this._status.textContent = "winner!";
      this._pulseWinnerSlice();
      this._startFinalizePie();
      // Reveal the winner text now that the animation has completed
      const winnerText = document.getElementById("roulette-winner-text");
      if (winnerText) winnerText.classList.remove("hidden");
    }
  },

  _pulseWinnerSlice() {
    if (this._winningSlice == null) return;
    const outline = this.el.querySelector(
      `.slice-winner-outline[data-slice-index="${this._winningSlice}"]`
    );
    if (outline) outline.style.opacity = "1";

    const sliceGroup = this.el.querySelector(
      `.wheel-slice[data-slice-index="${this._winningSlice}"]`
    );
    if (sliceGroup) sliceGroup.classList.add("wheel-slice-win");
  },

  _startFinalizePie() {
    if (!this._pie) return;
    this._pie.style.opacity = "1";
    const startTs = performance.now();

    const tick = () => {
      const elapsed = performance.now() - startTs;
      const ratio = Math.min(1, elapsed / FINALIZE_PIE_MS);
      const angle = ratio * 360;
      this._pie.style.setProperty("--byob-roulette-pie-angle", angle + "deg");
      const remaining = Math.max(0, Math.ceil((FINALIZE_PIE_MS - elapsed) / 1000));
      if (this._pieLabel) this._pieLabel.textContent = remaining;
      if (ratio < 1) {
        this._pieFrame = requestAnimationFrame(tick);
      }
    };
    this._pieFrame = requestAnimationFrame(tick);
  },

  _applyBall(angleDeg, radius) {
    if (!this._ball) return;
    const rad = (angleDeg * Math.PI) / 180;
    const x = CENTER + radius * Math.cos(rad);
    const y = CENTER + radius * Math.sin(rad);
    this._ball.setAttribute("cx", x.toFixed(2));
    this._ball.setAttribute("cy", y.toFixed(2));
  },
};

export default RouletteWheel;
