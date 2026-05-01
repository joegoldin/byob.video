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

    // Local multi-line chart — only redraw when the sample is *ours*.
    if (this.localUserId && data.user_id === this.localUserId) {
      const chart = document.getElementById("byob-local-sync-chart");
      if (chart) renderLocalChart(chart, ring);
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

// CSS.escape isn't universal in older WebViews; fall back to a small subset
// of escapes for the characters we actually emit (alnum, `:`, `-`, `_`).
function cssEscape(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

export default StatsPanel;
