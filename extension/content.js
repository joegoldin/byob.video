// byob content script — hooks <video> elements and reconciles playback with
// the server. This is the Stage-2 rewrite based on the v4.1.0 reconcile
// architecture, plus the v6.0.0 Bitmovin adapter for Crunchyroll.
//
// Core model:
//   - serverRef + clockOffset = authoritative position at any instant.
//   - expectedPlayState = what the server wants us to be doing (playing/paused).
//   - event handlers only send state CHANGES to the server (debounced 500ms).
//   - reconcile loop (500ms) nudges playback rate and hard-seeks on large
//     drift. Hard seeks go through bitmovinAdapter when available (safe on
//     Crunchyroll), otherwise via <video>.currentTime (may fight some DRM
//     sites — v4.x's "give up after 2 failures" fallback accepts the site's
//     position if seeks don't stick).

(() => {
  "use strict";

  // ── Constants ─────────────────────────────────────────────────────────────
  const State = Object.freeze({ PLAYING: "playing", PAUSED: "paused" });
  const STORAGE_KEY = "watchparty_config";
  const PORT_NAME = "watchparty";

  // ── State ─────────────────────────────────────────────────────────────────
  let port = null;
  let hookedVideo = null;
  let synced = false;
  let needsGesture = true;
  let timeReportInterval = null;
  let reconcileInterval = null;
  let commandGuard = null;         // suppress outgoing events after a server command
  let _guardStartedAt = 0;
  let expectedPlayState = null;    // State.PLAYING / State.PAUSED / null
  let serverRef = null;            // { position, playState, serverTime }
  let lastSeekAt = 0;
  let _pendingPlayPause = null;    // debounced send
  let _hardSeekFailures = 0;
  let _mismatchSince = 0;          // Date.now() when actual≠expected started
  // Echo suppression is handled entirely by commandGuard:
  //   - After any server command (play/pause/seek/synced), commandGuard is
  //     armed and auto-releases once the video's actual state matches what
  //     we commanded (or after 5s max).
  //   - While armed, event handlers drop their outbound sends.
  //   - No time-based "settling" window — behavior is deterministic against
  //     the commands we've executed.
  let _endedReported = false;
  let activateArgs = null;

  // Clock sync (from background NTP burst)
  let clockOffset = 0;             // serverMonotonicMs ≈ Date.now() + clockOffset
  let clockRtt = 0;
  let clockSynced = false;
  let syncToleranceMs = 250;       // room-wide dead zone (server can widen)

  const _DEBUG = true;
  function _log(...args) {
    if (!_DEBUG) return;
    console.log("[byob]", ...args);
    if (port) {
      try {
        const msg = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
        port.postMessage({ type: "debug:log", message: msg });
      } catch (_) {}
    }
  }


  // Signal extension is installed — only on our domain.
  if (window.location.hostname === "byob.video" || window.location.hostname === "localhost") {
    document.documentElement.setAttribute("data-byob-extension", "true");
  }

  // ── Bitmovin adapter ──────────────────────────────────────────────────────
  // Page-world script (extension/sites/crunchyroll-bitmovin-page.js) bridges
  // the Crunchyroll Bitmovin Player instance. When ready, receiver commands
  // and reconcile hard seeks route through Bitmovin's API; Bitmovin manages
  // the MSE buffer transition cleanly instead of wedging on currentTime=.
  //
  // Transport is window.postMessage rather than CustomEvent because Firefox's
  // ISOLATED↔MAIN world xray wrappers strip the .detail field of CustomEvents
  // crossing worlds. postMessage uses structured clone and works bidirectionally.
  const BM_CMD = "byob-bm:cmd";
  const BM_EVT = "byob-bm:evt";

  const bitmovinAdapter = (() => {
    let ready = false;
    let last = null;
    let cmdSeq = 0;

    function onMsg(e) {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.source !== BM_EVT) return;
      if (d.event === "ready") {
        ready = true;
        last = { time: d.time, isPaused: d.isPaused, duration: d.duration };
        _log("bitmovin: ready time=", d.time, "paused=", d.isPaused, "duration=", d.duration);
      } else if (d.time != null) {
        if (!last) last = {};
        last.time = d.time;
      }
    }

    const host = window.location.hostname;
    const isCr = /(^|\.)crunchyroll\.com$/.test(host);
    if (isCr) {
      try { window.addEventListener("message", onMsg); } catch (_) {}
    }

    function send(cmd, arg) {
      if (!ready) return false;
      cmdSeq++;
      try {
        window.postMessage({ source: BM_CMD, id: cmdSeq, cmd, arg }, "*");
      } catch (_) { return false; }
      return true;
    }

    return {
      isReady() { return ready; },
      getCurrentTime() { return last && last.time != null ? last.time : null; },
      seek(time) {
        if (time == null) return false;
        return send("seek", { time });
      },
      play(position) {
        if (!ready) return false;
        if (position != null
            && last && last.time != null
            && Math.abs(last.time - position) > 0.5) {
          send("seek", { time: position });
        }
        return send("play");
      },
      pause(position) {
        if (!ready) return false;
        if (position != null
            && last && last.time != null
            && Math.abs(last.time - position) > 0.1) {
          send("seek", { time: position });
        }
        return send("pause");
      },
    };
  })();

  // seekTo — unified hard-seek that prefers Bitmovin's API when available.
  function seekTo(target) {
    if (target == null || !hookedVideo) return;
    if (bitmovinAdapter.isReady()) {
      bitmovinAdapter.seek(target);
      return;
    }
    try { hookedVideo.currentTime = target; } catch (_) {}
  }

  // ── Init / activation ─────────────────────────────────────────────────────
  async function init() {
    window.addEventListener("message", (e) => {
      if (e.origin !== window.location.origin) return;
      try {
        if (e.data?.type === "byob:clear-external") {
          chrome.storage.local.remove(STORAGE_KEY);
          return;
        }
        if (e.data?.type === "byob:open-external") {
          chrome.storage.local.set({
            [STORAGE_KEY]: {
              room_id: e.data.room_id,
              server_url: e.data.server_url,
              target_url: e.data.url,
              token: e.data.token,
              username: e.data.username,
              timestamp: Date.now(),
            },
          });
        }
      } catch (_) {}
    });

    const tryActivate = async (attempt) => {
      if (attempt > 5) return;
      try {
        const config = await chrome.storage.local.get(STORAGE_KEY);
        if (config[STORAGE_KEY]) {
          const { room_id, server_url, target_url, token, username, timestamp } = config[STORAGE_KEY];
          const age = Date.now() - (timestamp || 0);
          if (age < 30 * 60 * 1000) {
            const host = window.location.hostname;
            if (host === "byob.video" || host === "localhost") return;

            const isTopFrame = window === window.top;
            if (!isTopFrame) {
              activate(room_id, server_url, token, username);
              return;
            }
            if (target_url) {
              const targetBase = new URL(target_url).origin + new URL(target_url).pathname;
              const currentBase = window.location.origin + window.location.pathname;
              if (currentBase.startsWith(targetBase) || targetBase.startsWith(currentBase)) {
                showJoinToast("Loading byob sync...");
                activate(room_id, server_url, token, username);
                return;
              }
            }
          }
        }
      } catch (_) {}
      setTimeout(() => tryActivate(attempt + 1), 500);
    };
    tryActivate(0);
  }

  function activate(roomId, serverUrl, token, username) {
    activateArgs = { roomId, serverUrl, token, username };
    connectToSW(roomId, serverUrl, token, username);
  }

  function connectToSW(roomId, serverUrl, token, username) {
    if (window === window.top) {
      injectSyncBar();
      updateSyncBarStatus("loading");
    }

    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch (e) {
      setTimeout(() => connectToSW(roomId, serverUrl, token, username), 2000);
      return;
    }

    port.postMessage({
      type: "connect",
      room_id: roomId,
      server_url: serverUrl,
      token: token,
      username: username,
    });

    port.onMessage.addListener(handleSWMessage);

    window.addEventListener("message", (e) => {
      if (e.data?.type === "byob:relay" && e.data.payload && port) {
        port.postMessage(e.data.payload);
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      if (activateArgs) {
        setTimeout(() => {
          const { roomId: r, serverUrl: s, token: t, username: u } = activateArgs;
          connectToSW(r, s, t, u);
        }, 1000);
      } else {
        cleanup();
      }
    });

    observeVideos();
  }

  // ── Video discovery ───────────────────────────────────────────────────────
  function observeVideos() {
    const origAttachShadow = HTMLElement.prototype.attachShadow;
    HTMLElement.prototype.attachShadow = function (...args) {
      const root = origAttachShadow.apply(this, args);
      observer.observe(root, { childList: true, subtree: true });
      return root;
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.tagName === "VIDEO") hookVideo(node);
          if (node.querySelectorAll) {
            node.querySelectorAll("video").forEach((v) => hookVideo(v));
          }
        }
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.querySelectorAll("video").forEach((v) => hookVideo(v));
  }

  function scrapePageMetadata() {
    try {
      const host = window.location.hostname;
      if (host.includes("crunchyroll.com")) {
        const showEl = document.querySelector("[data-t='show-title-link'] h4, .show-title-link h4");
        const epEl = document.querySelector(".title, h1.title");
        const thumbEl = document.querySelector("meta[property='og:image']");
        const show = showEl?.textContent?.trim();
        const ep = epEl?.textContent?.trim();
        const title = show && ep ? `${show} — ${ep}` : show || ep || null;
        return { title: title || document.title, thumbnail_url: thumbEl?.content || null };
      }
      const ogTitle = document.querySelector("meta[property='og:title']")?.content;
      const ogImage = document.querySelector("meta[property='og:image']")?.content;
      return { title: ogTitle || document.title || null, thumbnail_url: ogImage || null };
    } catch (_) {
      return { title: document.title || null, thumbnail_url: null };
    }
  }

  function hookVideo(video) {
    if (hookedVideo === video) return;
    const wasHooked = !!hookedVideo;
    if (hookedVideo) unhookVideo();

    // Site replaced the <video>: pause syncing until we re-sync. Otherwise
    // position=0 on the new element would corrupt server state.
    if (wasHooked && synced) {
      synced = false;
      stopReconcile();
    }

    hookedVideo = video;
    _endedReported = false;

    video.addEventListener("play", onVideoPlay);
    video.addEventListener("pause", onVideoPause);
    video.addEventListener("seeked", onVideoSeeked);
    video.addEventListener("waiting", onVideoWaiting);
    video.addEventListener("canplay", onVideoCanPlay);

    const meta = scrapePageMetadata();
    if (port) {
      port.postMessage({ type: "video:hooked", duration: video.duration || 0, ...meta });
    }
    if (!window.location.hostname.includes("youtube.com")) {
      try { chrome.runtime.sendMessage({ type: "byob:video-hooked" }); } catch (_) {}
    }

    if (needsGesture) {
      waitForNativePlay();
    } else {
      updateSyncBarStatus("syncing");
    }

    // Periodic state report + ended detection.
    timeReportInterval = setInterval(() => {
      if (!hookedVideo) return;
      const pos = hookedVideo.currentTime;
      const dur = hookedVideo.duration || 0;
      const playing = !hookedVideo.paused && !isBuffering;

      const msg = { type: "video:state", position: pos, duration: dur, playing };
      if (synced && port) port.postMessage(msg);
      if (port) {
        port.postMessage({
          type: "byob:bar-update",
          position: pos, duration: dur, playing,
        });
      }

      if (synced && !_endedReported && playing && isFinite(dur) && dur > 60 && pos >= dur - 3) {
        _endedReported = true;
        if (port) port.postMessage({ type: "video:ended" });
      }
    }, 500);
  }

  function unhookVideo() {
    if (!hookedVideo) return;
    stopReconcile();
    hookedVideo.removeEventListener("play", onVideoPlay);
    hookedVideo.removeEventListener("pause", onVideoPause);
    hookedVideo.removeEventListener("seeked", onVideoSeeked);
    hookedVideo.removeEventListener("waiting", onVideoWaiting);
    hookedVideo.removeEventListener("canplay", onVideoCanPlay);
    if (_nativePlayListener) {
      hookedVideo.removeEventListener("play", _nativePlayListener);
      _nativePlayListener = null;
    }
    hookedVideo = null;
    isBuffering = false;
    hideBufferingOverlay();
    if (timeReportInterval) { clearInterval(timeReportInterval); timeReportInterval = null; }
  }

  // ── Event handlers (send-on-change, debounced) ────────────────────────────
  // Autoplay suspicion is time-bounded. The only scenario where we really
  // need to distinguish "site-initiated" from "user-initiated" is the first
  // few seconds after sync, when the site might autoplay-resume to its
  // continue-watching position before the user has interacted. Outside
  // that window, any play/pause event is overwhelmingly likely to be user
  // intent (our own command echoes are caught by commandGuard and the
  // expectedPlayState check).
  let _syncedAt = 0;
  let _lastUserActive = 0;
  const SYNC_AUTOPLAY_WINDOW_MS = 3000;
  const USER_ACTIVE_WINDOW_MS = 5000;

  function markUserActive() {
    _lastUserActive = Date.now();
    try { chrome.runtime.sendMessage({ type: "byob:user-active", t: _lastUserActive }); } catch (_) {}
  }

  const _userActiveEvents = ["click", "keydown", "pointerdown", "touchstart"];
  for (const ev of _userActiveEvents) {
    try { document.addEventListener(ev, markUserActive, { capture: true, passive: true }); } catch (_) {}
  }

  function userInitiated() {
    // Outside the post-sync autoplay window, trust all events as user
    // intent. Inside it, require some signal that an actual user clicked
    // — either the browser's per-frame activation bit, or a cross-frame
    // click broadcast we've received via the SW.
    if (_syncedAt && Date.now() - _syncedAt > SYNC_AUTOPLAY_WINDOW_MS) return true;
    if (navigator.userActivation && navigator.userActivation.isActive) return true;
    return Date.now() - _lastUserActive < USER_ACTIVE_WINDOW_MS;
  }

  function onVideoPlay() {
    if (!synced || isBuffering || commandGuard) return;
    if (expectedPlayState === State.PLAYING) return;
    if (!userInitiated()) {
      _log("onVideoPlay ignored — no user activation (autoplay/site-initiated)");
      return;
    }
    if (_pendingPlayPause) clearTimeout(_pendingPlayPause);
    _pendingPlayPause = setTimeout(() => {
      _pendingPlayPause = null;
      if (!hookedVideo || hookedVideo.paused || commandGuard) return;
      expectedPlayState = State.PLAYING;
      updateServerRef(hookedVideo.currentTime, State.PLAYING);
      if (port) port.postMessage({ type: "video:play", position: hookedVideo.currentTime });
      _log("play →server", hookedVideo.currentTime.toFixed(2));
    }, 500);
  }

  function onVideoPause() {
    if (!synced || isBuffering || commandGuard) return;
    if (expectedPlayState === State.PAUSED) return;
    if (!userInitiated()) {
      _log("onVideoPause ignored — no user activation (site-initiated)");
      return;
    }
    if (_pendingPlayPause) clearTimeout(_pendingPlayPause);
    _pendingPlayPause = setTimeout(() => {
      _pendingPlayPause = null;
      if (!hookedVideo || !hookedVideo.paused || commandGuard) return;
      expectedPlayState = State.PAUSED;
      updateServerRef(hookedVideo.currentTime, State.PAUSED);
      if (port) port.postMessage({ type: "video:pause", position: hookedVideo.currentTime });
      _log("pause →server", hookedVideo.currentTime.toFixed(2));
    }, 500);
  }

  function onVideoSeeked() {
    if (!synced || commandGuard) return;
    if (!userInitiated()) {
      _log("onVideoSeeked ignored — no user activation");
      return;
    }
    lastSeekAt = Date.now();
    _hardSeekFailures = 0;
    updateServerRef(hookedVideo.currentTime, serverRef?.playState ?? expectedPlayState);
    if (port) port.postMessage({ type: "video:seek", position: hookedVideo.currentTime });
    if (commandGuard) clearTimeout(commandGuard);
    commandGuard = setTimeout(() => { commandGuard = null; }, 500);
    _log("seek →server", hookedVideo.currentTime.toFixed(2));
  }

  let isBuffering = false;
  function onVideoWaiting() {
    if (!synced || commandGuard) return;
    isBuffering = true;
    showBufferingOverlay();
    updateSyncBarStatus("loading");
  }
  function onVideoCanPlay() {
    if (!isBuffering) return;
    isBuffering = false;
    hideBufferingOverlay();
    if (synced && hookedVideo) {
      updateSyncBarStatus(hookedVideo.paused ? "paused" : "playing");
    }
  }

  // ── Reconcile loop ────────────────────────────────────────────────────────
  // Runs every 500ms once synced. Compares local pos to expected pos derived
  // from serverRef + clockOffset; adjusts playbackRate for small drift,
  // hard-seeks for large drift. Gives up on hard seek after 2 failures and
  // accepts the site's position (for sites that fight programmatic seeks).
  function startReconcile() {
    if (reconcileInterval) return;

    reconcileInterval = setInterval(() => {
      if (!hookedVideo || !synced || !serverRef || commandGuard || needsGesture) return;

      const now = Date.now();
      const actual = hookedVideo.paused ? State.PAUSED : State.PLAYING;

      // State mismatch rectifier. Debounced event handlers handle user-
      // initiated state changes within ~500ms. If mismatch persists longer,
      // event handlers aren't going to fire (the site toggled state silently,
      // e.g. CR autoplay). After a 2s grace period, enforce server state;
      // after 10s of failed enforcement, accept the site's state and update
      // the server.
      if (actual !== expectedPlayState && expectedPlayState) {
        if (_mismatchSince === 0) _mismatchSince = now;
        const dur = now - _mismatchSince;
        if (dur > 10000) {
          _log(`reconcile: accepting site state after ${dur}ms mismatch, actual=${actual} pos=${hookedVideo.currentTime.toFixed(2)}`);
          expectedPlayState = actual;
          updateServerRef(hookedVideo.currentTime, actual);
          if (port) {
            const evt = actual === State.PLAYING ? "video:play" : "video:pause";
            port.postMessage({ type: evt, position: hookedVideo.currentTime });
          }
          _mismatchSince = 0;
        } else if (dur > 2000) {
          _log(`reconcile: enforce expected=${expectedPlayState} actual=${actual} (mismatch ${Math.round(dur)}ms)`);
          if (expectedPlayState === State.PAUSED && !hookedVideo.paused) {
            if (bitmovinAdapter.isReady()) bitmovinAdapter.pause();
            else hookedVideo.pause();
          } else if (expectedPlayState === State.PLAYING && hookedVideo.paused) {
            if (bitmovinAdapter.isReady()) bitmovinAdapter.play();
            else hookedVideo.play().catch(() => {});
          }
        }
        return;
      } else {
        _mismatchSince = 0;
      }

      const recentSeek = (now - lastSeekAt) < 5000;
      if (!clockSynced) return;

      // Paused: don't auto-correct position. User seeks handle position,
      // and tweaking a paused site's currentTime often kicks it back.
      if (serverRef.playState === State.PAUSED || actual === State.PAUSED) return;
      if (serverRef.playState !== State.PLAYING || actual !== State.PLAYING) return;

      const localPos = hookedVideo.currentTime;
      const serverNow = now + clockOffset;
      const elapsed = (serverNow - serverRef.serverTime) / 1000;
      const expectedPos = serverRef.position + elapsed;
      const drift = localPos - expectedPos;
      const absDrift = Math.abs(drift);
      const deadZone = recentSeek ? 2.0 : (syncToleranceMs / 1000);

      if (absDrift < deadZone) {
        if (hookedVideo.playbackRate !== 1.0) hookedVideo.playbackRate = 1.0;
        _hardSeekFailures = 0;
      } else if (absDrift > 5.0 && !recentSeek && _hardSeekFailures < 2) {
        _log(`reconcile HARD SEEK drift=${drift.toFixed(1)}s expected=${expectedPos.toFixed(1)} local=${localPos.toFixed(1)} attempt=${_hardSeekFailures + 1}`);
        _hardSeekFailures++;
        lastSeekAt = now;
        if (commandGuard) clearTimeout(commandGuard);
        commandGuard = setTimeout(() => { commandGuard = null; }, 2000);
        seekTo(expectedPos);
        hookedVideo.playbackRate = 1.0;
      } else if (absDrift > 5.0 && _hardSeekFailures >= 2) {
        _log(`reconcile: giving up on hard seek, accepting site pos=${localPos.toFixed(1)}`);
        _hardSeekFailures = 0;
        updateServerRef(localPos, expectedPlayState);
        if (synced && port) port.postMessage({ type: "video:seek", position: localPos });
        lastSeekAt = now;
      } else if (absDrift > deadZone) {
        // Proportional rate adjustment 0.9–1.1x. Negative drift (behind) →
        // speed up; positive (ahead) → slow down.
        const rate = Math.max(0.9, Math.min(1.1, 1.0 - drift / 5));
        hookedVideo.playbackRate = rate;
      }
    }, 500);
  }

  function stopReconcile() {
    if (reconcileInterval) { clearInterval(reconcileInterval); reconcileInterval = null; }
    if (hookedVideo && hookedVideo.playbackRate !== 1.0) hookedVideo.playbackRate = 1.0;
  }

  function updateServerRef(position, playState, serverTime) {
    serverRef = {
      position,
      playState,
      serverTime: serverTime ?? serverRef?.serverTime ?? 0,
    };
  }

  // One-shot apply of synced state — seek + pause/play once. Autoplay that
  // kicks in later (CR resumes at continue-watching after ~3s) is caught by
  // the reconcile loop's 2s-mismatch-grace → enforcement. Keeping this
  // one-shot (no long-running enforcer) means user clicks right after sync
  // aren't fought by a 250ms-tick background loop.
  function applySyncedState(msg) {
    if (!hookedVideo) return;
    const target = msg.current_time;
    const wantPaused = expectedPlayState === State.PAUSED;
    if (target != null && Math.abs(hookedVideo.currentTime - target) > 2.0) {
      seekTo(target);
      lastSeekAt = Date.now();
    }
    if (wantPaused && !hookedVideo.paused) {
      if (bitmovinAdapter.isReady()) bitmovinAdapter.pause();
      else hookedVideo.pause();
    } else if (!wantPaused && hookedVideo.paused) {
      if (bitmovinAdapter.isReady()) bitmovinAdapter.play(target);
      else hookedVideo.play().catch(() => {});
    }
  }

  // ── Command guard ─────────────────────────────────────────────────────────
  // After executing a server command, suppress outgoing events until the
  // video state matches what we commanded. 300ms min, 5s max. Prevents
  // third-party sites' internal transitions (DRM, buffering, player init)
  // from echoing back to the server.
  // Minimum guard window. Default 300ms for discrete commands (play/pause).
  // Synced uses a longer minimum so a site's autoplay that fires ~3s after
  // the sync doesn't propagate as a play event through onVideoPlay.
  let _guardMinMs = 300;
  function startCommandGuard(minMs = 300) {
    if (commandGuard) clearTimeout(commandGuard);
    _guardStartedAt = Date.now();
    _guardMinMs = minMs;
    commandGuard = setTimeout(checkGuard, Math.min(minMs, 300));
  }

  function checkGuard() {
    const elapsed = Date.now() - _guardStartedAt;
    if (elapsed > 5000 || !hookedVideo || !expectedPlayState) {
      commandGuard = null;
      return;
    }
    const actual = hookedVideo.paused ? State.PAUSED : State.PLAYING;
    // Hold the guard until BOTH the minimum has elapsed AND state matches,
    // so site-initiated events during the minimum window can't leak out.
    if (elapsed >= _guardMinMs && actual === expectedPlayState) {
      commandGuard = null;
    } else {
      commandGuard = setTimeout(checkGuard, 200);
    }
  }

  // ── SW message handling ───────────────────────────────────────────────────
  function handleSWMessage(msg) {
    if (msg.type === "byob:channel-ready" && window === window.top) {
      if (!synced && needsGesture) {
        updateSyncBarStatus("searching");
        showJoinToast("Play the video to start syncing");
      }
      return;
    }
    if (msg.type === "byob:video-hooked" && window === window.top) {
      if (!window.location.hostname.includes("youtube.com")) injectSyncBar();
      return;
    }

    if (msg.type === "byob:clock-sync") {
      clockOffset = msg.offset;
      clockRtt = msg.rtt;
      clockSynced = true;
      _log("clock synced offset=", clockOffset, "ms rtt=", clockRtt, "ms");
      return;
    }

    if (msg.type === "byob:user-active") {
      if (msg.t && msg.t > _lastUserActive) _lastUserActive = msg.t;
      return;
    }

    if (msg.type === "byob:presence" && window === window.top) {
      const verb = msg.event === "joined" ? "joined" : "left";
      showPresenceToast(`${msg.username} ${verb} the room`);
      return;
    }

    if (msg.type === "byob:bar-update" && window === window.top && synced) {
      renderBarUpdate(msg);
      return;
    }

    if (msg.type === "autoplay:countdown" && window === window.top) {
      startCountdown(msg.duration_ms || 5000);
      return;
    }
    if (msg.type === "autoplay:cancelled" && window === window.top) {
      clearCountdown();
      return;
    }

    if (msg.type === "command:initial-state") {
      tryAutoSync();
      return;
    }

    if (msg.type === "command:synced") {
      const wasSynced = synced;
      synced = true;
      needsGesture = false;
      _syncedAt = Date.now();

      // Always overwrite expectedPlayState/serverRef from the synced payload
      // — it's the authoritative handoff of room state to this client.
      if (msg.play_state) {
        expectedPlayState = msg.play_state === "playing" ? State.PLAYING : State.PAUSED;
        updateServerRef(msg.current_time ?? 0, expectedPlayState, msg.server_time);
      }

      hideJoinToast();
      _log("synced! expected=", expectedPlayState, "hasVideo=", !!hookedVideo, "clockSynced=", clockSynced);

      if (hookedVideo) {
        // Arm the command guard so the resulting DOM events (seeked / pause
        // / play) from applySyncedState are treated as echoes. Releases as
        // soon as state matches. Any later autoplay from the site is
        // caught by the userActivation check in the event handlers.
        startCommandGuard();
        applySyncedState(msg);
        updateSyncBarStatus(hookedVideo.paused ? "paused" : "playing");
        if (!wasSynced && port) port.postMessage({ type: "video:ready" });
        startReconcile();
      } else if (window === window.top) {
        updateSyncBarStatus(expectedPlayState === State.PAUSED ? "paused" : "playing");
      }
      return;
    }

    if (msg.type === "byob:ready-count" && window === window.top) {
      updateReadyCount(msg.ready, msg.has_tab, msg.total, msg.needs_open || [], msg.needs_play || []);
      return;
    }

    if (!hookedVideo) return;

    // If waiting for gesture and a play command arrives, try playing —
    // the browser may allow it if the user interacted with the page.
    if (needsGesture && msg.type === "command:play") {
      _log("cmd:play while needsGesture — attempting play()");
      if (msg.position != null) seekTo(msg.position);
      const p = bitmovinAdapter.isReady() ? null : hookedVideo.play();
      const onStart = () => {
        needsGesture = false;
        hideJoinToast();
        requestSync();
      };
      if (p && p.then) {
        p.then(onStart).catch(() => _log("play() failed — still need gesture"));
      } else {
        if (bitmovinAdapter.isReady()) bitmovinAdapter.play(msg.position);
        onStart();
      }
      return;
    }

    if (needsGesture) return;

    // Ignore stale commands — server_time must be newer than what we have.
    if (msg.server_time != null && serverRef && msg.server_time <= serverRef.serverTime) {
      if (msg.type !== "sync:correction") {
        _log(`ignoring stale ${msg.type}: server_time=${msg.server_time} <= ${serverRef.serverTime}`);
        return;
      }
    }

    // Cancel any pending debounced play/pause — server command wins.
    if (_pendingPlayPause) { clearTimeout(_pendingPlayPause); _pendingPlayPause = null; }

    switch (msg.type) {
      case "command:play":
        _log("cmd:play pos=", msg.position, "server_time=", msg.server_time);
        expectedPlayState = State.PLAYING;
        updateServerRef(msg.position ?? hookedVideo.currentTime, State.PLAYING, msg.server_time);
        startCommandGuard();
        if (bitmovinAdapter.isReady()) {
          bitmovinAdapter.play(msg.position);
        } else {
          if (msg.position != null) seekTo(msg.position);
          if (hookedVideo.paused) hookedVideo.play().catch(() => {});
        }
        startReconcile();
        break;

      case "command:pause":
        _log("cmd:pause pos=", msg.position, "server_time=", msg.server_time);
        expectedPlayState = State.PAUSED;
        updateServerRef(msg.position ?? hookedVideo.currentTime, State.PAUSED, msg.server_time);
        startCommandGuard();
        if (bitmovinAdapter.isReady()) {
          bitmovinAdapter.pause(msg.position);
        } else {
          if (msg.position != null) seekTo(msg.position);
          if (!hookedVideo.paused) hookedVideo.pause();
        }
        startReconcile();
        break;

      case "command:seek":
        _log("cmd:seek pos=", msg.position, "server_time=", msg.server_time);
        lastSeekAt = Date.now();
        updateServerRef(msg.position, serverRef?.playState ?? expectedPlayState, msg.server_time);
        if (commandGuard) clearTimeout(commandGuard);
        commandGuard = setTimeout(() => { commandGuard = null; }, 1000);
        seekTo(msg.position);
        break;

      case "sync:correction":
        // Server periodic refresh (every few seconds). Updates reference so
        // reconcile can drift-correct. No direct player action here.
        if (msg.expected_time != null) {
          updateServerRef(msg.expected_time, serverRef?.playState ?? expectedPlayState, msg.server_time);
        }
        break;
    }
  }

  // ── Gesture / sync bootstrap ──────────────────────────────────────────────
  function tryAutoSync() {
    if (!hookedVideo) return;
    if (!needsGesture || !hookedVideo.paused) {
      needsGesture = false;
      hideJoinToast();
      requestSync();
    } else {
      needsGesture = true;
      updateSyncBarStatus("clickjoin");
      showJoinToast("Click play on the video to start syncing");
      waitForNativePlay();
    }
  }

  function requestSync() {
    hideJoinToast();
    updateSyncBarStatus("syncing");
    if (port) port.postMessage({ type: "video:request-sync" });
  }

  let _nativePlayListener = null;
  function waitForNativePlay() {
    if (!hookedVideo) return;
    if (!hookedVideo.paused) {
      needsGesture = false;
      requestSync();
      return;
    }
    if (_nativePlayListener) {
      hookedVideo.removeEventListener("play", _nativePlayListener);
    }
    _nativePlayListener = () => {
      if (_nativePlayListener) {
        hookedVideo?.removeEventListener("play", _nativePlayListener);
        _nativePlayListener = null;
      }
      needsGesture = false;
      requestSync();
    };
    hookedVideo.addEventListener("play", _nativePlayListener);
  }

  // ── Sync bar UI ───────────────────────────────────────────────────────────
  function showJoinToast(text) {
    if (window !== window.top) return;
    hideJoinToast();

    const toast = document.createElement("div");
    toast.id = "byob-join-toast";
    toast.style.cssText = `
      position: fixed; bottom: 48px; left: 50%; transform: translateX(-50%);
      z-index: 999999; background: #7c3aed; color: white;
      font-family: system-ui, sans-serif; font-size: 15px; font-weight: 600;
      padding: 14px 28px; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(124, 58, 237, 0.5), 0 0 0 1px rgba(255,255,255,0.15);
      pointer-events: none;
      animation: byob-toast-pulse 2s ease-in-out infinite;
    `;
    toast.textContent = text;
    const style = document.createElement("style");
    style.id = "byob-toast-style";
    style.textContent = `
      @keyframes byob-toast-pulse {
        0%, 100% { opacity: 1; box-shadow: 0 4px 24px rgba(124, 58, 237, 0.5), 0 0 0 1px rgba(255,255,255,0.15); }
        50% { opacity: 0.85; box-shadow: 0 4px 32px rgba(124, 58, 237, 0.7), 0 0 0 1px rgba(255,255,255,0.25); }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(toast);
  }

  function hideJoinToast() {
    const toast = document.getElementById("byob-join-toast");
    if (toast) toast.remove();
    const style = document.getElementById("byob-toast-style");
    if (style) style.remove();
  }

  // Brief, non-blocking toast for room presence changes ("X joined" / "X left").
  // Styled like showJoinToast but self-dismisses after 2.5s and stacks if
  // multiple events land close together.
  let _presenceToastHideTimer = null;
  function showPresenceToast(text) {
    if (window !== window.top) return;
    const existing = document.getElementById("byob-presence-toast");
    if (existing) existing.remove();
    if (_presenceToastHideTimer) { clearTimeout(_presenceToastHideTimer); _presenceToastHideTimer = null; }

    const toast = document.createElement("div");
    toast.id = "byob-presence-toast";
    toast.style.cssText = `
      position: fixed; bottom: 48px; left: 50%; transform: translateX(-50%) translateY(10px);
      z-index: 999998; background: #7c3aed; color: white;
      font-family: system-ui, sans-serif; font-size: 15px; font-weight: 600;
      padding: 12px 24px; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(124, 58, 237, 0.5), 0 0 0 1px rgba(255,255,255,0.15);
      pointer-events: none; opacity: 0; transition: opacity 0.2s ease, transform 0.2s ease;
    `;
    toast.textContent = text;
    document.body.appendChild(toast);
    // Next frame: fade in
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateX(-50%) translateY(0)";
    });
    _presenceToastHideTimer = setTimeout(() => {
      _presenceToastHideTimer = null;
      toast.style.opacity = "0";
      toast.style.transform = "translateX(-50%) translateY(10px)";
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 250);
    }, 2500);
  }

  function injectSyncBar() {
    if (document.getElementById("byob-sync-bar")) return;

    const bar = document.createElement("div");
    bar.id = "byob-sync-bar";
    bar.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 999999;
      background: rgba(0,0,0,0.92); color: white;
      font-family: system-ui, sans-serif; font-size: 13px;
      backdrop-filter: blur(10px); border-top: 1px solid rgba(255,255,255,0.15);
      transition: all 0.2s ease;
    `;

    const content = document.createElement("div");
    content.id = "byob-bar-content";
    content.style.cssText = "display:flex;align-items:center;gap:10px;padding:6px 16px;";

    const logo = document.createElement("span");
    logo.style.cssText = "font-weight:bold;font-size:14px;opacity:0.7;flex-shrink:0";
    logo.textContent = "byob";

    const dot = document.createElement("span");
    dot.id = "byob-dot";
    dot.style.cssText = "width:6px;height:6px;border-radius:50%;background:#888;flex-shrink:0";

    const status = document.createElement("span");
    status.id = "byob-status";
    status.style.cssText = "color:#888;font-size:12px;flex-shrink:0;cursor:default";
    status.textContent = "Loading...";

    const playPauseBtn = document.createElement("button");
    playPauseBtn.id = "byob-playpause";
    playPauseBtn.style.cssText = "display:none;background:none;border:none;color:white;cursor:pointer;font-size:14px;padding:0;margin:0;line-height:1;opacity:0.8;flex-shrink:0;outline:none;-webkit-user-select:none;user-select:none;vertical-align:middle;";
    playPauseBtn.textContent = "▶";
    playPauseBtn.addEventListener("click", () => {
      if (!port) return;
      if (playPauseBtn.dataset.playing === "true") {
        port.postMessage({ type: "video:pause", position: parseFloat(playPauseBtn.dataset.position || 0) });
      } else {
        port.postMessage({ type: "video:play", position: parseFloat(playPauseBtn.dataset.position || 0) });
      }
    });

    const progressWrap = document.createElement("div");
    progressWrap.id = "byob-progress-wrap";
    progressWrap.style.cssText = "display:none;flex:1;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;cursor:pointer;position:relative;min-width:60px;";
    const progressFill = document.createElement("div");
    progressFill.id = "byob-progress-fill";
    progressFill.style.cssText = "height:100%;background:#7c3aed;border-radius:2px;width:0%;transition:width 0.3s linear;pointer-events:none;";
    progressWrap.appendChild(progressFill);
    progressWrap.addEventListener("click", (e) => {
      const rect = progressWrap.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const dur = parseFloat(progressWrap.dataset.duration || 0);
      if (dur > 0 && port) port.postMessage({ type: "video:seek", position: frac * dur });
    });

    const time = document.createElement("span");
    time.id = "byob-time";
    time.style.cssText = "font-variant-numeric:tabular-nums;opacity:0.6;font-size:12px;flex-shrink:0";

    const usersEl = document.createElement("span");
    usersEl.id = "byob-users";
    usersEl.style.cssText = "display:none;font-size:12px;flex-shrink:0;gap:4px;align-items:center;font-variant-numeric:tabular-nums;cursor:default";
    const usersIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    usersIcon.id = "byob-users-icon";
    usersIcon.setAttribute("width", "14");
    usersIcon.setAttribute("height", "14");
    usersIcon.setAttribute("viewBox", "0 0 24 24");
    usersIcon.setAttribute("fill", "rgba(255,255,255,0.5)");
    usersIcon.style.flexShrink = "0";
    const usersPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    usersPath.setAttribute("d", "M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z");
    usersIcon.appendChild(usersPath);
    const usersCount = document.createElement("span");
    usersCount.id = "byob-users-count";
    usersCount.style.opacity = "0.5";
    usersCount.textContent = "0/0";
    usersEl.appendChild(usersIcon);
    usersEl.appendChild(usersCount);

    const collapse = document.createElement("button");
    collapse.id = "byob-collapse";
    collapse.style.cssText = "background:none;color:white;border:none;cursor:pointer;font-size:14px;opacity:0.5;padding:0 4px;line-height:1;outline:none;-webkit-user-select:none;user-select:none;flex-shrink:0;";
    collapse.textContent = "▼";

    content.append(logo, dot, status, usersEl, playPauseBtn, progressWrap, time, collapse);
    bar.appendChild(content);

    let collapsed = false;
    collapse.addEventListener("click", () => {
      collapsed = !collapsed;
      if (collapsed) {
        bar.style.left = "auto"; bar.style.right = "16px"; bar.style.bottom = "8px";
        bar.style.borderRadius = "6px";
        bar.style.border = "1px solid rgba(255,255,255,0.15)";
        content.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 10px;";
        [dot, status, time, playPauseBtn, progressWrap].forEach(el => el.style.display = "none");
        collapse.textContent = "▲";
      } else {
        bar.style.left = "0"; bar.style.right = "0"; bar.style.bottom = "0";
        bar.style.borderRadius = "0";
        bar.style.border = "none";
        bar.style.borderTop = "1px solid rgba(255,255,255,0.15)";
        content.style.cssText = "display:flex;align-items:center;gap:10px;padding:6px 16px;";
        [dot, status, time].forEach(el => el.style.display = "");
        if (synced) [playPauseBtn, progressWrap].forEach(el => el.style.display = "");
        collapse.textContent = "▼";
      }
    });

    document.body.appendChild(bar);
  }

  function renderBarUpdate(msg) {
    const fmt = (s) => Math.floor(s / 60) + ":" + Math.floor(s % 60).toString().padStart(2, "0");
    const timeEl = document.getElementById("byob-time");
    const statusEl = document.getElementById("byob-status");
    const dotEl = document.getElementById("byob-dot");
    const playPauseBtn = document.getElementById("byob-playpause");
    const progressWrap = document.getElementById("byob-progress-wrap");
    const progressFill = document.getElementById("byob-progress-fill");

    if (timeEl && msg.duration > 0) timeEl.textContent = fmt(msg.position) + " / " + fmt(msg.duration);
    else if (timeEl) timeEl.textContent = fmt(msg.position);

    if (statusEl && dotEl && !_countdownInterval) {
      if (msg.playing) {
        statusEl.textContent = "Playing"; statusEl.style.color = "#00d400"; dotEl.style.background = "#00d400";
        statusEl.title = "Video is playing in sync with the room";
      } else {
        statusEl.textContent = "Paused"; statusEl.style.color = "#ff9900"; dotEl.style.background = "#ff9900";
        statusEl.title = "Video is paused — synced with room";
      }
    }

    if (playPauseBtn) {
      playPauseBtn.style.display = "";
      playPauseBtn.textContent = msg.playing ? "⏸" : "▶";
      playPauseBtn.dataset.playing = msg.playing;
      playPauseBtn.dataset.position = msg.position;
    }
    if (progressWrap && progressFill) {
      progressWrap.style.display = "";
      progressWrap.dataset.duration = msg.duration;
      if (msg.duration > 0) progressFill.style.width = ((msg.position / msg.duration) * 100) + "%";
    }
  }

  function updateReadyCount(ready, hasTab, total, needsOpen, needsPlay) {
    const el = document.getElementById("byob-users");
    const icon = document.getElementById("byob-users-icon");
    const count = document.getElementById("byob-users-count");
    if (!el || !icon || !count) return;

    if (!total || total <= 0) { el.style.display = "none"; return; }

    el.style.display = "flex";
    const allReady = ready >= total && total > 0;
    count.textContent = `${ready}/${total}`;
    icon.setAttribute("fill", allReady ? "#00d400" : "rgba(255,255,255,0.5)");
    count.style.opacity = allReady ? "1" : "0.5";
    count.style.color = allReady ? "#00d400" : "white";

    const parts = [];
    if (allReady) {
      parts.push(`All ${total} users synced and ready to play`);
    } else {
      parts.push(`${ready} of ${total} ready`);
      const openList = Array.isArray(needsOpen) ? needsOpen : [];
      const playList = Array.isArray(needsPlay) ? needsPlay : [];
      const needTab = openList.length || (total - hasTab);
      const needClick = playList.length || (hasTab - ready);
      if (needTab > 0) {
        const names = openList.length ? ` (${openList.join(", ")})` : "";
        parts.push(`${needTab} need${needTab === 1 ? "s" : ""} to open player window${names}`);
      }
      if (needClick > 0) {
        const names = playList.length ? ` (${playList.join(", ")})` : "";
        parts.push(`${needClick} need${needClick === 1 ? "s" : ""} to hit play${names}`);
      }
    }
    el.title = parts.join(" · ");
  }

  let _countdownInterval = null;
  function startCountdown(durationMs) {
    clearCountdown();
    const endTime = Date.now() + durationMs;
    updateSyncBarStatus("finished");
    const statusEl = document.getElementById("byob-status");
    const update = () => {
      const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
      if (statusEl) {
        statusEl.textContent = remaining > 0 ? `Finished — next in ${remaining}s` : "Loading next...";
        statusEl.style.color = "#7c3aed";
      }
      if (remaining <= 0) clearCountdown();
    };
    update();
    _countdownInterval = setInterval(update, 500);
  }
  function clearCountdown() {
    if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null; }
  }

  function updateSyncBarStatus(state) {
    const dot = document.getElementById("byob-dot");
    const status = document.getElementById("byob-status");
    if (!dot || !status) return;
    const states = {
      loading:   { color: "#888",    text: "Connecting...",                      tip: "Connecting to the byob room server" },
      searching: { color: "#ff9900", text: "Play the video to start syncing",    tip: "Waiting for a video element on this page" },
      syncing:   { color: "#ff9900", text: "Syncing...",                         tip: "Applying room state to this player" },
      clickjoin: { color: "#ff9900", text: "Click play to sync",                 tip: "Click play on the video player above to start syncing with the room" },
      playing:   { color: "#00d400", text: "Playing",                            tip: "Video is playing in sync with the room" },
      paused:    { color: "#ff9900", text: "Paused",                             tip: "Video is paused — synced with room" },
      finished:  { color: "#7c3aed", text: "Finished",                           tip: "Video ended — next video loading" },
    };
    const s = states[state];
    if (!s) return;
    dot.style.background = s.color;
    status.style.color = s.color;
    status.textContent = s.text;
    status.title = s.tip;
  }

  // Buffering overlay
  function showBufferingOverlay() {
    if (window !== window.top || document.getElementById("byob-buffering-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "byob-buffering-overlay";
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 40px; z-index: 999997;
      background: rgba(0,0,0,0.4); display: flex; align-items: center;
      justify-content: center; pointer-events: none;
    `;
    const inner = document.createElement("div");
    inner.style.cssText = "text-align:center;color:white;font-family:system-ui,sans-serif;";
    const spinner = document.createElement("div");
    spinner.style.cssText = "width:48px;height:48px;border:3px solid rgba(255,255,255,0.3);border-top-color:#7c3aed;border-radius:50%;animation:byob-spin 0.8s linear infinite;margin:0 auto 12px;";
    const label = document.createElement("div");
    label.style.cssText = "font-size:14px;font-weight:500;";
    label.textContent = "Buffering...";
    inner.append(spinner, label);
    overlay.appendChild(inner);
    let styleEl = document.getElementById("byob-buffering-style");
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "byob-buffering-style";
      styleEl.textContent = "@keyframes byob-spin { to { transform: rotate(360deg); } }";
      document.head.appendChild(styleEl);
    }
    document.body.appendChild(overlay);
  }
  function hideBufferingOverlay() {
    const el = document.getElementById("byob-buffering-overlay");
    if (el) el.remove();
  }

  function cleanup() {
    activateArgs = null;
    synced = false;
    unhookVideo();
    const bar = document.getElementById("byob-sync-bar");
    if (bar) bar.remove();
  }

  // ── YouTube embed sponsor segments ────────────────────────────────────────
  function initYouTubeEmbed() {
    if (!window.location.hostname.includes("youtube.com")) return;
    if (!window.location.pathname.startsWith("/embed/")) return;

    window.addEventListener("message", (e) => {
      if (!e.data || e.data.type !== "byob:sponsor-segments") return;
      const { segments, duration } = e.data;
      if (!segments || !duration) return;

      const tryInject = (attempt) => {
        if (attempt > 20) return;
        const progressBar =
          document.querySelector(".ytp-progress-list") ||
          document.querySelector("yt-progress-bar-line .ytProgressBarLineProgressBarLine") ||
          document.querySelector(".ytProgressBarLineProgressBarLine") ||
          document.querySelector(".ytp-progress-bar");
        if (!progressBar) {
          setTimeout(() => tryInject(attempt + 1), 500);
          return;
        }
        injectSegments(progressBar, segments, duration);
      };
      tryInject(0);
    });

    try { window.parent.postMessage({ type: "byob:embed-ready" }, "*"); } catch (_) {}
  }

  function injectSegments(progressBar, segments, duration) {
    progressBar.querySelectorAll(".byob-sponsor-segment").forEach((el) => el.remove());
    const colors = {
      sponsor: "#00d400", selfpromo: "#ffff00", interaction: "#cc00ff",
      intro: "#00ffff", outro: "#0202ed", preview: "#008fd6",
      music_offtopic: "#ff9900", filler: "#7300FF",
    };
    const labels = {
      sponsor: "Sponsor", selfpromo: "Self Promotion", interaction: "Interaction",
      intro: "Intro", outro: "Outro", preview: "Preview",
      music_offtopic: "Non-Music", filler: "Filler",
    };
    if (getComputedStyle(progressBar).position === "static") {
      progressBar.style.position = "relative";
    }
    const playhead = document.querySelector("yt-progress-bar-playhead, .ytp-scrubber-container");
    if (playhead) playhead.style.zIndex = "50";
    for (const seg of segments) {
      const left = (seg.segment[0] / duration) * 100;
      const width = Math.max(0.3, ((seg.segment[1] - seg.segment[0]) / duration) * 100);
      const el = document.createElement("div");
      el.className = "byob-sponsor-segment";
      el.title = labels[seg.category] || seg.category;
      el.style.cssText = `
        position: absolute; bottom: 0; left: ${left}%; width: ${width}%;
        height: 3px; background: ${colors[seg.category] || "#00d400"};
        opacity: 0.8; z-index: 0; pointer-events: none; border-radius: 1px;
      `;
      progressBar.appendChild(el);
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  init();
  initYouTubeEmbed();
})();
