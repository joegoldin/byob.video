// Roulette animation:
//
//   PREROLL  — Wheel is visible from the start with empty slices (just a
//              fallback color). One candidate card at a time is shown
//              centered over the wheel; after a brief pause it scales
//              down and slides into its target slice. Simultaneously
//              that slice's thumbnail + title fade in. Next card starts
//              as the previous finishes, so it reads as a procession.
//   SPIN     — Ball orbits the outer track.
//   LANDING  — On `round:spin_land`, apply exponential angular friction
//              ω(t) = ω₀·e^-kt + inward spiral so the ball decelerates
//              into its target slice like real physics. `k` and `ω₀`
//              are solved to hit the server-chosen slice exactly at the
//              end of the land duration.
//   SETTLE   — Small damped oscillation — the ball drops into the pocket.

const CARD_DISPLAY_MS = 200;       // time card sits centered before flying
const CARD_FLY_MS = 380;           // card travel + scale-down duration
const CARD_STAGGER_MS = 220;       // time between cards
const POST_PREROLL_PAUSE_MS = 250;

const MIN_LANDING_MS = 3000;
const MAX_LANDING_MS = 3600;
const SETTLE_MS = 400;
const FINALIZE_PIE_MS = 2500;      // must fit inside server's reveal_delay_roulette_ms
                                   // minus MAX_LANDING_MS + SETTLE_MS.

const SPIN_V0_MIN = 540;
const SPIN_V0_RANDOMIZE = 280;

const CENTER = 100;
const OUTER_R = 96;
const INNER_R = 78;
const POCKET_BOUNCE_DEG = 3;

const RouletteWheel = {
  mounted() { this._boot(); },
  updated() {},
  destroyed() { this._teardown(); },

  _boot() {
    this._slices = parseInt(this.el.dataset.slices || "12", 10);
    this._sliceDeg = 360 / this._slices;

    this._ball = this.el.querySelector("#roulette-ball");
    this._status = this.el.querySelector("#roulette-status");
    this._cards = Array.from(this.el.querySelectorAll(".roulette-card"));
    this._thumbs = this.el.querySelectorAll(".slice-thumb");
    this._darks = this.el.querySelectorAll(".slice-dark");
    this._texts = this.el.querySelectorAll(".slice-text");
    this._pie = this.el.querySelector("#roulette-pie");
    this._pieLabel = this.el.querySelector("#roulette-pie-label");
    this._pendingLand = null;
    this._prerollTimers = [];
    this._pieFrame = null;

    this._phase = "preroll";
    if (this._status) this._status.textContent = "candidates…";

    this._startPreroll();

    this.handleEvent("round:spin_land", ({ seed }) => {
      if (this._phase === "preroll") {
        // If the server's land event arrives before preroll finishes
        // (short client / fast server), stash and apply after preroll.
        this._pendingLand = seed;
      } else {
        this._beginLanding(seed);
      }
    });

    this.handleEvent("round:cleanup", () => this._teardown());
  },

  _teardown() {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._pieFrame) cancelAnimationFrame(this._pieFrame);
    this._prerollTimers.forEach((t) => clearTimeout(t));
    this._prerollTimers = [];
    this._phase = "done";
  },

  // --- PREROLL: cards fly into slices one at a time ---

  _startPreroll() {
    this._cards.forEach((card, i) => this._scheduleCard(card, i));

    const totalMs = this._cards.length * CARD_STAGGER_MS + CARD_DISPLAY_MS + CARD_FLY_MS;

    const endTimer = setTimeout(() => {
      if (this._status) this._status.textContent = "spinning…";
      setTimeout(() => this._startSpinning(), POST_PREROLL_PAUSE_MS);
    }, totalMs);

    this._prerollTimers.push(endTimer);
  },

  _scheduleCard(card, i) {
    const showAt = i * CARD_STAGGER_MS;

    const showTimer = setTimeout(() => {
      // Show card at center, full size
      card.style.transition =
        "opacity 180ms ease-out, transform 240ms cubic-bezier(.2,1.2,.4,1)";
      card.style.opacity = "1";
      card.style.transform = "translate(-50%, -50%) scale(1)";
    }, showAt);

    const flyAt = showAt + CARD_DISPLAY_MS;
    const flyTimer = setTimeout(() => this._flyCardToSlice(card), flyAt);

    this._prerollTimers.push(showTimer, flyTimer);
  },

  _flyCardToSlice(card) {
    const idx = parseInt(card.dataset.sliceIndex || "0", 10);

    // The card sits at (left:50%, top:50%) offset by -50%/-50%. The target
    // slice center, in SVG coord-space, is (100 + 50·cos θ, 100 + 50·sin θ).
    // Data attrs encode that as a fraction of the SVG's 200-unit width/height
    // relative to the center: `target_x` = (cx - 100)/200 * 100, etc.
    //
    // We want to translate the card from (-50%, -50%) of its own size (the
    // centering transform) toward the slice's relative offset measured in
    // percent of the container width. Container is a square equal in size
    // to the SVG's rendered width, so that relative offset works directly.

    const tx = parseFloat(card.dataset.targetX || "0");
    const ty = parseFloat(card.dataset.targetY || "0");

    card.style.transition =
      `opacity 220ms ease-in ${CARD_FLY_MS - 200}ms, transform ${CARD_FLY_MS}ms cubic-bezier(.45,.02,.55,.95)`;

    // Final transform: slide to the slice's position (expressed in container %)
    // and scale way down so it visually merges into the slice. Opacity fades
    // toward the end.
    card.style.transform = `translate(calc(-50% + ${tx}%), calc(-50% + ${ty}%)) scale(0.18)`;
    card.style.opacity = "0";

    // Reveal the slice content at the same time the card reaches it.
    setTimeout(() => {
      this._revealSlice(idx);
    }, CARD_FLY_MS - 160);
  },

  _revealSlice(idx) {
    const thumb = this.el.querySelector(`.slice-thumb[data-slice-index="${idx}"]`);
    const dark = this.el.querySelector(`.slice-dark[data-slice-index="${idx}"]`);
    const text = this.el.querySelector(`.slice-text[data-slice-index="${idx}"]`);
    if (thumb) thumb.style.opacity = "1";
    if (dark) dark.style.opacity = "0.4";
    if (text) text.style.opacity = "1";
  },

  // --- SPIN + PHYSICS LANDING ---

  _startSpinning() {
    if (this._phase === "done") return;
    this._phase = "spinning";

    this._angle = -90;
    this._radius = OUTER_R;
    this._velocity = SPIN_V0_MIN + Math.random() * SPIN_V0_RANDOMIZE;
    this._lastTs = 0;

    if (this._ball) this._ball.style.opacity = "1";

    this._loop = (ts) => {
      if (!this._lastTs) this._lastTs = ts;
      const dt = (ts - this._lastTs) / 1000;
      this._lastTs = ts;

      if (this._phase === "spinning") {
        this._angle = this._angle + this._velocity * dt;
        this._applyBall(this._angle, this._radius);
        this._raf = requestAnimationFrame(this._loop);
      } else if (this._phase === "landing") {
        this._tickLanding(ts);
      } else if (this._phase === "settling") {
        this._tickSettling(ts);
      }
    };

    this._raf = requestAnimationFrame(this._loop);

    if (this._pendingLand != null) {
      const seed = this._pendingLand;
      this._pendingLand = null;
      // Give the spin a beat before deceleration starts.
      setTimeout(() => this._beginLanding(seed), 300);
    }
  },

  _beginLanding(seed) {
    if (typeof seed !== "number") return;
    if (this._phase !== "spinning") {
      this._pendingLand = seed;
      return;
    }

    const winningSlice = seed % this._slices;
    const targetCenterAngle = -90 + (winningSlice + 0.5) * this._sliceDeg;

    const current = this._angle;
    const relative = wrap360(targetCenterAngle - current);
    const totalDelta = 2 * 360 + relative;

    const durationMs =
      MIN_LANDING_MS + Math.random() * (MAX_LANDING_MS - MIN_LANDING_MS);
    const durationS = durationMs / 1000;

    // Decay constant chosen so ω decays to ~2% at t=T.
    const kT = 4;
    const k = kT / durationS;
    const decayFactor = 1 - Math.exp(-kT);
    const requiredV0 = (totalDelta * k) / decayFactor;

    this._land = {
      startTs: performance.now(),
      durationMs,
      k,
      v0: requiredV0,
      theta0: current,
      targetAngle: current + totalDelta,
    };
    this._winningSlice = winningSlice;

    this._phase = "landing";
    if (this._status) this._status.textContent = "settling…";
  },

  _tickLanding(ts) {
    const L = this._land;
    const t = (ts - L.startTs) / 1000;
    const T = L.durationMs / 1000;

    if (t < T) {
      const exp = Math.exp(-L.k * t);
      const theta = L.theta0 + (L.v0 / L.k) * (1 - exp);
      const progress = 1 - exp;
      const radius = OUTER_R - (OUTER_R - INNER_R) * progress;

      this._angle = theta;
      this._radius = radius;
      this._applyBall(theta, radius);
      this._raf = requestAnimationFrame(this._loop);
    } else {
      this._settle = {
        startTs: performance.now(),
        baseAngle: L.targetAngle,
      };
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
    }
  },

  _pulseWinnerSlice() {
    if (this._winningSlice == null) return;

    // Reveal the winner outline (was kept invisible during landing so the
    // yellow ring didn't precede the ball).
    const outline = this.el.querySelector(
      `.slice-winner-outline[data-slice-index="${this._winningSlice}"]`
    );
    if (outline) outline.style.opacity = "1";

    // Add the class that triggers the glow keyframe.
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

function wrap360(d) {
  return ((d % 360) + 360) % 360;
}

export default RouletteWheel;
