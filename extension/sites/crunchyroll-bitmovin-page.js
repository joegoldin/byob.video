// byob — Crunchyroll Bitmovin adapter (page-world script)
//
// Runs in the page world of the Crunchyroll player iframe
// (static.crunchyroll.com/vilos-*/vilos/player.html). Finds the Bitmovin
// Player instance that the page stores on `.bitmovinplayer-container.player`
// and bridges it to the content script via window.postMessage.
//
// postMessage (not CustomEvent) is used for cross-world communication
// because Firefox's xray wrappers strip the .detail field of CustomEvents
// dispatched from the ISOLATED content-script world when they cross into
// the MAIN world. postMessage uses structured clone and is safe in both
// directions.

(() => {
  "use strict";

  if (window.__byobBitmovinAdapter) return;
  window.__byobBitmovinAdapter = true;

  const log = (...a) => console.log("[byob-bm]", ...a);
  const MSG_CMD = "byob-bm:cmd";
  const MSG_EVT = "byob-bm:evt";
  const MSG_ACK = "byob-bm:ack";

  let player = null;
  let pollInterval = null;
  let pollAttempts = 0;

  function findPlayer() {
    const container = document.querySelector(".bitmovinplayer-container");
    if (!container || !container.player) return null;
    const p = container.player;
    if (typeof p.seek !== "function" || typeof p.play !== "function") return null;
    return p;
  }

  function emit(event, data) {
    try {
      window.postMessage(Object.assign({ source: MSG_EVT, event }, data || {}), "*");
    } catch (_) {}
  }

  function safeTime(p) {
    try { return p.getCurrentTime(); } catch (_) { return 0; }
  }

  function attach(p) {
    player = p;

    p.on("play",             () => emit("play",     { time: safeTime(p) }));
    p.on("paused",           () => emit("paused",   { time: safeTime(p) }));
    p.on("seek",             (e) => emit("seek",    { time: (e && e.position != null) ? e.position : safeTime(p) }));
    p.on("seeked",           () => emit("seeked",   { time: safeTime(p) }));
    p.on("timechanged",      () => emit("timechanged", { time: safeTime(p) }));
    p.on("stallstarted",     () => emit("stall",    { state: "started", time: safeTime(p) }));
    p.on("stallended",       () => emit("stall",    { state: "ended",   time: safeTime(p) }));
    p.on("playbackfinished", () => emit("ended",    { time: safeTime(p) }));

    // Wait until the source is actually loaded before signaling ready.
    // Emitting "ready" while duration=0 causes the content script to issue
    // seek/pause/play commands that the not-yet-loaded player silently
    // discards; CR's autoplay then takes over and we can't override it.
    let readyEmitted = false;
    function duration() { try { return p.getDuration() || 0; } catch (_) { return 0; } }
    function maybeEmitReady() {
      if (readyEmitted) return true;
      const d = duration();
      if (d <= 0) return false;
      readyEmitted = true;
      emit("ready", { time: safeTime(p), isPaused: p.isPaused(), duration: d });
      log("attached, pos=", safeTime(p), "paused=", p.isPaused(), "duration=", d);
      return true;
    }

    try { p.on("sourceloaded", maybeEmitReady); } catch (_) {}
    try { p.on("ready",        maybeEmitReady); } catch (_) {}
    try { p.on("timechanged",  maybeEmitReady); } catch (_) {}

    if (!maybeEmitReady()) {
      const pollReady = setInterval(() => {
        if (maybeEmitReady()) clearInterval(pollReady);
      }, 250);
    }
  }

  function ack(id, ok, data) {
    try {
      window.postMessage({ source: MSG_ACK, id, ok, data }, "*");
    } catch (_) {}
  }

  function onMsg(ev) {
    // Same-window postMessage only
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== MSG_CMD) return;
    const { id, cmd, arg } = d;
    if (!player) { log("cmd", cmd, "rejected (no-player)"); ack(id, false, "no-player"); return; }

    try {
      if (cmd === "seek") {
        const t = arg && typeof arg.time === "number" ? arg.time : null;
        if (t == null) { ack(id, false, "bad-arg"); return; }
        log("cmd seek →", t);
        player.seek(t);
        ack(id, true);
      } else if (cmd === "play") {
        log("cmd play");
        const r = player.play();
        if (r && typeof r.then === "function") {
          r.then(() => ack(id, true))
           .catch((e) => ack(id, false, (e && e.message) || String(e)));
        } else {
          ack(id, true);
        }
      } else if (cmd === "pause") {
        log("cmd pause");
        const r = player.pause();
        if (r && typeof r.then === "function") {
          r.then(() => ack(id, true)).catch(() => ack(id, true));
        } else {
          ack(id, true);
        }
      } else if (cmd === "state") {
        ack(id, true, {
          time: safeTime(player),
          isPaused: player.isPaused(),
          isPlaying: player.isPlaying(),
          isStalled: typeof player.isStalled === "function" ? player.isStalled() : false,
          duration: typeof player.getDuration === "function" ? (player.getDuration() || 0) : 0,
        });
      } else {
        ack(id, false, "unknown-cmd");
      }
    } catch (e) {
      log("cmd", cmd, "threw:", (e && e.message) || String(e));
      ack(id, false, (e && e.message) || String(e));
    }
  }

  window.addEventListener("message", onMsg);

  // CR loads Bitmovin asynchronously; poll until the player appears.
  pollInterval = setInterval(() => {
    pollAttempts++;
    const p = findPlayer();
    if (p) {
      clearInterval(pollInterval);
      pollInterval = null;
      attach(p);
    } else if (pollAttempts > 600) { // 60s cap
      clearInterval(pollInterval);
      pollInterval = null;
      log("gave up finding player after 60s");
    }
  }, 100);
})();
