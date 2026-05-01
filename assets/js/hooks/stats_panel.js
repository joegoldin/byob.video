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

// Horizontal "where on the dial are you" diagram. Layout uses *proportional*
// sections so the dead zone is always visible, regardless of how small it
// is in absolute terms vs the hard-seek threshold:
//
//   [hard][- rate correct -][===  dead  ===][- rate correct -][hard]
//    5%        20%                50%              20%          5%
//
// Within each section, drift maps linearly to position. So drift=±dead
// always hits the section boundaries, drift=±hard always hits the outer
// boundaries, regardless of the actual ms values. Big drift overflows
// to the chart edges with an arrow.
//
// The active band (where the current drift sits) is at full saturation;
// inactive bands are dimmed. Threshold values are sourced from the payload
// (effective deadZone / hardSeek), so when reconcile's adaptive logic
// grows them in response to jitter, the displayed thresholds and the
// diagram update together.
function renderDriftBands(host, data) {
  const drift = data.drift_ms || 0;
  const dead = Math.max(1, data.dead_zone_ms || 100);
  const hard = Math.max(dead + 1, data.hard_seek_ms || 2000);
  const noise = data.noise_floor_ms || 0;
  const rateCorrecting = !!data.rate_correcting;

  // Section boundaries (% of width):
  //   0%–5%        : hard-seek (left)
  //   5%–25%       : rate correct (left)
  //   25%–75%      : dead zone
  //   75%–95%      : rate correct (right)
  //   95%–100%     : hard-seek (right)
  // Linear map drift → position within whichever section it falls in.
  const xFor = (ms) => {
    const sign = ms < 0 ? -1 : 1;
    const abs = Math.abs(ms);
    let halfFrac; // 0..0.5 — distance from center as fraction of total width
    if (abs <= dead) {
      halfFrac = (abs / dead) * 0.25;
    } else if (abs <= hard) {
      halfFrac = 0.25 + ((abs - dead) / (hard - dead)) * 0.20;
    } else {
      // Up to 2× hard, fade through the outer hard-seek band; anything
      // beyond is clamped to the edge.
      const beyond = Math.min((abs - hard) / hard, 1);
      halfFrac = 0.45 + beyond * 0.05;
    }
    return 50 + sign * halfFrac * 100;
  };

  const absDrift = Math.abs(drift);
  let active;
  if (absDrift <= dead) active = "dead";
  else if (absDrift <= hard) active = "rate";
  else active = "hard";

  const band = (x1, x2, color, isActive) => {
    const w = Math.max(0, x2 - x1);
    const opacity = isActive ? "0.7" : "0.16";
    return `<rect x="${x1}" y="0" width="${w}" height="34" fill="${color}" fill-opacity="${opacity}"/>`;
  };

  const segs =
    band(0, 5, "#f87171", active === "hard") +
    band(5, 25, "#fbbf24", active === "rate") +
    band(25, 75, "#34d399", active === "dead") +
    band(75, 95, "#fbbf24", active === "rate") +
    band(95, 100, "#f87171", active === "hard");

  // Section dividers (cleaner than separate threshold ticks — at this
  // resolution the band edges ARE the threshold ticks).
  const divider = (x) =>
    `<line x1="${x}" y1="0" x2="${x}" y2="34" stroke="rgba(255,255,255,0.22)" stroke-width="0.4"/>`;
  const dividers = divider(5) + divider(25) + divider(75) + divider(95);

  // Center line for visual reference.
  const centerLine = `<line x1="50" y1="2" x2="50" y2="32" stroke="rgba(255,255,255,0.08)" stroke-width="0.3" stroke-dasharray="1 1"/>`;

  // Current-drift indicator: a chunky vertical tick + small diamond head.
  const tickX = xFor(drift);
  const overflowed = absDrift > hard * 2;
  const overflowArrow = overflowed
    ? `<polygon points="${drift > 0 ? "99,2 99,8 95,5" : "1,2 1,8 5,5"}" fill="white"/>`
    : "";
  const tick =
    `<line x1="${tickX}" y1="0" x2="${tickX}" y2="34" stroke="white" stroke-width="0.7"/>` +
    `<polygon points="${tickX - 1.2},0 ${tickX + 1.2},0 ${tickX},3" fill="white"/>` +
    `<polygon points="${tickX - 1.2},34 ${tickX + 1.2},34 ${tickX},31" fill="white"/>` +
    overflowArrow;

  const stateLabel =
    active === "dead"
      ? "In sync"
      : active === "rate"
      ? "Rate-correcting"
      : "Hard-seek territory";
  const stateColor =
    active === "dead" ? "#34d399" : active === "rate" ? "#fbbf24" : "#f87171";

  host.innerHTML =
    // State chip
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">` +
    `<span style="display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:9999px;background:${stateColor}33;border:1px solid ${stateColor}66;color:${stateColor};font-size:10px;font-weight:600">` +
    `<span style="width:6px;height:6px;border-radius:50%;background:${stateColor}"></span>${stateLabel}` +
    `</span>` +
    `<span style="font-size:10px;opacity:0.6;font-family:monospace">drift ${drift > 0 ? "+" : ""}${drift}ms · jitter ~${noise}ms${rateCorrecting ? " · rate active" : ""}</span>` +
    `</div>` +
    // The dial
    `<svg width="100%" height="34" viewBox="0 0 100 34" preserveAspectRatio="none" style="display:block;border-radius:4px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06)">` +
    segs +
    dividers +
    centerLine +
    tick +
    `</svg>` +
    // Threshold labels under the section boundaries
    `<div style="position:relative;height:14px;margin-top:2px;font-size:9px;font-family:monospace;color:rgba(255,255,255,0.55)">` +
    `<span style="position:absolute;left:5%;transform:translateX(-50%)">−${hard}</span>` +
    `<span style="position:absolute;left:25%;transform:translateX(-50%)">−${dead}</span>` +
    `<span style="position:absolute;left:50%;transform:translateX(-50%);color:rgba(255,255,255,0.4)">0</span>` +
    `<span style="position:absolute;left:75%;transform:translateX(-50%)">+${dead}</span>` +
    `<span style="position:absolute;left:95%;transform:translateX(-50%)">+${hard}</span>` +
    `</div>` +
    // Section captions (small, dimmer)
    `<div style="position:relative;height:12px;margin-top:1px;font-size:9px;font-family:monospace;color:rgba(255,255,255,0.35)">` +
    `<span style="position:absolute;left:15%;transform:translateX(-50%)">rate correct</span>` +
    `<span style="position:absolute;left:50%;transform:translateX(-50%);color:rgba(52,211,153,0.7)">in sync</span>` +
    `<span style="position:absolute;left:85%;transform:translateX(-50%)">rate correct</span>` +
    `</div>`;
}

// CSS.escape isn't universal in older WebViews; fall back to a small subset
// of escapes for the characters we actually emit (alnum, `:`, `-`, `_`).
function cssEscape(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

export default StatsPanel;
