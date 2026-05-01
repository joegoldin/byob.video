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

const COLOR_DRIFT = "#fbbf24";  // amber (local user)

// Display-only fallback before the first real `tolerance_ms` arrives
// from the server (within 1 s of the panel opening). Match the floor
// in lib/byob/sync_decision.ex (`@min_tolerance_ms`) so the diagram
// doesn't snap from one number to a different one once data lands.
const FALLBACK_TOLERANCE_MS = 300;

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
      ring = {
        drift: [],
        rtt: [],
        offset: [],
        // Parallel boolean array: true at indices where a seek fired
        // for this peer (detected by seek_streak going up).
        seekFlags: [],
        lastSeekStreak: 0,
        userId: data.user_id || "",
        username: data.username || data.user_id || "?",
      };
      this.rings.set(key, ring);
    }
    // Username can land in a later sample (e.g. extension channel sends
    // it sparsely); update if we get a fresh one.
    if (data.username) ring.username = data.username;
    if (data.user_id) ring.userId = data.user_id;

    const streak = data.seek_streak || 0;
    const isSeek = streak > ring.lastSeekStreak;
    ring.lastSeekStreak = streak;

    pushRing(ring.drift, data.drift_ms || 0);
    pushRing(ring.rtt, data.rtt_ms || 0);
    pushRing(ring.offset, data.offset_ms || 0);
    pushRing(ring.seekFlags, isSeek);

    // Per-peer sparkline (drift only — that's what users care about per row).
    const spark = document.querySelector(
      `[data-byob-spark-key="${cssEscape(key)}"]`
    );
    if (spark) {
      renderSparkline(spark, ring.drift, ring.seekFlags);
    }

    // Multi-line chart shows EVERY peer's drift on a shared time axis,
    // plus the local user's RTT for context. Re-render on any sample
    // (not just local) so a peer's spike shows up immediately.
    const chart = document.getElementById("byob-local-sync-chart");
    if (chart) renderLocalChart(chart, this.rings, this.localUserId);

    // Bands diagram + drift-history details are local-only.
    if (this.localUserId && data.user_id === this.localUserId) {
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
//
// `seekFlags` is a parallel boolean array — wherever true, a small white
// dot is drawn at that drift point so the user can see when seeks fired
// over the last 60 s. Helps explain why drift suddenly returned to ~0.
function renderSparkline(host, values, seekFlags) {
  if (values.length === 0) {
    host.innerHTML = "";
    return;
  }

  const max = Math.max(50, ...values.map((v) => Math.abs(v)));
  const xy = values.map((v, i) => {
    const x = (i / (RING_SIZE - 1)) * SPARK_W;
    const y = SPARK_H / 2 - (v / max) * (SPARK_H / 2 - 1);
    return [x, y];
  });

  const points = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  // Color the line by the most recent sample's severity (matches the
  // numeric drift column above it).
  const last = Math.abs(values[values.length - 1]);
  const stroke = last > 1000 ? "#f87171" : last > 250 ? "#fbbf24" : "#34d399";

  let dots = "";
  if (Array.isArray(seekFlags)) {
    for (let i = 0; i < seekFlags.length && i < xy.length; i++) {
      if (seekFlags[i]) {
        const [x, y] = xy[i];
        // White dot with thin colored outline so it's visible against
        // the line. Small (r=1.4 in viewBox units, scaled by viewBox).
        dots +=
          `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.4" ` +
          `fill="white" stroke="${stroke}" stroke-width="0.6" ` +
          `vector-effect="non-scaling-stroke"/>`;
      }
    }
  }

  // width=100% lets the sparkline stretch to fill its flex-1 container; the
  // viewBox provides a stable coordinate system so polyline points don't
  // need to be recomputed when the row gets wider/narrower.
  host.innerHTML =
    `<svg width="100%" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" style="display:block">` +
    `<line x1="0" y1="${SPARK_H / 2}" x2="${SPARK_W}" y2="${SPARK_H / 2}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>` +
    `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>` +
    dots +
    `</svg>`;
}

// Multi-peer chart: every connected client's drift on a shared time
// axis (signed, centered at 0). Drift y-axis auto-scales to the worst
// |drift| across all peers so a single big-drift peer doesn't crush
// the others into a flat line at 0.
//
// Each peer gets a stable HSL hue derived from their user_id; the local
// user is drawn last (on top) in the existing amber so it remains
// visually distinct as "you".
function renderLocalChart(host, rings, localUserId) {
  // Snapshot peer rings, sorted so local user renders LAST (on top).
  // Stable order otherwise (by key) so colors don't reshuffle each tick.
  const entries = [...rings.entries()].sort(([ak, av], [bk, bv]) => {
    const aLocal = localUserId && av.userId === localUserId ? 1 : 0;
    const bLocal = localUserId && bv.userId === localUserId ? 1 : 0;
    if (aLocal !== bLocal) return aLocal - bLocal;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  // Global drift max so per-peer lines share a y-axis. Floor at 50 ms
  // so a quiet room doesn't draw drift jitter as huge spikes.
  let driftMax = 50;
  for (const [, ring] of entries) {
    for (const v of ring.drift) {
      const a = Math.abs(v);
      if (a > driftMax) driftMax = a;
    }
  }

  // Drift lines, one per peer.
  const driftLines = entries
    .filter(([, ring]) => ring.drift.length > 0)
    .map(([key, ring]) => {
      const isLocal = localUserId && ring.userId === localUserId;
      const color = isLocal ? COLOR_DRIFT : peerColor(ring.userId || key);
      const points = scaleSignedTo(ring.drift, LOCAL_CHART_W, LOCAL_CHART_H, driftMax);
      const width = isLocal ? 1.6 : 1.0;
      return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" vector-effect="non-scaling-stroke" opacity="${isLocal ? 1 : 0.85}"/>`;
    })
    .join("");

  // Legend: a drift swatch per peer with current value.
  const legendItems = [];
  for (const [key, ring] of entries) {
    if (ring.drift.length === 0) continue;
    const isLocal = localUserId && ring.userId === localUserId;
    const color = isLocal ? COLOR_DRIFT : peerColor(ring.userId || key);
    const last = Math.round(ring.drift[ring.drift.length - 1]);
    const name = isLocal ? `${ring.username} (you)` : ring.username;
    const sign = last > 0 ? "+" : "";
    legendItems.push(
      `<span style="color:${color}">■</span> ${name}: <span style="color:${color}">${sign}${last}ms</span>`
    );
  }
  const legend = legendItems.join(" &nbsp; ");

  host.innerHTML =
    `<svg width="100%" height="${LOCAL_CHART_H}" viewBox="0 0 ${LOCAL_CHART_W} ${LOCAL_CHART_H}" preserveAspectRatio="none" style="display:block;background:rgba(0,0,0,0.15);border-radius:4px">` +
    // Grid baseline at 50% — the 0-drift axis.
    `<line x1="0" y1="${LOCAL_CHART_H / 2}" x2="${LOCAL_CHART_W}" y2="${LOCAL_CHART_H / 2}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>` +
    driftLines +
    `</svg>` +
    `<div style="font-size:10px;margin-top:2px;opacity:0.85;display:flex;flex-wrap:wrap;gap:4px 12px">${legend}</div>`;
}

// Hash user_id to a stable HSL hue. Same id → same color across reloads.
// Skips the amber band reserved for the local user (~30-60°).
function peerColor(userId) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  let hue = Math.abs(hash) % 360;
  // Push hue out of the local-user amber band so peers don't collide
  // visually with "you".
  if (hue >= 30 && hue <= 70) hue = (hue + 90) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

function scaleSignedTo(values, w, h, max) {
  const m = Math.max(1, max);
  return values
    .map((v, i) => {
      const x = (i / (RING_SIZE - 1)) * w;
      const y = h / 2 - (v / m) * (h / 2 - 1);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

// Horizontal "where on the dial are you" diagram. FULLY proportional —
// each band's width is in true 1:1 ratio with the ms range it represents.
// Display range covers ±(2 × tolerance), mapped linearly to 0-100 %:
//
//   green  half-width  = jitter / (2 × tolerance) × 50 %
//   yellow half-width  = (tolerance − jitter) / (2 × tolerance) × 50 %
//   red    half-width  = tolerance / (2 × tolerance) × 50 % = 25 %
//
// So tolerance edges always sit at 25 % / 75 %; jitter edges land
// proportionally inside; the outer 25 % on each side is "seek territory"
// (drift beyond ±2 × tolerance clamps to the edge with an overflow arrow).
//
// When jitter ≈ tolerance, green fills the whole inner area. When jitter
// ≪ tolerance, green is a thin center strip with most of the inner
// area as yellow.
function renderDriftBands(host, data) {
  const drift = data.drift_ms || 0;
  const tolerance = Math.max(1, data.tolerance_ms || FALLBACK_TOLERANCE_MS);
  // Green "in sync" band sized by ROOM jitter (consensus). Falls back to
  // local noise floor for single-user rooms; clamped at tolerance so green
  // can't exceed the inner area.
  const roomJitter = Math.max(0, data.room_jitter_ms || 0);
  const localJitter = Math.max(0, data.noise_floor_ms || 0);
  // Raw jitter EMA used for status text; the visualised in-sync band
  // expands to 3× that so casual drift inside the noise floor reads
  // as comfortably "in sync" instead of pinned to a thin center
  // strip. Clamped to tolerance so green can't spill into yellow.
  const rawJitter = Math.max(1, Math.max(roomJitter, localJitter));
  const IN_SYNC_JITTER_FACTOR = 3;
  const jitterBand = Math.min(rawJitter * IN_SYNC_JITTER_FACTOR, tolerance);
  const cooldownRemaining = data.cooldown_remaining_ms || 0;
  const seekStreak = data.seek_streak || 0;

  // Linear ms → % mapping over [-displayMax, +displayMax]. The scale
  // floor is 2× tolerance so the seek bands always have visible width;
  // we expand toward the worst peer drift / local drift but cap at
  // DISPLAY_MAX_FACTOR × tolerance so a single 4-second-off peer
  // doesn't squash the in-tolerance bands into an illegible sliver
  // at the center. When the actual extent exceeds the cap, the end
  // labels show "≥cap" and the drift overflow arrow handles the rest.
  const DISPLAY_MAX_FACTOR = 2.5;
  const roomMaxDrift = Math.max(0, data.room_max_drift_ms || 0);
  const cappedMax = tolerance * DISPLAY_MAX_FACTOR;
  const desiredMax = Math.max(tolerance * 2, roomMaxDrift, Math.abs(drift));
  const displayMax = Math.min(cappedMax, desiredMax);
  const displayMaxClamped = desiredMax > cappedMax;
  const xFor = (ms) => {
    const clamped = Math.max(-displayMax, Math.min(displayMax, ms));
    return 50 + (clamped / displayMax) * 50;
  };

  const absDrift = Math.abs(drift);
  let active;
  if (absDrift <= jitterBand) active = "jitter";
  else if (absDrift <= tolerance) active = "tolerated";
  else active = "seek";

  const xJitterL = xFor(-jitterBand);
  const xJitterR = xFor(jitterBand);
  const xToleranceL = xFor(-tolerance);
  const xToleranceR = xFor(tolerance);

  const band = (x1, x2, color, isActive) => {
    const w = Math.max(0, x2 - x1);
    const opacity = isActive ? "0.7" : "0.16";
    return `<rect x="${x1}" y="0" width="${w}" height="34" fill="${color}" fill-opacity="${opacity}"/>`;
  };

  const segs =
    band(0, xToleranceL, "#f87171", active === "seek") +
    band(xToleranceL, xJitterL, "#fbbf24", active === "tolerated") +
    band(xJitterL, xJitterR, "#34d399", active === "jitter") +
    band(xJitterR, xToleranceR, "#fbbf24", active === "tolerated") +
    band(xToleranceR, 100, "#f87171", active === "seek");

  const divider = (x) =>
    `<line x1="${x}" y1="0" x2="${x}" y2="34" stroke="rgba(255,255,255,0.22)" stroke-width="0.4"/>`;
  // Only draw the dividers that flank the ACTIVE band. Dividers
  // between two dim bands (e.g. yellow/red when green is active)
  // visually read as random bright lines and add no information,
  // since the band colors already mark their own boundaries.
  const dividers =
    active === "jitter"
      ? divider(xJitterL) + divider(xJitterR)
      : active === "tolerated"
        ? divider(xToleranceL) + divider(xJitterL) + divider(xJitterR) + divider(xToleranceR)
        : divider(xToleranceL) + divider(xToleranceR);

  const centerLine = `<line x1="50" y1="2" x2="50" y2="32" stroke="rgba(255,255,255,0.08)" stroke-width="0.3" stroke-dasharray="1 1"/>`;

  const tickX = xFor(drift);
  const overflowed = absDrift > displayMax;
  const overflowArrow = overflowed
    ? `<polygon points="${drift > 0 ? "99,2 99,8 95,5" : "1,2 1,8 5,5"}" fill="white"/>`
    : "";
  const tick =
    `<line x1="${tickX}" y1="0" x2="${tickX}" y2="34" stroke="white" stroke-width="0.7"/>` +
    `<polygon points="${tickX - 1.2},0 ${tickX + 1.2},0 ${tickX},3" fill="white"/>` +
    `<polygon points="${tickX - 1.2},34 ${tickX + 1.2},34 ${tickX},31" fill="white"/>` +
    overflowArrow;

  // State chip text.
  let stateLabel, stateColor, statusBits = [];
  if (active === "jitter") {
    stateLabel = "In sync";
    stateColor = "#34d399";
  } else if (active === "tolerated") {
    stateLabel = "Within tolerance";
    stateColor = "#fbbf24";
  } else {
    if (cooldownRemaining > 0) {
      stateLabel = "Re-syncing soon";
      statusBits.push(`cooldown ${(cooldownRemaining / 1000).toFixed(1)}s`);
    } else {
      stateLabel = "Re-syncing now";
    }
    stateColor = "#f87171";
  }
  if (seekStreak > 0) statusBits.push(`streak ${seekStreak}`);
  // When the chart's display extent was clamped, surface the actual
  // worst-peer drift here so the value isn't lost from the bar-end
  // labels.
  if (displayMaxClamped) statusBits.push(`peer max ±${Math.round(roomMaxDrift)}ms`);

  host.innerHTML =
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">` +
    `<span style="display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:9999px;background:${stateColor}33;border:1px solid ${stateColor}66;color:${stateColor};font-size:10px;font-weight:600">` +
    `<span style="width:6px;height:6px;border-radius:50%;background:${stateColor}"></span>${stateLabel}` +
    `</span>` +
    `<span style="font-size:10px;opacity:0.6;font-family:monospace">drift ${drift > 0 ? "+" : ""}${drift}ms · room jitter ~${roomJitter}ms${statusBits.length ? " · " + statusBits.join(" · ") : ""}</span>` +
    `</div>` +
    `<svg width="100%" height="34" viewBox="0 0 100 34" preserveAspectRatio="none" style="display:block;border-radius:4px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06)">` +
    segs +
    dividers +
    centerLine +
    tick +
    `</svg>` +
    // Threshold labels. When jitter is small relative to tolerance the
    // ±jitter labels would render right on top of the "0". Push them
    // outward from center until each pair is at least `minGap` apart.
    // The "0" stays anchored at 50%; ±tolerance gets pushed further out
    // if ±jitter would otherwise crowd it. The bar ends are labeled with
    // the scale max — usually the worst peer drift in the room.
    renderRepulsedLabels(
      [
        {
          x: 0,
          text: `${displayMaxClamped ? "≤" : ""}−${Math.round(displayMax)}`,
          color: "rgba(255,255,255,0.55)",
        },
        { x: xToleranceL, text: `−${tolerance}` },
        { x: xJitterL, text: `−${jitterBand}` },
        { x: 50, text: "0", color: "rgba(255,255,255,0.4)" },
        { x: xJitterR, text: `+${jitterBand}` },
        { x: xToleranceR, text: `+${tolerance}` },
        {
          x: 100,
          text: `${displayMaxClamped ? "≤" : ""}+${Math.round(displayMax)}`,
          color: "rgba(255,255,255,0.55)",
        },
      ],
      3 // minGap % (just enough to keep labels from physically overlapping)
    ) +
    // Section captions: same repulsion treatment so "tolerated" doesn't
    // overlap "in sync" / "seek" when bands are narrow.
    renderRepulsedLabels(
      [
        {
          x: xToleranceL / 2,
          text: "seek",
          color: "rgba(248,113,113,0.7)",
        },
        {
          x: (xToleranceL + xJitterL) / 2,
          text: "tolerated",
        },
        {
          x: 50,
          text: "in sync",
          color: "rgba(52,211,153,0.7)",
        },
        {
          x: (xJitterR + xToleranceR) / 2,
          text: "tolerated",
        },
        {
          x: (xToleranceR + 100) / 2,
          text: "seek",
          color: "rgba(248,113,113,0.7)",
        },
      ],
      11, // minGap % (wider labels)
      "rgba(255,255,255,0.35)"
    );
}

// Render a row of percent-positioned labels with collision avoidance.
// Labels are sorted by x; each side of the natural center (50 %) is
// pushed *outward* from its inner neighbor until at least `minGap` %
// apart. The center label (if at 50 %) stays anchored. Positions are
// then clamped to [0, 100].
function renderRepulsedLabels(labels, minGap, defaultColor) {
  const sorted = [...labels].sort((a, b) => a.x - b.x);
  const centerIdx = sorted.findIndex((l) => Math.abs(l.x - 50) < 0.01);

  if (centerIdx >= 0) {
    // Walk left from center, pushing each label further left if it's
    // closer than minGap to the previous (more central) one.
    for (let i = centerIdx - 1; i >= 0; i--) {
      const next = sorted[i + 1].x;
      if (next - sorted[i].x < minGap) sorted[i].x = next - minGap;
    }
    // Walk right from center, pushing further right.
    for (let i = centerIdx + 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].x;
      if (sorted[i].x - prev < minGap) sorted[i].x = prev + minGap;
    }
  } else {
    // No center anchor — just sweep left to right.
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].x;
      if (sorted[i].x - prev < minGap) sorted[i].x = prev + minGap;
    }
  }

  // Clamp to chart bounds.
  for (const l of sorted) l.x = Math.max(0, Math.min(100, l.x));

  const baseColor = defaultColor || "rgba(255,255,255,0.55)";
  const isCaption = !!defaultColor;
  const height = isCaption ? 12 : 14;
  const marginTop = isCaption ? 1 : 2;

  const html = sorted
    .map(
      (l) =>
        `<span style="position:absolute;left:${l.x.toFixed(1)}%;transform:translateX(-50%)${l.color ? `;color:${l.color}` : ""}">${l.text}</span>`
    )
    .join("");

  return `<div style="position:relative;height:${height}px;margin-top:${marginTop}px;font-size:9px;font-family:monospace;color:${baseColor}">${html}</div>`;
}

// CSS.escape isn't universal in older WebViews; fall back to a small subset
// of escapes for the characters we actually emit (alnum, `:`, `-`, `_`).
function cssEscape(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

export default StatsPanel;
