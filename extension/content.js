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
  const PORT_NAME = "watchparty";
  // Relay across the navigation triggered by COMMAND_VIDEO_CHANGE so the
  // post-nav content script can surface a presence-style toast on the new
  // page ("Followed room to: <title>"). Cleared as soon as it's read.
  const PENDING_NAV_TOAST_KEY = "byob_pending_nav_toast";
  const PENDING_NAV_TOAST_TTL_MS = 15000;

  // Named event strings. Mirror Byob.Events on the server and the same table
  // duplicated in extension/background.js (MV3 content scripts can't import).
  // Group by flow direction.
  const EVT = Object.freeze({
    // content.js → background.js (port.postMessage / chrome.runtime.sendMessage)
    CONNECT: "connect",
    DEBUG_LOG: "debug:log",
    VIDEO_HOOKED: "video:hooked",
    VIDEO_STATE: "video:state",
    VIDEO_PLAY: "video:play",
    VIDEO_PAUSE: "video:pause",
    VIDEO_SEEK: "video:seek",
    VIDEO_ENDED: "video:ended",
    VIDEO_READY: "video:ready",
    VIDEO_LIVE_STATUS: "video:live_status",
    VIDEO_REQUEST_SYNC: "video:request-sync",
    VIDEO_UPDATE_URL: "video:update_url",
    VIDEO_DRIFT: "video:drift",

    // background.js → content.js (port message)
    COMMAND_PLAY: "command:play",
    COMMAND_PAUSE: "command:pause",
    COMMAND_SEEK: "command:seek",
    COMMAND_INITIAL_STATE: "command:initial-state",
    COMMAND_SYNCED: "command:synced",
    COMMAND_QUEUE_ENDED: "command:queue-ended",
    COMMAND_VIDEO_CHANGE: "command:video-change",
    COMMAND_LIVE_STATUS: "command:live-status",
    SYNC_CORRECTION: "sync:correction",
    SYNC_SEEK_COMMAND: "sync:seek_command",
    AUTOPLAY_COUNTDOWN: "autoplay:countdown",
    AUTOPLAY_CANCELLED: "autoplay:cancelled",

    // Extension-internal broadcasts (chrome.runtime.sendMessage)
    BYOB_VIDEO_HOOKED: "byob:video-hooked",
    BYOB_USER_ACTIVE: "byob:user-active",
    BYOB_CHANNEL_READY: "byob:channel-ready",
    BYOB_CLOCK_SYNC: "byob:clock-sync",
    BYOB_PRESENCE: "byob:presence",
    BYOB_BAR_UPDATE: "byob:bar-update",
    BYOB_READY_COUNT: "byob:ready-count",
    BYOB_EMBED_READY: "byob:embed-ready",
    BYOB_CHECK_MANAGED: "byob:check-managed",

    // Page-world CustomEvents (window.postMessage) — contract with
    // assets/js (LiveView). Matching literals live in assets/js/app.js,
    // assets/js/hooks/video_player.js, assets/js/sponsor_block.js.
    BYOB_CLEAR_EXTERNAL: "byob:clear-external",
    BYOB_OPEN_EXTERNAL: "byob:open-external",
    BYOB_FOCUS_EXTERNAL: "byob:focus-external",
    BYOB_RELAY: "byob:relay",
    BYOB_SPONSOR_SEGMENTS: "byob:sponsor-segments",
  });

  // Presence event values inside EVT.BYOB_PRESENCE payloads (mirror
  // Byob.Events.presence_*).
  const PRESENCE = Object.freeze({
    JOINED: "joined",
    LEFT: "left",
    EXT_CLOSED: "ext_closed",
  });

  // ── State ─────────────────────────────────────────────────────────────────
  let port = null;
  let hookedVideo = null;
  let synced = false;
  let needsGesture = true;
  let isLive = false; // current item live status (URL hint + runtime detection)
  let currentItemId = null; // server-assigned id of the room's current media item
  let timeReportInterval = null;
  let reconcileInterval = null;
  let commandGuard = null;         // suppress outgoing events after a server command
  let _guardStartedAt = 0;
  let expectedPlayState = null;    // State.PLAYING / State.PAUSED / null
  let serverRef = null;            // { position, playState, serverTime }
  let lastSeekAt = 0;
  let _pendingPlayPause = null;    // debounced send
  let _mismatchSince = 0;          // Date.now() when actual≠expected started
  // Server-authoritative model: extension just measures drift + jitter
  // and reports them. The server (Byob.SyncDecision) decides when and
  // where to seek and pushes `sync:seek_command`. No local offset EMA,
  // no hard-seek logic, no rate correction — matches the browser-side
  // reconcile.js shape after v6.7.0.
  let _lastDriftMs = 0;
  let _jitterEmaMs = 0;
  let _jitterSamples = 0;
  let _lastSeekExecutedAt = 0;
  const _JITTER_ALPHA = 0.1;       // ~1 s horizon at 500 ms tick
  const _POST_SEEK_QUIET_MS = 5000; // pause jitter EMA for 5 s after a seek

  // ── Timing constants (ms) ─────────────────────────────────────────────────
  const RECONCILE_TICK_MS = 500;
  const STATE_REPORT_TICK_MS = 500;
  const PLAY_PAUSE_DEBOUNCE_MS = 500;
  const SEEK_COMMAND_GUARD_MS = 500;
  const SEEK_HARD_COMMAND_GUARD_MS = 2000;
  const CMD_SEEK_COMMAND_GUARD_MS = 1000;
  const COMMAND_GUARD_MAX_MS = 5000;
  const COMMAND_GUARD_CHECK_MS = 200;
  const MISMATCH_ACCEPT_MS = 10000;
  const MISMATCH_ENFORCE_MS = 2000;
  const ACTIVATE_RETRY_MS = 500;
  const TOAST_FADE_MS = 250;
  const COUNTDOWN_TICK_MS = 500;
  const SYNC_BAR_RETRY_MS = 500;
  const URL_POLL_MS = 1000;
  // Drift thresholds + rate correction live on the server now (see
  // lib/byob/sync_decision.ex). Extension is dumb: report drift, execute
  // seek commands.
  const VIDEO_ENDED_TAIL_S = 3;
  const MIN_ENDED_DURATION_S = 60;

  // ── Room URL tracking (v6.5: URL-mismatch toast) ──────────────────────────
  // `_syncedUrl` is the canonical URL of the room's current media item.
  // Set from COMMAND_INITIAL_STATE / COMMAND_SYNCED / COMMAND_VIDEO_CHANGE.
  // When `location.href` diverges from it (SPA nav / manual browse / autoplay
  // to next episode on the site), we show a persistent purple toast with
  // two buttons: re-sync (reload canonical URL) or update-room (push the
  // current URL to the server).
  let _syncedUrl = null;
  let _urlPollInterval = null;
  let _urlMismatchShown = false;
  // Echo suppression is handled entirely by commandGuard:
  //   - After any server command (play/pause/seek/synced), commandGuard is
  //     armed and auto-releases once the video's actual state matches what
  //     we commanded (or after 5s max).
  //   - While armed, event handlers drop their outbound sends.
  //   - No time-based "settling" window — behavior is deterministic against
  //     the commands we've executed.
  let _endedReported = false;
  let _lastPolledPaused = null; // reset per hook; used to detect missed pause events
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
        port.postMessage({ type: EVT.DEBUG_LOG, message: msg });
      } catch (_) {}
    }
  }


  // Signal extension is installed. The byob LV root template renders
  // <html data-byob-app="1"> on every page it owns; checking that marker
  // means the detection works on any host (LAN access, ngrok tunnel,
  // dev server on a non-localhost name) without leaking extension presence
  // to unrelated sites.
  const _isByobApp =
    document.documentElement.hasAttribute("data-byob-app") ||
    window.location.hostname === "byob.video" ||
    window.location.hostname === "localhost";
  if (_isByobApp) {
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
        return;
      }
      if (d.time != null) {
        if (!last) last = {};
        last.time = d.time;
      }
      // Bitmovin's MSE pipeline doesn't always bubble pause/play/seeked to
      // the <video> element that our native listeners are attached to.
      // Route the player's own events through to the same handlers so
      // user-initiated pause via CR's controls reaches the server.
      if (!ready) return;
      if (d.event === "paused") onVideoPause();
      else if (d.event === "play") onVideoPlay();
      else if (d.event === "seeked") onVideoSeeked();
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

  // Surface a presence-style toast on the post-nav page when the previous
  // content script (on the prior URL) auto-navigated this tab in response
  // to a room URL change. Always clears the storage key — even if the
  // hint is too old to display — so a stale relay can't fire later.
  async function maybeShowFollowedToast() {
    if (window !== window.top) return;
    try {
      const cfg = await chrome.storage.local.get(PENDING_NAV_TOAST_KEY);
      const data = cfg[PENDING_NAV_TOAST_KEY];
      if (data) {
        try { await chrome.storage.local.remove(PENDING_NAV_TOAST_KEY); } catch (_) {}
        if (data.at && Date.now() - data.at < PENDING_NAV_TOAST_TTL_MS) {
          const text = data.title
            ? `Synced to room — now playing: ${data.title}`
            : "Synced to room — now playing this page";
          // showPresenceToast self-dismisses after ~2.5s with the same
          // purple styling as the "X joined / X closed window" toasts.
          if (document.body) {
            showPresenceToast(text);
          } else {
            document.addEventListener("DOMContentLoaded", () => showPresenceToast(text), { once: true });
          }
        }
      }
    } catch (_) {}
  }

  // ── Init / activation ─────────────────────────────────────────────────────
  async function init() {
    maybeShowFollowedToast();
    window.addEventListener("message", (e) => {
      if (e.origin !== window.location.origin) return;
      try {
        if (e.data?.type === EVT.BYOB_CLEAR_EXTERNAL) {
          // Backward-compat no-op: per-tab byob-managed tracking in
          // the BG (with chrome.tabs.onRemoved cleanup) replaced the
          // chrome.storage.local handoff this used to clear.
          return;
        }
        if (e.data?.type === EVT.BYOB_FOCUS_EXTERNAL) {
          // YouTube COOP severs window-name reuse + cross-COOP focus(),
          // so the LV main page can't bring its popup forward by itself.
          // Hop through chrome.runtime so the BG can use chrome.tabs.update
          // / chrome.windows.update to switch focus to the popup tab.
          try { chrome.runtime.sendMessage({ type: EVT.BYOB_FOCUS_EXTERNAL }); } catch (_) {}
          return;
        }
        if (e.data?.type === EVT.BYOB_OPEN_EXTERNAL) {
          // Forward to the BG so it can mark the about-to-be-opened
          // tab as byob-managed via openerTabId. Replaces the older
          // chrome.storage.local handoff, which let any tab on a
          // matching URL claim activation (including tabs opened by
          // other tools — e.g. a different sync extension's popup).
          try {
            chrome.runtime.sendMessage({
              type: EVT.BYOB_OPEN_EXTERNAL,
              config: {
                room_id: e.data.room_id,
                server_url: e.data.server_url,
                target_url: e.data.url,
                token: e.data.token,
                username: e.data.username,
              },
            });
          } catch (_) {}
        }
      } catch (_) {}
    });

    const tryActivate = async (attempt) => {
      if (attempt > 5) return;
      const host = window.location.hostname;
      if (host === "byob.video" || host === "localhost") return;
      try {
        // Ask the BG: was this tab opened from a byob room? Only tabs
        // whose openerTabId matches a recent byob:open-external from
        // the byob.video page are managed. Any tab the user landed on
        // via other means (another extension's popup, manual nav,
        // etc.) gets {managed: false} and we stay dormant.
        const response = await chrome.runtime.sendMessage({ type: EVT.BYOB_CHECK_MANAGED });
        if (response?.managed && response.config) {
          const { room_id, server_url, token, username } = response.config;
          const isTopFrame = window === window.top;
          if (isTopFrame) showJoinToast("Loading byob sync...");
          activate(room_id, server_url, token, username);
          return;
        }
      } catch (_) {}
      setTimeout(() => tryActivate(attempt + 1), ACTIVATE_RETRY_MS);
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
      type: EVT.CONNECT,
      room_id: roomId,
      server_url: serverUrl,
      token: token,
      username: username,
    });

    port.onMessage.addListener(handleSWMessage);

    window.addEventListener("message", (e) => {
      if (e.data?.type === EVT.BYOB_RELAY && e.data.payload && port) {
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

    // Don't hook if we're not on the room's URL — a stray video element on
    // a different page (e.g. user clicked through to next episode but the
    // room is still on the previous one) would otherwise have its play /
    // pause / seek events propagated to the server as if it were the
    // current video, breaking sync for everyone.
    if (!urlMatches()) {
      if (window === window.top) updateSyncBarStatus("out_of_sync");
      return;
    }

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
      port.postMessage({ type: EVT.VIDEO_HOOKED, duration: video.duration || 0, ...meta });
    }
    if (!window.location.hostname.includes("youtube.com")) {
      try { chrome.runtime.sendMessage({ type: EVT.BYOB_VIDEO_HOOKED }); } catch (_) {}
    }

    if (needsGesture) {
      waitForNativePlay();
    } else {
      updateSyncBarStatus("syncing");
    }

    // Periodic state report + ended detection. Also detects pause/play
    // transitions that both the <video> DOM events and Bitmovin's own
    // events may miss (some CR UI paths pause the player without either
    // event firing) — dispatches onVideoPause/onVideoPlay so the state
    // propagates to the server the same way a native event would.
    _lastPolledPaused = null;
    timeReportInterval = setInterval(() => {
      if (!hookedVideo) return;
      const pos = hookedVideo.currentTime;
      const dur = hookedVideo.duration || 0;
      const paused = hookedVideo.paused;
      const playing = !paused && !isBuffering;

      if (synced && !isBuffering && !commandGuard
          && _lastPolledPaused !== null && _lastPolledPaused !== paused) {
        if (paused && expectedPlayState !== State.PAUSED) {
          _log("poll: paused transition detected — dispatching onVideoPause");
          onVideoPause();
        } else if (!paused && expectedPlayState !== State.PLAYING) {
          _log("poll: play transition detected — dispatching onVideoPlay");
          onVideoPlay();
        }
      }
      _lastPolledPaused = paused;

      const msg = {
        type: EVT.VIDEO_STATE,
        position: pos,
        duration: dur,
        playing,
        // No more offset_ms — extension stopped learning it. Server's
        // `Byob.SyncDecision` owns adaptive seek-latency now.
      };
      if (synced && port) port.postMessage(msg);
      if (port) {
        port.postMessage({
          type: EVT.BYOB_BAR_UPDATE,
          position: pos, duration: dur, playing,
        });
      }

      if (synced && !_endedReported && playing && isFinite(dur) && dur > MIN_ENDED_DURATION_S && pos >= dur - VIDEO_ENDED_TAIL_S) {
        _endedReported = true;
        if (port) port.postMessage({ type: EVT.VIDEO_ENDED, item_id: currentItemId });
      }
    }, STATE_REPORT_TICK_MS);
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
    _jitterEmaMs = 0;
    _jitterSamples = 0;
    _lastDriftMs = 0;
    _lastSeekExecutedAt = 0;
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
    try { chrome.runtime.sendMessage({ type: EVT.BYOB_USER_ACTIVE, t: _lastUserActive }); } catch (_) {}
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
      if (port) port.postMessage({ type: EVT.VIDEO_PLAY, position: hookedVideo.currentTime });
      _log("play →server", hookedVideo.currentTime.toFixed(2));
    }, PLAY_PAUSE_DEBOUNCE_MS);
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
      if (port) port.postMessage({ type: EVT.VIDEO_PAUSE, position: hookedVideo.currentTime });
      _log("pause →server", hookedVideo.currentTime.toFixed(2));
    }, PLAY_PAUSE_DEBOUNCE_MS);
  }

  function onVideoSeeked() {
    if (!synced || commandGuard) return;
    if (!userInitiated()) {
      _log("onVideoSeeked ignored — no user activation");
      return;
    }
    // Live: each viewer has their own DVR position relative to the
    // live edge — broadcasting this seek would knock peers off live.
    if (isLive) return;
    lastSeekAt = Date.now();
    updateServerRef(hookedVideo.currentTime, serverRef?.playState ?? expectedPlayState);
    if (port) port.postMessage({ type: EVT.VIDEO_SEEK, position: hookedVideo.currentTime });
    if (commandGuard) clearTimeout(commandGuard);
    commandGuard = setTimeout(() => { commandGuard = null; }, SEEK_COMMAND_GUARD_MS);
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
  // Runs every 500ms once synced. **Server-authoritative model:** this loop
  // doesn't decide when to seek. It just measures drift and jitter, sends
  // them to the server (via VIDEO_DRIFT), and the server decides via
  // `Byob.SyncDecision`. When a seek is needed, the server pushes
  // `sync:seek_command` and we execute it (handled in dispatchToContent).
  //
  // What stays here: state-mismatch enforcement (paused-vs-playing —
  // server can't tell whether the user paused locally vs. an autoplay
  // event silently flipped state, so the client side still rectifies).
  function startReconcile() {
    if (reconcileInterval) return;

    reconcileInterval = setInterval(() => {
      if (!hookedVideo || !synced || !serverRef || commandGuard || needsGesture) return;

      sampleLiveStatus();
      if (isLive) return;

      const now = Date.now();
      const actual = hookedVideo.paused ? State.PAUSED : State.PLAYING;

      // State mismatch rectifier (unchanged from before). Debounced event
      // handlers cover user-initiated changes; this catches silent
      // toggles (e.g. CR autoplay) that bypass them.
      if (actual !== expectedPlayState && expectedPlayState) {
        if (_mismatchSince === 0) _mismatchSince = now;
        const dur = now - _mismatchSince;
        if (dur > MISMATCH_ACCEPT_MS) {
          _log(`reconcile: accepting site state after ${dur}ms mismatch, actual=${actual} pos=${hookedVideo.currentTime.toFixed(2)}`);
          expectedPlayState = actual;
          updateServerRef(hookedVideo.currentTime, actual);
          if (port) {
            const evt = actual === State.PLAYING ? EVT.VIDEO_PLAY : EVT.VIDEO_PAUSE;
            port.postMessage({ type: evt, position: hookedVideo.currentTime });
          }
          _mismatchSince = 0;
        } else if (dur > MISMATCH_ENFORCE_MS) {
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

      if (!clockSynced) return;
      if (serverRef.playState !== State.PLAYING || actual !== State.PLAYING) return;

      // Measure drift.
      const localPos = hookedVideo.currentTime;
      const serverNow = now + clockOffset;
      const elapsed = (serverNow - serverRef.serverTime) / 1000;
      const expectedPos = serverRef.position + elapsed;
      const driftMs = (localPos - expectedPos) * 1000;

      // Jitter EMA: |Δdrift| per tick. Reject single-tick jumps over
      // 500 ms (those are seeks, not noise — same logic as the browser
      // reconcile.js). Skip during the 5 s post-seek quiet window.
      const inPostSeekQuiet = (now - _lastSeekExecutedAt) < _POST_SEEK_QUIET_MS;
      const tickDelta = _jitterSamples > 0 ? Math.abs(driftMs - _lastDriftMs) : 0;
      const looksLikeSeek = tickDelta > 500;
      if (_jitterSamples > 0 && !inPostSeekQuiet && !looksLikeSeek) {
        _jitterEmaMs = _JITTER_ALPHA * tickDelta + (1 - _JITTER_ALPHA) * _jitterEmaMs;
      }
      _jitterSamples++;
      _lastDriftMs = driftMs;

      // Send drift report to server (server decides whether to seek).
      // background.js fills in rtt_ms from its own clockSync samples.
      if (port) {
        port.postMessage({
          type: EVT.VIDEO_DRIFT,
          drift: Math.round(driftMs),
          noise_floor_ms: Math.round(_jitterEmaMs),
        });
      }
    }, RECONCILE_TICK_MS);
  }

  function stopReconcile() {
    if (reconcileInterval) { clearInterval(reconcileInterval); reconcileInterval = null; }
    if (hookedVideo && hookedVideo.playbackRate !== 1.0) hookedVideo.playbackRate = 1.0;
  }

  // Detect whether the hooked <video> is live and tell the server
  // when our reading differs from the room's current is_live flag.
  // HLS live streams expose duration === Infinity; finite durations
  // mean VOD. Called from the reconcile tick so it piggybacks the
  // existing "we have a hooked video and we're synced" gate.
  let _lastPushedLive = null;
  function sampleLiveStatus() {
    if (!hookedVideo || !port) return;
    const d = hookedVideo.duration;
    let detected = null;
    if (d === Infinity || (typeof d === "number" && isNaN(d))) {
      detected = true;
    } else if (typeof d === "number" && isFinite(d) && d > 0) {
      detected = false;
    }
    if (detected === null) return;
    // Don't spam the channel with redundant pushes — only when the
    // detected value actually changes versus what we last sent.
    if (detected === _lastPushedLive) return;
    if (detected === isLive) {
      _lastPushedLive = detected;
      return;
    }
    _lastPushedLive = detected;
    isLive = detected;
    port.postMessage({ type: EVT.VIDEO_LIVE_STATUS, is_live: detected });
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
  const GUARD_MIN_DEFAULT_MS = 300;
  let _guardMinMs = GUARD_MIN_DEFAULT_MS;
  function startCommandGuard(minMs = GUARD_MIN_DEFAULT_MS) {
    if (commandGuard) clearTimeout(commandGuard);
    _guardStartedAt = Date.now();
    _guardMinMs = minMs;
    commandGuard = setTimeout(checkGuard, Math.min(minMs, GUARD_MIN_DEFAULT_MS));
  }

  function checkGuard() {
    const elapsed = Date.now() - _guardStartedAt;
    if (elapsed > COMMAND_GUARD_MAX_MS || !hookedVideo || !expectedPlayState) {
      commandGuard = null;
      return;
    }
    const actual = hookedVideo.paused ? State.PAUSED : State.PLAYING;
    // Hold the guard until BOTH the minimum has elapsed AND state matches,
    // so site-initiated events during the minimum window can't leak out.
    if (elapsed >= _guardMinMs && actual === expectedPlayState) {
      commandGuard = null;
    } else {
      commandGuard = setTimeout(checkGuard, COMMAND_GUARD_CHECK_MS);
    }
  }

  // ── SW message handling ───────────────────────────────────────────────────
  function handleSWMessage(msg) {
    if (msg.type === EVT.BYOB_CHANNEL_READY && window === window.top) {
      if (!synced && needsGesture) {
        updateSyncBarStatus("searching");
        showJoinToast("Play the video to start syncing");
      }
      return;
    }
    if (msg.type === EVT.BYOB_VIDEO_HOOKED && window === window.top) {
      if (!window.location.hostname.includes("youtube.com")) injectSyncBar();
      return;
    }

    if (msg.type === EVT.BYOB_CLOCK_SYNC) {
      clockOffset = msg.offset;
      clockRtt = msg.rtt;
      clockSynced = true;
      _log("clock synced offset=", clockOffset, "ms rtt=", clockRtt, "ms");
      return;
    }

    if (msg.type === EVT.BYOB_USER_ACTIVE) {
      if (msg.t && msg.t > _lastUserActive) _lastUserActive = msg.t;
      return;
    }

    if (msg.type === EVT.BYOB_PRESENCE && window === window.top) {
      let text;
      if (msg.event === PRESENCE.JOINED) text = `${msg.username} joined the room`;
      else if (msg.event === PRESENCE.EXT_CLOSED) text = `${msg.username} closed their player window`;
      else text = `${msg.username} left the room`;
      showPresenceToast(text);
      return;
    }

    if (msg.type === EVT.BYOB_BAR_UPDATE && window === window.top && synced) {
      renderBarUpdate(msg);
      return;
    }

    if (msg.type === EVT.AUTOPLAY_COUNTDOWN && window === window.top) {
      // v6.5: only show the countdown overlay here when there's a next
      // video queued. If the queue's exhausted, the countdown fires server-
      // side but we don't want to distract the user — they're free to
      // browse to whatever's next on the third-party site.
      if (msg.has_next === false) return;
      startCountdown(msg.duration_ms || 5000);
      return;
    }
    if (msg.type === EVT.AUTOPLAY_CANCELLED && window === window.top) {
      clearCountdown();
      return;
    }

    if (msg.type === EVT.COMMAND_INITIAL_STATE) {
      if (msg.current_url) setSyncedUrl(msg.current_url);
      if (msg.is_live != null) isLive = !!msg.is_live;
      if (msg.current_item_id != null) currentItemId = msg.current_item_id;
      tryAutoSync();
      return;
    }

    if (msg.type === EVT.COMMAND_LIVE_STATUS) {
      isLive = !!msg.is_live;
      _lastPushedLive = isLive;
      // If we just switched out of live, the reconcile loop's next
      // tick re-engages drift correction. If we just switched into
      // live, ensure playbackRate is reset (reconcile may have been
      // tweaking it).
      if (hookedVideo && isLive && hookedVideo.playbackRate !== 1.0) {
        hookedVideo.playbackRate = 1.0;
      }
      return;
    }

    if (msg.type === EVT.COMMAND_SYNCED) {
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

      if (msg.current_url) setSyncedUrl(msg.current_url);
      if (msg.is_live != null) isLive = !!msg.is_live;
      if (msg.current_item_id != null) currentItemId = msg.current_item_id;

      hideJoinToast();
      _log("synced! expected=", expectedPlayState, "hasVideo=", !!hookedVideo, "clockSynced=", clockSynced);

      if (hookedVideo) {
        // Arm the command guard so the resulting DOM events (seeked / pause
        // / play) from applySyncedState are treated as echoes. Releases as
        // soon as state matches. Any later autoplay from the site is
        // caught by the userActivation check in the event handlers.
        startCommandGuard();
        applySyncedState(msg);
        // "Joining…" while the initial seek + the server's adaptive-L
        // follow-up seek land. Sticky 3 s — covers two-seek convergence.
        if (msg.play_state === "playing" && !isLive) {
          updateSyncBarStatus("joining", { sticky: true, durationMs: 3000 });
        } else {
          updateSyncBarStatus(hookedVideo.paused ? "paused" : "playing");
        }
        if (!wasSynced && port) port.postMessage({ type: EVT.VIDEO_READY });
        startReconcile();
      } else if (window === window.top) {
        updateSyncBarStatus(expectedPlayState === State.PAUSED ? "paused" : "playing");
      }
      return;
    }

    if (msg.type === EVT.COMMAND_VIDEO_CHANGE) {
      // Capture whether this tab is acting as a player BEFORE updating
      // _syncedUrl. setSyncedUrl → checkUrlMismatch → unhookVideo when the
      // current location no longer matches the new room URL, which would
      // null out hookedVideo before the navigate gate below — and another
      // user's tab (where this is exactly the case) would skip the
      // navigation and require a manual click. `synced` is sticky for the
      // session, so it's the right player-tab marker.
      const wasPlayerTab = !!hookedVideo || synced;

      // Room advanced to a new video (manual queue nav, "Set room to this
      // page", or queue auto-advance to another extension-required video).
      // Update our canonical URL reference so the mismatch toast disappears
      // if this tab is already on that URL.
      if (msg.url) setSyncedUrl(msg.url);
      if (msg.is_live != null) {
        isLive = !!msg.is_live;
        _lastPushedLive = isLive;
      }
      if (msg.item_id != null) currentItemId = msg.item_id;
      // Reset the local _endedReported guard when the room moves on.
      // Otherwise an extension tab that already ended the previous
      // video would refuse to send :ended for the next one.
      _endedReported = false;

      // navigate=true: the new video is extension-required, so the BG would
      // otherwise close this tab and force a re-open. Reuse it instead —
      // navigate the tab itself to the new URL. Only do this on tabs that
      // were acting as the player; non-player tabs (e.g. a CR browse page)
      // shouldn't get yanked away.
      if (msg.navigate && msg.url && wasPlayerTab && window === window.top) {
        if (location.href !== msg.url) {
          // Stash a one-shot toast hint so the post-nav content script can
          // surface "Followed room to: <title>" — same purple style as the
          // presence toasts. Then navigate once both writes have flushed.
          (async () => {
            try {
              await chrome.storage.local.set({
                [PENDING_NAV_TOAST_KEY]: { title: msg.title || null, at: Date.now() },
              });
            } catch (_) {}
            // setSyncedUrl already kicked off the chrome.storage update for
            // target_url; the await above also ensures any pending storage
            // ops have flushed before we navigate.
            location.href = msg.url;
          })();
        }
      }
      return;
    }

    if (msg.type === EVT.COMMAND_QUEUE_ENDED && window === window.top) {
      updateSyncBarStatus("queue_ended");
      return;
    }

    if (msg.type === EVT.BYOB_READY_COUNT && window === window.top) {
      updateReadyCount(msg.ready, msg.has_tab, msg.total, msg.needs_open || [], msg.needs_play || []);
      return;
    }

    if (!hookedVideo) return;

    // If waiting for gesture and a play command arrives, try playing —
    // the browser may allow it if the user interacted with the page.
    if (needsGesture && msg.type === EVT.COMMAND_PLAY) {
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

    // Ignore stale commands — server_time must be older than what we have.
    // Uses strict < (not <=) because the server's System.monotonic_time has
    // 1ms granularity and two broadcasts (e.g. a sync:correction + a
    // sync:pause) can share the same server_time. If the correction lands
    // first it bumps serverRef.serverTime to T; the pause arriving with
    // the same T must still be processed.
    if (msg.server_time != null && serverRef && msg.server_time < serverRef.serverTime) {
      if (msg.type !== EVT.SYNC_CORRECTION) {
        _log(`ignoring stale ${msg.type}: server_time=${msg.server_time} < ${serverRef.serverTime}`);
        return;
      }
    }

    switch (msg.type) {
      case EVT.COMMAND_PLAY:
        _log("cmd:play pos=", msg.position, "server_time=", msg.server_time);
        // Genuine play command from server — any locally-pending pause is
        // stale and would echo back incorrectly.
        if (_pendingPlayPause) { clearTimeout(_pendingPlayPause); _pendingPlayPause = null; }
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

      case EVT.COMMAND_PAUSE:
        _log("cmd:pause pos=", msg.position, "server_time=", msg.server_time);
        if (_pendingPlayPause) { clearTimeout(_pendingPlayPause); _pendingPlayPause = null; }
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

      case EVT.COMMAND_SEEK:
        // Defensive: server already drops seeks for live items, so
        // we shouldn't see this — but if a stale seek arrives mid
        // VOD→live transition, ignore it.
        if (isLive) break;
        _log("cmd:seek pos=", msg.position, "server_time=", msg.server_time);
        lastSeekAt = Date.now();
        updateServerRef(msg.position, serverRef?.playState ?? expectedPlayState, msg.server_time);
        if (commandGuard) clearTimeout(commandGuard);
        commandGuard = setTimeout(() => { commandGuard = null; }, CMD_SEEK_COMMAND_GUARD_MS);
        updateSyncBarStatus("catching_up", { sticky: true, durationMs: 2500 });
        seekTo(msg.position);
        break;

      case EVT.SYNC_CORRECTION:
        // Server periodic refresh (every few seconds). Updates reference so
        // reconcile can drift-correct. No direct player action here.
        if (msg.expected_time != null) {
          updateServerRef(msg.expected_time, serverRef?.playState ?? expectedPlayState, msg.server_time);
        }
        break;

      case EVT.SYNC_SEEK_COMMAND:
        // Server's `Byob.SyncDecision` decided this client needs to seek.
        // Target is pre-computed (includes learned-L overshoot), we just
        // execute it. lastSeekExecutedAt suppresses jitter EMA updates
        // for 5 s so the position-jump tickDelta doesn't poison noise
        // estimation.
        if (isLive) break;
        if (typeof msg.position !== "number") break;
        _log("cmd:server-seek pos=", msg.position, "server_time=", msg.server_time);
        _lastSeekExecutedAt = Date.now();
        lastSeekAt = _lastSeekExecutedAt;
        if (commandGuard) clearTimeout(commandGuard);
        commandGuard = setTimeout(() => { commandGuard = null; }, CMD_SEEK_COMMAND_GUARD_MS);
        updateSyncBarStatus("resyncing", { sticky: true, durationMs: 2500 });
        seekTo(msg.position);
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
    if (port) port.postMessage({ type: EVT.VIDEO_REQUEST_SYNC });
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

  // ── Toast stack ───────────────────────────────────────────────────────────
  // Single fixed-position container at bottom-center. All toasts append here
  // so multiple messages stack (newest at bottom) instead of overlapping.
  // column-reverse means appendChild puts the latest at the visual bottom
  // and existing ones rise above it.
  function ensureToastStack() {
    if (window !== window.top) return null;
    let stack = document.getElementById("byob-toast-stack");
    if (!stack) {
      const style = document.createElement("style");
      style.id = "byob-toast-style";
      style.textContent = `
        @keyframes byob-toast-pulse {
          0%, 100% { opacity: 1; box-shadow: 0 4px 24px rgba(124, 58, 237, 0.5), 0 0 0 1px rgba(255,255,255,0.15); }
          50% { opacity: 0.85; box-shadow: 0 4px 32px rgba(124, 58, 237, 0.7), 0 0 0 1px rgba(255,255,255,0.25); }
        }
        @keyframes byob-toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes byob-toast-out { from { opacity: 1; } to { opacity: 0; } }
      `;
      if (!document.getElementById("byob-toast-style")) document.head.appendChild(style);

      stack = document.createElement("div");
      stack.id = "byob-toast-stack";
      stack.style.cssText = `
        position: fixed; bottom: 48px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647;
        display: flex; flex-direction: column-reverse; align-items: center; gap: 8px;
        max-width: calc(100vw - 32px);
        pointer-events: none;
      `;
      document.body.appendChild(stack);
    }
    return stack;
  }

  // Common purple toast styling — used by every notification on third-party
  // pages. `pulse` is the breathing-glow animation used by the persistent
  // join toast; auto-dismiss toasts use a fade-in instead.
  function _styleToast(toast, { pulse } = {}) {
    toast.style.cssText = `
      background: #7c3aed; color: white;
      font-family: system-ui, sans-serif; font-size: 15px; font-weight: 600;
      padding: 14px 28px; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(124, 58, 237, 0.5), 0 0 0 1px rgba(255,255,255,0.15);
      pointer-events: auto;
      ${pulse ? "animation: byob-toast-pulse 2s ease-in-out infinite;" : "animation: byob-toast-in 0.2s ease-out;"}
    `;
  }

  function showJoinToast(text) {
    const stack = ensureToastStack();
    if (!stack) return;
    hideJoinToast();

    const toast = document.createElement("div");
    toast.id = "byob-join-toast";
    _styleToast(toast, { pulse: true });
    toast.style.pointerEvents = "none";
    toast.textContent = text;
    stack.appendChild(toast);
  }

  function hideJoinToast() {
    document.getElementById("byob-join-toast")?.remove();
  }

  // Brief, non-blocking toast for room presence changes ("X joined" / "X left").
  // Stacks with other toasts via the shared container.
  function showPresenceToast(text) {
    const stack = ensureToastStack();
    if (!stack) return;

    const toast = document.createElement("div");
    toast.className = "byob-presence-toast";
    _styleToast(toast);
    toast.style.pointerEvents = "none";
    toast.textContent = text;
    stack.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = "byob-toast-out 0.2s ease-in forwards";
      setTimeout(() => toast.remove(), TOAST_FADE_MS);
    }, 2500);
  }

  // ── URL mismatch tracking (v6.5) ──────────────────────────────────────────
  // Canonical room URL, polling, and persistent toast. Only runs in the top
  // frame (same gate as other toasts) — iframes can't navigate the window.
  // True if either we don't yet know the room's URL (initial load, before
  // command:initial-state) or our location.href matches it. False means the
  // user has navigated away from the room's video; hooking the local <video>
  // would point sync events at the wrong content (e.g. while browsing to
  // the next CR episode the previous one is still playing — server sees
  // play_state events from a video that isn't the room's).
  function urlMatches() {
    if (!_syncedUrl) return true;
    return normalizeUrl(location.href) === normalizeUrl(_syncedUrl);
  }

  function setSyncedUrl(url) {
    _syncedUrl = url;
    // BG-managed tab IDs are now the activation gate, so target_url
    // no longer needs to be persisted to chrome.storage for reload
    // re-activation. _syncedUrl is still used locally to drive the
    // checkUrlMismatch toast.
    checkUrlMismatch();
    ensureUrlPollStarted();
  }

  function ensureUrlPollStarted() {
    if (window !== window.top) return;
    if (_urlPollInterval) return;
    _urlPollInterval = setInterval(checkUrlMismatch, URL_POLL_MS);
  }

  function checkUrlMismatch() {
    if (window !== window.top) return;
    if (!_syncedUrl) { hideUrlMismatchToast(); return; }

    const matched = normalizeUrl(location.href) === normalizeUrl(_syncedUrl);

    if (matched) {
      hideUrlMismatchToast();
      // Just transitioned back onto the room's URL — pick up any video
      // element that's now on the page so the existing tab can resume
      // playing in sync. The MutationObserver fires on DOM additions but
      // not on URL-only SPA changes where the video already exists.
      if (synced && !hookedVideo) {
        document.querySelectorAll("video").forEach((v) => hookVideo(v));
      }
    } else {
      // Drop any hooked video — its play/pause/seek events would otherwise
      // be propagated to the server as if it were the room's current video.
      if (hookedVideo) unhookVideo();
      updateSyncBarStatus("out_of_sync");
      showUrlMismatchToast();
    }
  }

  // Reduce a URL to a canonical form for room-membership comparison.
  //   * YouTube watch URLs collapse to youtube.com/watch?v=<id> — playlist
  //     context (&list=…&index=…), share-link timecodes, autoplay flags,
  //     etc. shouldn't read as "different video".
  //   * youtu.be/<id> short links are normalized to the same canonical form.
  //   * /shorts/<id> and /embed/<id> map to the same too.
  //   * Other sites: strip the hash + a trailing slash; keep the rest of the
  //     query (different episodes are usually distinguished by path or by
  //     a non-trivial query, so we can't blanket-strip across hosts).
  function normalizeUrl(u) {
    try {
      const url = new URL(u);
      url.hash = "";
      const host = url.hostname.toLowerCase();

      // YouTube canonicalization
      if (host === "youtu.be") {
        const id = url.pathname.replace(/^\//, "").split("/")[0];
        if (id) return `https://www.youtube.com/watch?v=${id}`;
      }
      if (host === "youtube.com" || host.endsWith(".youtube.com")) {
        let id = null;
        if (url.pathname === "/watch") {
          id = url.searchParams.get("v");
        } else {
          const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/);
          if (m) id = m[1];
        }
        if (id) return `https://www.youtube.com/watch?v=${id}`;
      }

      let s = url.toString();
      if (s.endsWith("/")) s = s.slice(0, -1);
      return s;
    } catch (_) {
      return u;
    }
  }

  function showUrlMismatchToast() {
    if (_urlMismatchShown) return;
    if (document.getElementById("byob-url-toast")) return;
    const stack = ensureToastStack();
    if (!stack) return;
    _urlMismatchShown = true;

    const toast = document.createElement("div");
    toast.id = "byob-url-toast";
    toast.style.cssText = `
      background: #7c3aed; color: white;
      font-family: system-ui, sans-serif; font-size: 14px;
      padding: 12px 18px; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(124, 58, 237, 0.5), 0 0 0 1px rgba(255,255,255,0.15);
      display: flex; align-items: center; gap: 12px;
      pointer-events: auto;
      animation: byob-toast-in 0.2s ease-out;
    `;

    const label = document.createElement("span");
    label.style.cssText = "font-weight: 600; flex-shrink: 0;";
    label.textContent = "You've left the room's video";

    const spacer = document.createElement("span");
    spacer.style.cssText = "flex: 1;";

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.textContent = "Back to room video";
    backBtn.style.cssText = `
      background: rgba(255,255,255,0.18); color: white; border: none;
      font: inherit; font-weight: 600; font-size: 13px;
      padding: 6px 12px; border-radius: 8px; cursor: pointer;
      flex-shrink: 0;
    `;
    backBtn.onmouseenter = () => { backBtn.style.background = "rgba(255,255,255,0.3)"; };
    backBtn.onmouseleave = () => { backBtn.style.background = "rgba(255,255,255,0.18)"; };
    backBtn.onclick = () => {
      if (_syncedUrl) window.location.href = _syncedUrl;
    };

    const updateBtn = document.createElement("button");
    updateBtn.type = "button";
    updateBtn.textContent = "Set room to this page";
    updateBtn.style.cssText = `
      background: white; color: #7c3aed; border: none;
      font: inherit; font-weight: 700; font-size: 13px;
      padding: 6px 12px; border-radius: 8px; cursor: pointer;
      flex-shrink: 0;
    `;
    updateBtn.onmouseenter = () => { updateBtn.style.background = "#f5f3ff"; };
    updateBtn.onmouseleave = () => { updateBtn.style.background = "white"; };
    updateBtn.onclick = () => {
      if (port) port.postMessage({ type: EVT.VIDEO_UPDATE_URL, url: location.href });
      // Optimistically hide — the server echo via COMMAND_VIDEO_CHANGE will
      // update _syncedUrl and confirm, or the next poll will re-show if
      // something went wrong.
      hideUrlMismatchToast();
    };

    toast.appendChild(label);
    toast.appendChild(spacer);
    toast.appendChild(backBtn);
    toast.appendChild(updateBtn);
    stack.appendChild(toast);
  }

  function hideUrlMismatchToast() {
    _urlMismatchShown = false;
    const el = document.getElementById("byob-url-toast");
    if (el) el.remove();
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
        port.postMessage({ type: EVT.VIDEO_PAUSE, position: parseFloat(playPauseBtn.dataset.position || 0) });
      } else {
        port.postMessage({ type: EVT.VIDEO_PLAY, position: parseFloat(playPauseBtn.dataset.position || 0) });
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
      if (dur > 0 && port) port.postMessage({ type: EVT.VIDEO_SEEK, position: frac * dur });
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
    _countdownInterval = setInterval(update, COUNTDOWN_TICK_MS);
  }
  function clearCountdown() {
    if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null; }
  }

  // Sticky overlay for transient sync states ("Catching up...", "Re-syncing...",
  // "Joining..."). When set, non-sticky calls into updateSyncBarStatus are
  // ignored until the timer expires — otherwise the polling-driven
  // playing/paused updates would clobber the transient text within 50 ms.
  let _syncBarStickyUntil = 0;

  function updateSyncBarStatus(state, options) {
    options = options || {};
    if (!options.sticky && Date.now() < _syncBarStickyUntil) return;
    const dot = document.getElementById("byob-dot");
    const status = document.getElementById("byob-status");
    if (!dot || !status) return;
    const states = {
      loading:   { color: "#888",    text: "Connecting...",                      tip: "Connecting to the byob room server" },
      searching: { color: "#ff9900", text: "Play the video to start syncing",    tip: "Waiting for a video element on this page" },
      syncing:   { color: "#ff9900", text: "Syncing...",                         tip: "Applying room state to this player" },
      joining:   { color: "#7c3aed", text: "Joining...",                         tip: "Initial seek + adaptive seek-lag learning (1-3s)" },
      catching_up: { color: "#7c3aed", text: "Catching up...",                   tip: "Following a peer's seek" },
      resyncing: { color: "#7c3aed", text: "Re-syncing...",                      tip: "Server detected drift — seeking to compensate" },
      clickjoin: { color: "#ff9900", text: "Click play to sync",                 tip: "Click play on the video player above to start syncing with the room" },
      playing:   { color: "#00d400", text: "Playing",                            tip: "Video is playing in sync with the room" },
      paused:    { color: "#ff9900", text: "Paused",                             tip: "Video is paused — synced with room" },
      finished:  { color: "#7c3aed", text: "Finished",                           tip: "Video ended — next video loading" },
      queue_ended: { color: "#7c3aed", text: "Queue finished",                   tip: "No more videos queued — feel free to keep browsing" },
      out_of_sync: { color: "#ff9900", text: "Out of sync",                      tip: "This page isn't the room's current video — use the toast to re-sync or update the room" },
    };
    const s = states[state];
    if (!s) return;
    dot.style.background = s.color;
    status.style.color = s.color;
    status.textContent = s.text;
    status.title = s.tip;
    if (options.sticky) {
      _syncBarStickyUntil = Date.now() + (options.durationMs || 2500);
    } else {
      _syncBarStickyUntil = 0;
    }
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
      if (!e.data || e.data.type !== EVT.BYOB_SPONSOR_SEGMENTS) return;
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
          setTimeout(() => tryInject(attempt + 1), SYNC_BAR_RETRY_MS);
          return;
        }
        injectSegments(progressBar, segments, duration);
      };
      tryInject(0);
    });

    try { window.parent.postMessage({ type: EVT.BYOB_EMBED_READY }, "*"); } catch (_) {}
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
