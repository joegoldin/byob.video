// byob — Crunchyroll Bitmovin adapter (page-world script)
//
// Runs in the page world of the Crunchyroll player iframe
// (static.crunchyroll.com/vilos-*/vilos/player.html). Finds the Bitmovin
// Player instance that the page stores on `.bitmovinplayer-container.player`
// and bridges it to the content script via CustomEvents.
//
// Direct <video>.currentTime= wedges MSE on Crunchyroll for big seeks-
// while-playing. Calling Bitmovin's player.seek()/play()/pause() lets the
// player handle its own buffer transitions. Recon in the iframe confirmed
// the full Bitmovin v8 API is reachable via .bitmovinplayer-container.player.

(() => {
  "use strict";

  if (window.__byobBitmovinAdapter) return;
  window.__byobBitmovinAdapter = true;

  const log = (...a) => console.debug("[byob-bm]", ...a);

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
      window.dispatchEvent(new CustomEvent("byob-bm:evt", {
        detail: Object.assign({ event }, data || {}),
      }));
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

    let duration = 0;
    try { duration = p.getDuration() || 0; } catch (_) {}

    emit("ready", {
      time: safeTime(p),
      isPaused: p.isPaused(),
      duration,
    });
    log("attached, pos=", safeTime(p), "paused=", p.isPaused(), "duration=", duration);
  }

  function ack(id, ok, data) {
    try {
      window.dispatchEvent(new CustomEvent("byob-bm:ack", {
        detail: { id, ok, data },
      }));
    } catch (_) {}
  }

  function onCmd(evt) {
    const detail = evt.detail || {};
    const { id, cmd, arg } = detail;
    if (!player) { ack(id, false, "no-player"); return; }

    try {
      if (cmd === "seek") {
        const t = arg && typeof arg.time === "number" ? arg.time : null;
        if (t == null) { ack(id, false, "bad-arg"); return; }
        player.seek(t);
        ack(id, true);
      } else if (cmd === "play") {
        const r = player.play();
        if (r && typeof r.then === "function") {
          r.then(() => ack(id, true))
           .catch((e) => ack(id, false, (e && e.message) || String(e)));
        } else {
          ack(id, true);
        }
      } else if (cmd === "pause") {
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
      ack(id, false, (e && e.message) || String(e));
    }
  }

  window.addEventListener("byob-bm:cmd", onCmd);

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
