// StatsPanel hook — visualizes RTT / drift / offset over time inside the
// "Stats for nerds" details panel. Pure inline-SVG rendering; no chart libs.
//
// Data flow:
//   * Server pushes a `sync:client_stats` event for every drift report from
//     any peer (1 Hz / peer). We append it to a per-peer ring buffer.
//   * On each event we redraw:
//       - the local multi-line chart (RTT + drift + offset for *this* user)
//       - the sparkline inside that peer's connected-clients row
//
// The local user is identified by the `data-byob-local-user-id` attribute
// on the hook's element. We match incoming events whose `user_id` starts
// with that value (the broadcast key is `<user_id>:<tab>` but per-tab user
// IDs can themselves be `session:tab` so we just prefix-match the owner).
//
// SVG containers are wrapped in `phx-update="ignore"` so LiveView re-renders
// of the surrounding panel don't clobber our drawings.

import { LV_EVT } from "../sync/event_names";

const RING_SIZE = 60; // 60 samples × 1 Hz = 60 s window
const LOCAL_CHART_W = 360;
const LOCAL_CHART_H = 80;
const SPARK_W = 80;
const SPARK_H = 20;

const COLOR_RTT = "#60a5fa";    // blue
const COLOR_DRIFT = "#fbbf24";  // amber
const COLOR_OFFSET = "#a78bfa"; // violet

const StatsPanel = {
  mounted() {
    // user_key → { drift: number[], rtt: number[], offset: number[] }
    this.rings = new Map();
    this.localUserId = this.el.dataset.byobLocalUserId || "";

    this.handleEvent(LV_EVT.SYNC_CLIENT_STATS, (data) => this._onSample(data));
  },

  destroyed() {
    this.rings.clear();
  },

  _onSample(data) {
    const key = data.key;
    if (!key) return;

    let ring = this.rings.get(key);
    if (!ring) {
      ring = { drift: [], rtt: [], offset: [] };
      this.rings.set(key, ring);
    }
    pushRing(ring.drift, data.drift_ms || 0);
    pushRing(ring.rtt, data.rtt_ms || 0);
    pushRing(ring.offset, data.offset_ms || 0);

    // Per-peer sparkline (drift only — that's what users care about per row).
    const spark = document.querySelector(
      `[data-byob-spark-key="${cssEscape(key)}"]`
    );
    if (spark) {
      renderSparkline(spark, ring.drift);
    }

    // Local multi-line chart + correction-bands diagram. The bands diagram
    // is local-only because it visualizes our own Reconcile state (effective
    // dead zone, hard-seek threshold, rate-correcting flag) — values that
    // hysteresis can grow from their constants and that we want to *see*
    // grow.
    if (this.localUserId && data.user_id === this.localUserId) {
      const chart = document.getElementById("byob-local-sync-chart");
      if (chart) renderLocalChart(chart, ring);
      const bands = document.getElementById("byob-drift-bands");
      if (bands) renderDriftBands(bands, data);
    }
  },
};

function pushRing(arr, value) {
  arr.push(value);
  if (arr.length > RING_SIZE) arr.shift();
}

// Inline-SVG single-line sparkline. Re-renders the whole `<svg>` content
// on each update; cheap at 60 points and 1 Hz. Y-axis is centered at 0
// (drift sign carries meaning); width/height fixed.
function renderSparkline(host, values) {
  if (values.length === 0) {
    host.innerHTML = "";
    return;
  }

  const max = Math.max(50, ...values.map((v) => Math.abs(v)));
  const points = values
    .map((v, i) => {
      const x = (i / (RING_SIZE - 1)) * SPARK_W;
      const y = SPARK_H / 2 - (v / max) * (SPARK_H / 2 - 1);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Color the line by the most recent sample's severity (matches the
  // numeric drift column above it).
  const last = Math.abs(values[values.length - 1]);
  const stroke = last > 1000 ? "#f87171" : last > 250 ? "#fbbf24" : "#34d399";

  // width=100% lets the sparkline stretch to fill its flex-1 container; the
  // viewBox provides a stable coordinate system so polyline points don't
  // need to be recomputed when the row gets wider/narrower.
  host.innerHTML =
    `<svg width="100%" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" style="display:block">` +
    `<line x1="0" y1="${SPARK_H / 2}" x2="${SPARK_W}" y2="${SPARK_H / 2}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>` +
    `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>` +
    `</svg>`;
}

// Multi-line chart: RTT + drift + offset on a shared time axis. Each metric
// is auto-scaled to its own range (no shared y-axis — RTT and drift live in
// very different bands). Drift is rendered with a 0-baseline; RTT and
// offset are rendered as scaled-to-range lines so movement is visible.
function renderLocalChart(host, ring) {
  const segments = [
    {
      key: "rtt",
      label: "RTT",
      values: ring.rtt,
      color: COLOR_RTT,
      // RTT is non-negative; scale full height to max.
      scale: scalePositive,
    },
    {
      key: "drift",
      label: "drift",
      values: ring.drift,
      color: COLOR_DRIFT,
      // Drift is signed; center the axis.
      scale: scaleSigned,
    },
    {
      key: "offset",
      label: "offset",
      values: ring.offset,
      color: COLOR_OFFSET,
      scale: scaleSigned,
    },
  ];

  const lines = segments
    .filter((s) => s.values.length > 0)
    .map((s) => {
      const points = s.scale(s.values, LOCAL_CHART_W, LOCAL_CHART_H);
      return `<polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`;
    })
    .join("");

  // Legend with current values. `last` may be undefined if no samples yet.
  const legend = segments
    .map((s) => {
      const last = s.values.length ? Math.round(s.values[s.values.length - 1]) : "—";
      return (
        `<span style="color:${s.color}">■</span>` +
        ` ${s.label}: <span style="color:${s.color}">${last}${last === "—" ? "" : "ms"}</span>`
      );
    })
    .join(" &nbsp; ");

  host.innerHTML =
    `<svg width="100%" height="${LOCAL_CHART_H}" viewBox="0 0 ${LOCAL_CHART_W} ${LOCAL_CHART_H}" preserveAspectRatio="none" style="display:block;background:rgba(0,0,0,0.15);border-radius:4px">` +
    // Grid baseline at 50% (where signed metrics sit at 0).
    `<line x1="0" y1="${LOCAL_CHART_H / 2}" x2="${LOCAL_CHART_W}" y2="${LOCAL_CHART_H / 2}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>` +
    lines +
    `</svg>` +
    `<div style="font-size:10px;margin-top:2px;opacity:0.7">${legend}</div>`;
}

function scaleSigned(values, w, h) {
  const max = Math.max(50, ...values.map((v) => Math.abs(v)));
  return values
    .map((v, i) => {
      const x = (i / (RING_SIZE - 1)) * w;
      const y = h / 2 - (v / max) * (h / 2 - 1);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function scalePositive(values, w, h) {
  const max = Math.max(20, ...values);
  return values
    .map((v, i) => {
      const x = (i / (RING_SIZE - 1)) * w;
      const y = h - 1 - (v / max) * (h - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

// Horizontal "where on the dial are you" diagram. Three bands across the
// full width:
//
//   [   hard seek   |   rate correct   | dead | rate correct |   hard seek   ]
//                   ^-hardSeek         ^-dead  ^+dead         ^+hardSeek
//
// The active band (the one the current drift falls into) is rendered at full
// opacity; inactive bands at ~25% so the eye snaps to the active one. The
// dead-zone and hard-seek widths come from the *effective* thresholds in the
// payload (50→500ms post-seek, 3000→4000ms while rate-correcting), so when
// hysteresis kicks in the green / amber bands visibly grow.
//
// A vertical tick marks the current drift value; if it falls outside
// ±hardSeek it's clamped to the edge with an overflow arrow.
function renderDriftBands(host, data) {
  const drift = data.drift_ms || 0;
  const dead = Math.max(1, data.dead_zone_ms || 50);
  const hard = Math.max(dead + 1, data.hard_seek_ms || 3000);
  const rateCorrecting = !!data.rate_correcting;

  // Fixed display range: ±2× the current hard-seek threshold so the hard-
  // seek territory is visible even when hysteresis hasn't grown it.
  const displayMax = hard * 2;
  const xFor = (ms) => 50 + (ms / displayMax) * 50; // 0 → 50%, displayMax → 100%

  const xDeadL = xFor(-dead);
  const xDeadR = xFor(dead);
  const xHardL = xFor(-hard);
  const xHardR = xFor(hard);

  const absDrift = Math.abs(drift);
  let active;
  if (absDrift <= dead) active = "dead";
  else if (absDrift <= hard) active = "rate";
  else active = "hard";

  const band = (x1, x2, color, isActive) => {
    const w = Math.max(0, x2 - x1);
    const opacity = isActive ? "0.65" : "0.18";
    return `<rect x="${x1}%" y="0" width="${w}%" height="100%" fill="${color}" fill-opacity="${opacity}"/>`;
  };

  // Outer red (hard seek) zones extend to the chart edges.
  const segs =
    band(0, xHardL, "#f87171", active === "hard") +
    band(xHardL, xDeadL, "#fbbf24", active === "rate") +
    band(xDeadL, xDeadR, "#34d399", active === "dead") +
    band(xDeadR, xHardR, "#fbbf24", active === "rate") +
    band(xHardR, 100, "#f87171", active === "hard");

  // Threshold tick lines (vertical dividers) at ±dead and ±hard so the
  // band edges are legible regardless of opacity.
  const divider = (x) =>
    `<line x1="${x}%" y1="0" x2="${x}%" y2="100%" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>`;

  const dividers =
    divider(xDeadL) + divider(xDeadR) + divider(xHardL) + divider(xHardR);

  // Current-drift indicator (vertical tick with diamond head). Clamped to
  // the chart edges with an arrow if drift exceeds ±displayMax.
  const clamped = Math.max(-displayMax, Math.min(displayMax, drift));
  const tickX = xFor(clamped);
  const overflowed = drift !== clamped;
  const tick =
    `<line x1="${tickX}%" y1="0" x2="${tickX}%" y2="100%" stroke="white" stroke-width="2"/>` +
    (overflowed
      ? `<polygon points="${tickX - 1},2 ${tickX + 1},2 ${tickX + (drift > 0 ? 2 : -2)},6" fill="white" />`
      : "");

  const labelStyle = "font-size:9px;fill:rgba(255,255,255,0.55);font-family:monospace";
  const labelDead = `±${dead}ms`;
  const labelHard = `±${hard}ms`;

  // State chip text — "in dead zone" / "rate-correcting at NN%" / "hard seek
  // pending" / "post-seek widened (NNms dz)" so the user can read off why
  // a band changed size.
  const stateBits = [];
  if (active === "dead") stateBits.push("in sync");
  else if (active === "rate") stateBits.push("rate-correcting");
  else stateBits.push("hard-seek territory");
  if (dead > 50) stateBits.push(`dead zone widened (post-seek): ${dead}ms`);
  if (hard > 3000) stateBits.push(`hard-seek raised (correcting): ${hard}ms`);
  if (rateCorrecting && active !== "rate") stateBits.push("rate active");
  const chipColor =
    active === "dead" ? "#34d399" : active === "rate" ? "#fbbf24" : "#f87171";

  host.innerHTML =
    `<svg width="100%" height="22" viewBox="0 0 100 22" preserveAspectRatio="none" style="display:block;border-radius:3px;background:rgba(0,0,0,0.2)">` +
    segs +
    dividers +
    tick +
    `</svg>` +
    `<div style="display:flex;justify-content:space-between;font-size:9px;opacity:0.55;font-family:monospace;margin-top:2px">` +
    `<span>−${hard}ms</span><span>${labelHard.replace("±", "−")}…${labelDead.replace("±", "−")}</span><span>0</span><span>${labelDead.replace("±", "+")}…${labelHard.replace("±", "+")}</span><span>+${hard}ms</span>` +
    `</div>` +
    `<div style="font-size:10px;margin-top:3px"><span style="color:${chipColor}">●</span> ${stateBits.join(" · ")} <span style="opacity:0.55">(drift ${drift > 0 ? "+" : ""}${drift}ms)</span></div>`;
}

// CSS.escape isn't universal in older WebViews; fall back to a small subset
// of escapes for the characters we actually emit (alnum, `:`, `-`, `_`).
function cssEscape(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

export default StatsPanel;
