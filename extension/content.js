// WatchParty content script — hooks <video> elements and relays sync commands via port to SW

(() => {
  "use strict";

  // --- Constants (avoid magic strings) ---
  const State = Object.freeze({
    PLAYING: "playing",
    PAUSED: "paused",
    BUFFERING: "buffering",
    ENDED: "ended",
    SEEKED: "seeked",
  });

  const SyncStatus = Object.freeze({
    LOADING: "loading",
    SEARCHING: "searching",
    SYNCING: "syncing",
    CLICKJOIN: "clickjoin",
    PLAYING: "playing",
    PAUSED: "paused",
    FINISHED: "finished",
  });

  // Message types
  const Msg = Object.freeze({
    // Outbound (content → SW)
    CONNECT: "connect",
    VIDEO_HOOKED: "video:hooked",
    VIDEO_PLAY: "video:play",
    VIDEO_PAUSE: "video:pause",
    VIDEO_SEEK: "video:seek",
    VIDEO_ENDED: "video:ended",
    VIDEO_STATE: "video:state",
    VIDEO_READY: "video:ready",
    VIDEO_REQUEST_SYNC: "video:request-sync",
    BAR_UPDATE: "byob:bar-update",
    // Inbound (SW → content)
    CHANNEL_READY: "byob:channel-ready",
    VIDEO_HOOKED_BROADCAST: "byob:video-hooked",
    READY_COUNT: "byob:ready-count",
    COMMAND_PLAY: "command:play",
    COMMAND_PAUSE: "command:pause",
    COMMAND_SEEK: "command:seek",
    COMMAND_SYNCED: "command:synced",
    COMMAND_INITIAL_STATE: "command:initial-state",
    AUTOPLAY_COUNTDOWN: "autoplay:countdown",
    AUTOPLAY_CANCELLED: "autoplay:cancelled",
    // Window messages
    CLEAR_EXTERNAL: "byob:clear-external",
    OPEN_EXTERNAL: "byob:open-external",
    RELAY: "byob:relay",
  });

  // DOM element IDs
  const El = Object.freeze({
    SYNC_BAR: "byob-sync-bar",
    BAR_CONTENT: "byob-bar-content",
    DOT: "byob-dot",
    STATUS: "byob-status",
    TIME: "byob-time",
    PLAYPAUSE: "byob-playpause",
    PROGRESS_WRAP: "byob-progress-wrap",
    PROGRESS_FILL: "byob-progress-fill",
    USERS: "byob-users",
    USERS_ICON: "byob-users-icon",
    USERS_COUNT: "byob-users-count",
    COLLAPSE: "byob-collapse",
    JOIN_TOAST: "byob-join-toast",
    TOAST_STYLE: "byob-toast-style",
    AUTOPLAY_OVERLAY: "byob-autoplay-overlay",
  });

  // Hosts
  const Hosts = Object.freeze({
    BYOB: "byob.video",
    LOCALHOST: "localhost",
    YOUTUBE: "youtube.com",
    CRUNCHYROLL: "crunchyroll.com",
  });

  // Colors
  const Color = Object.freeze({
    GREEN: "#00d400",
    ORANGE: "#ff9900",
    GRAY: "#888",
    PURPLE: "#7c3aed",
    WHITE_50: "rgba(255,255,255,0.5)",
    WHITE_60: "rgba(255,255,255,0.6)",
    // SponsorBlock segment colors
    SB_SPONSOR: "#00d400",
    SB_SELFPROMO: "#ffff00",
    SB_INTERACTION: "#cc00ff",
    SB_INTRO: "#00ffff",
    SB_OUTRO: "#0202ed",
    SB_PREVIEW: "#008fd6",
    SB_MUSIC_OFFTOPIC: "#ff9900",
    SB_FILLER: "#7300FF",
  });

  // UI copy
  const Copy = Object.freeze({
    CONNECTING: "Connecting...",
    PLAY_TO_SYNC: "Play the video to start syncing",
    SYNCING: "Syncing...",
    CLICK_PLAY: "Click play to sync",
    PLAYING: "Playing",
    PAUSED: "Paused",
    FINISHED: "Finished",
    LOADING_NEXT: "Loading next...",
    LOADING_SYNC: "Loading byob sync...",
    CLICK_PLAY_TOAST: "Click play on the video to start syncing",
    TIP_CONNECTING: "Connecting to the byob room server",
    TIP_SEARCHING: "Waiting for a video element on this page",
    TIP_SYNCING: "Applying room state to this player",
    TIP_CLICKJOIN: "Click play on the video player above to start syncing with the room",
    TIP_PLAYING: "Video is playing in sync with the room",
    TIP_PAUSED: "Video is paused — synced with room",
    TIP_FINISHED: "Video ended — next video loading",
  });

  // DOM events
  const Evt = Object.freeze({
    CLICK: "click",
    PLAY: "play",
    PAUSE: "pause",
    SEEKED: "seeked",
    ENDED: "ended",
    MESSAGE: "message",
  });

  // HTML tags
  const Tag = Object.freeze({
    DIV: "div",
    SPAN: "span",
    BUTTON: "button",
    STYLE: "style",
  });

  // Storage keys
  const STORAGE_KEY = "watchparty_config";
  const PORT_NAME = "watchparty";
  const EXT_ATTR = "data-byob-extension";

  let port = null;
  let hookedVideo = null;
  let synced = false; // Don't send events until initial sync is done
  let needsGesture = true; // True until video actually plays — blocks commands
  let pauseEnforcer = null;
  let suppressGen = 0;
  let suppressUntilGen = 0;
  let expectedState = null;
  let safetyTimeout = null;
  let timeReportInterval = null;
  let commandCooldown = null; // blocks ALL outbound events briefly after a server command
  let seekCooldown = null; // blocks outbound play/pause briefly after a user seek
  let expectedPlayState = null; // "playing" or "paused" — what the server wants
  let stateCheckInterval = null;
  let mismatchSince = null;

  // Signal extension is installed — only on our domain so other sites can't detect it
  if (window.location.hostname === Hosts.BYOB || window.location.hostname === Hosts.LOCALHOST) {
    document.documentElement.setAttribute(EXT_ATTR, "true");
  }

  // Check if we should activate on this page
  async function init() {
    // Listen for room page messages — only accept from our own origin
    window.addEventListener(Evt.MESSAGE, (e) => {
      if (e.origin !== window.location.origin) return;
      try {
        if (e.data?.type === Msg.CLEAR_EXTERNAL) {
          chrome.storage.local.remove(STORAGE_KEY);
          return;
        }
        if (e.data?.type === Msg.OPEN_EXTERNAL) {
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
      } catch (_) {
        // Extension context invalidated (reloaded while page is open)
      }
    });

    // Check storage for active room config — retry a few times since
    // storage write from room page may not have completed yet
    const tryActivate = async (attempt) => {
      if (attempt > 5) return;
      try {
        const config = await chrome.storage.local.get(STORAGE_KEY);
        if (config[STORAGE_KEY]) {
          const { room_id, server_url, target_url, token, username, timestamp } = config[STORAGE_KEY];
          const age = Date.now() - (timestamp || 0);
          if (age < 30 * 60 * 1000) {
            // Don't activate extension sync on our own domain — the main
            // site handles sync via LiveView. Extension only sets the
            // data-byob-extension attribute there (done above).
            const host = window.location.hostname;
            if (host === Hosts.BYOB || host === Hosts.LOCALHOST) return;

            // In nested iframes (video player embeds), always activate
            const isTopFrame = window === window.top;
            if (!isTopFrame) {
              activate(room_id, server_url, token, username);
              return;
            }
            // In top frame, match URL
            if (target_url) {
              const targetBase = new URL(target_url).origin + new URL(target_url).pathname;
              const currentBase = window.location.origin + window.location.pathname;
              if (currentBase.startsWith(targetBase) || targetBase.startsWith(currentBase)) {
                showJoinToast(Copy.LOADING_SYNC);
                activate(room_id, server_url, token, username);
                return;
              }
            }
          }
        }
      } catch (e) {}
      setTimeout(() => tryActivate(attempt + 1), 500);
    };
    tryActivate(0);
  }

  let activateArgs = null; // saved for reconnection

  function activate(roomId, serverUrl, token, username) {
    activateArgs = { roomId, serverUrl, token, username };
    connectToSW(roomId, serverUrl, token, username);
  }

  function connectToSW(roomId, serverUrl, token, username) {
    // Show sync bar immediately in top frame with "Loading..." status
    if (window === window.top) {
      injectSyncBar();
      updateSyncBarStatus(SyncStatus.LOADING);
    }

    // Connect port to service worker
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch (e) {
      // Service worker not available — retry after a delay
      setTimeout(() => connectToSW(roomId, serverUrl, token, username), 2000);
      return;
    }

    port.postMessage({
      type: Msg.CONNECT,
      room_id: roomId,
      server_url: serverUrl,
      token: token,
      username: username,
    });

    port.onMessage.addListener(handleSWMessage);

    // Relay messages from nested iframes to the SW port
    window.addEventListener(Evt.MESSAGE, (e) => {
      if (e.data?.type === Msg.RELAY && e.data.payload && port) {
        port.postMessage(e.data.payload);
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      // If SW was terminated (Chrome MV3 lifecycle), reconnect after a delay
      if (activateArgs) {
        setTimeout(() => {
          const { roomId: r, serverUrl: s, token: t, username: u } = activateArgs;
          connectToSW(r, s, t, u);
        }, 1000);
      } else {
        cleanup();
      }
    });

    // Start observing for <video> elements
    observeVideos();
  }

  function observeVideos() {
    // Monkey-patch attachShadow to observe shadow roots
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
          checkForVideo(node);
          // Check children one level deep
          if (node.querySelectorAll) {
            node.querySelectorAll("video").forEach((v) => hookVideo(v));
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Also check for existing videos
    document.querySelectorAll("video").forEach((v) => hookVideo(v));
  }

  function checkForVideo(node) {
    if (node.tagName === "VIDEO") {
      hookVideo(node);
    }
  }

  function scrapePageMetadata() {
    try {
      // Try site-specific selectors first
      const host = window.location.hostname;

      // Crunchyroll
      if (host.includes(Hosts.CRUNCHYROLL)) {
        const showEl = document.querySelector("[data-t='show-title-link'] h4, .show-title-link h4");
        const epEl = document.querySelector(".title, h1.title");
        const thumbEl = document.querySelector("meta[property='og:image']");
        const show = showEl?.textContent?.trim();
        const ep = epEl?.textContent?.trim();
        const title = show && ep ? `${show} — ${ep}` : show || ep || null;
        return {
          title: title || document.title,
          thumbnail_url: thumbEl?.content || null,
        };
      }

      // Generic: use OpenGraph or document title
      const ogTitle = document.querySelector("meta[property='og:title']")?.content;
      const ogImage = document.querySelector("meta[property='og:image']")?.content;
      return {
        title: ogTitle || document.title || null,
        thumbnail_url: ogImage || null,
      };
    } catch (_) {
      return { title: document.title || null, thumbnail_url: null };
    }
  }

  function hookVideo(video) {
    if (hookedVideo === video) return;
    if (hookedVideo) {
      // Unhook previous
      unhookVideo();
    }

    hookedVideo = video;

    video.addEventListener(Evt.PLAY, onVideoPlay);
    video.addEventListener(Evt.PAUSE, onVideoPause);
    video.addEventListener(Evt.SEEKED, onVideoSeeked);
    video.addEventListener(Evt.ENDED, onVideoEnded);

    // Report that we found a video — include page metadata for byob display
    const meta = scrapePageMetadata();
    const reportHooked = { type: Msg.VIDEO_HOOKED, duration: video.duration || 0, ...meta };
    if (port) {
      port.postMessage(reportHooked);
    }
    // Notify top frame via extension messaging (works cross-origin, no postMessage("*"))
    if (!window.location.hostname.includes(Hosts.YOUTUBE)) {
      try { chrome.runtime.sendMessage({ type: Msg.VIDEO_HOOKED_BROADCAST }); } catch (_) {}
    }

    // If still waiting for gesture (site replaced video element), re-register
    if (needsGesture) {
      waitForNativePlay();
    } else {
      updateSyncBarStatus(SyncStatus.SYNCING);
    }

    // Send periodic state updates (position, duration, playing) for relay to room + sync bar
    timeReportInterval = setInterval(() => {
      if (!hookedVideo) return;
      lastKnownPosition = hookedVideo.currentTime;
      const msg = {
        type: Msg.VIDEO_STATE,
        position: hookedVideo.currentTime,
        duration: hookedVideo.duration || 0,
        playing: !hookedVideo.paused,
      };
      // Only send state to server when synced (prevents corrupting canonical state)
      if (synced && port) port.postMessage(msg);
      // Always send bar update via port so background can relay to top frame
      if (port) port.postMessage({ type: Msg.BAR_UPDATE, position: msg.position, duration: msg.duration, playing: msg.playing });
    }, 500);
  }

  function unhookVideo() {
    if (!hookedVideo) return;
    stopStateCheck();
    hookedVideo.removeEventListener(Evt.PLAY, onVideoPlay);
    hookedVideo.removeEventListener(Evt.PAUSE, onVideoPause);
    hookedVideo.removeEventListener(Evt.SEEKED, onVideoSeeked);
    hookedVideo.removeEventListener(Evt.ENDED, onVideoEnded);
    if (_nativePlayListener) {
      hookedVideo.removeEventListener(Evt.PLAY, _nativePlayListener);
      _nativePlayListener = null;
    }
    hookedVideo = null;
    if (timeReportInterval) {
      clearInterval(timeReportInterval);
      timeReportInterval = null;
    }
  }

  // Event handlers — with suppression
  function onVideoPlay() {
    // Cancel any pause enforcer that's fighting the user's play
    if (pauseEnforcer) { clearInterval(pauseEnforcer); pauseEnforcer = null; }
    if (!synced || commandCooldown || seekCooldown) return;
    if (shouldSuppress(State.PLAYING)) return;
    expectedPlayState = State.PLAYING;
    mismatchSince = null;
    if (port && hookedVideo) {
      port.postMessage({
        type: Msg.VIDEO_PLAY,
        position: hookedVideo.currentTime,
      });
    }
  }

  let lastKnownPosition = 0;

  function onVideoPause() {
    if (!synced || commandCooldown || seekCooldown) return;
    if (shouldSuppress(State.PAUSED)) return;

    // If the position jumped significantly, this is a seek-triggered pause
    // (site pauses → seeks → resumes). Don't send it — the seeked handler
    // will send the seek event instead.
    if (hookedVideo && Math.abs(hookedVideo.currentTime - lastKnownPosition) > 1) {
      return;
    }

    expectedPlayState = State.PAUSED;
    mismatchSince = null;
    if (port && hookedVideo) {
      port.postMessage({
        type: Msg.VIDEO_PAUSE,
        position: hookedVideo.currentTime,
      });
    }
  }

  function onVideoSeeked() {
    if (!synced || commandCooldown) return;
    if (shouldSuppress(State.SEEKED)) return;
    if (port && hookedVideo) {
      port.postMessage({
        type: Msg.VIDEO_SEEK,
        position: hookedVideo.currentTime,
      });
      // Suppress outbound play/pause for 500ms — the site's player fires
      // pause→seeked→play as a burst during seek. Only the seek matters;
      // the surrounding play/pause are player behavior, not user intent.
      if (seekCooldown) clearTimeout(seekCooldown);
      seekCooldown = setTimeout(() => { seekCooldown = null; }, 500);
    }
  }

  function onVideoEnded() {
    if (!synced) return;
    if (port) {
      port.postMessage({ type: Msg.VIDEO_ENDED });
    }
  }

  // State reconciliation — checks if actual video state matches expected
  // server state. If mismatched for >1s, tries to correct. If play fails
  // repeatedly, drops to needsGesture state.
  function startStateCheck() {
    if (stateCheckInterval) return; // already running
    mismatchSince = null;

    stateCheckInterval = setInterval(() => {
      if (!hookedVideo || !synced || !expectedPlayState || commandCooldown) return;

      const actual = hookedVideo.paused ? State.PAUSED : State.PLAYING;

      if (actual !== expectedPlayState) {
        if (!mismatchSince) {
          mismatchSince = performance.now();
        } else if (performance.now() - mismatchSince > 1000) {
          // Mismatch persisted for 1s — try to correct
          mismatchSince = null;
          startCommandCooldown(); // prevent echo from correction

          if (expectedPlayState === State.PLAYING) {
            hookedVideo.play().then(() => {
              // Worked — state will match on next tick
            }).catch(() => {
              // Play failed — need user gesture. Drop to gesture state
              // so the user sees the toast and can click play
              synced = false;
              needsGesture = true;
              expectedPlayState = null;
              stopStateCheck();
              updateSyncBarStatus(SyncStatus.CLICKJOIN);
              showJoinToast(Copy.CLICK_PLAY_TOAST);
              waitForNativePlay();
            });
          } else {
            hookedVideo.pause();
          }
        }
      } else {
        mismatchSince = null;
      }
    }, 200);
  }

  function stopStateCheck() {
    if (stateCheckInterval) {
      clearInterval(stateCheckInterval);
      stateCheckInterval = null;
    }
    mismatchSince = null;
  }

  // Command cooldown — blocks ALL outbound events for 500ms after a server
  // command. Prevents echo loops where a failed play() or seek-triggered pause
  // leaks back to the server.
  function startCommandCooldown() {
    if (commandCooldown) clearTimeout(commandCooldown);
    commandCooldown = setTimeout(() => { commandCooldown = null; }, 500);
  }

  // Suppression — single-shot for HTML5 <video> elements.
  // Unlike YouTube (which fires multi-event sequences like BUFFERING→PLAYING),
  // HTML5 video fires clean single events. Suppress only the expected event;
  // let non-matching events through so fast user actions aren't swallowed.
  function suppress(state) {
    suppressGen++;
    suppressUntilGen = suppressGen;
    expectedState = state;
    if (safetyTimeout) clearTimeout(safetyTimeout);
    safetyTimeout = setTimeout(() => {
      suppressUntilGen = 0;
      expectedState = null;
    }, 1500);
  }

  function shouldSuppress(currentState) {
    if (suppressUntilGen === 0) return false;
    if (currentState === expectedState) {
      // Expected event — swallow it and clear suppression
      suppressUntilGen = 0;
      expectedState = null;
      if (safetyTimeout) { clearTimeout(safetyTimeout); safetyTimeout = null; }
      return true;
    }
    // Non-matching event (e.g. user quickly paused while we expected "playing")
    // Clear suppression and let it through — it's a real user action
    suppressUntilGen = 0;
    expectedState = null;
    if (safetyTimeout) { clearTimeout(safetyTimeout); safetyTimeout = null; }
    return false;
  }

  // Handle commands from service worker
  function handleSWMessage(msg) {
    if (msg.type === Msg.CHANNEL_READY && window === window.top) {
      if (!synced && needsGesture) {
        updateSyncBarStatus(SyncStatus.SEARCHING);
        showJoinToast(Copy.PLAY_TO_SYNC);
      }
      return;
    }
    if (msg.type === Msg.VIDEO_HOOKED_BROADCAST && window === window.top) {
      // Only inject the sync bar if not already present — don't update
      // status here since it would overwrite per-client states like
      // "Click play to sync" across all tabs. Status is managed by
      // tryAutoSync/tryPlay/command:synced for each client individually.
      if (!window.location.hostname.includes(Hosts.YOUTUBE)) {
        injectSyncBar();
      }
      return;
    }
    if (msg.type === Msg.BAR_UPDATE && window === window.top && synced) {
      const fmt = (s) => Math.floor(s / 60) + ":" + Math.floor(s % 60).toString().padStart(2, "0");
      const timeEl = document.getElementById(El.TIME);
      const statusEl = document.getElementById(El.STATUS);
      const dotEl = document.getElementById(El.DOT);
      const playPauseBtn = document.getElementById(El.PLAYPAUSE);
      const progressWrap = document.getElementById(El.PROGRESS_WRAP);
      const progressFill = document.getElementById(El.PROGRESS_FILL);

      if (timeEl && msg.duration > 0) timeEl.textContent = fmt(msg.position) + " / " + fmt(msg.duration);
      else if (timeEl) timeEl.textContent = fmt(msg.position);

      // Don't overwrite "Finished — next in Xs" countdown with "Paused"
      if (statusEl && dotEl && !_countdownInterval) {
        if (msg.playing) {
          statusEl.textContent = Copy.PLAYING; statusEl.style.color = Color.GREEN; dotEl.style.background = Color.GREEN;
          statusEl.title = Copy.TIP_PLAYING;
        } else {
          statusEl.textContent = Copy.PAUSED; statusEl.style.color = Color.ORANGE; dotEl.style.background = Color.ORANGE;
          statusEl.title = Copy.TIP_PAUSED;
        }
      }

      // Show and update play/pause button + progress bar
      if (playPauseBtn) {
        playPauseBtn.style.display = "";
        playPauseBtn.textContent = msg.playing ? "⏸" : "▶";
        playPauseBtn.dataset.playing = msg.playing;
        playPauseBtn.dataset.position = msg.position;
      }
      if (progressWrap && progressFill) {
        progressWrap.style.display = "";
        progressWrap.dataset.duration = msg.duration;
        if (msg.duration > 0) {
          progressFill.style.width = ((msg.position / msg.duration) * 100) + "%";
        }
      }
      return;
    }

    if (msg.type === Msg.AUTOPLAY_COUNTDOWN && window === window.top) {
      startCountdown(msg.duration_ms || 5000);
      return;
    }
    if (msg.type === Msg.AUTOPLAY_CANCELLED && window === window.top) {
      clearCountdown();
      return;
    }

    if (msg.type === Msg.COMMAND_INITIAL_STATE) {
      tryAutoSync();
      return;
    }

    // Handle synced before hookedVideo/needsGesture guards — the top frame
    // may not have a hooked video (it's in an iframe) but still needs to
    // hide the toast and update the sync bar.
    if (msg.type === Msg.COMMAND_SYNCED) {
      const wasAlreadySynced = synced;
      synced = true;
      needsGesture = false;
      hideJoinToast();
      if (hookedVideo) {
        updateSyncBarStatus(hookedVideo.paused ? State.PAUSED : State.PLAYING);
        // Only send video:ready once, from the frame that has the video
        if (!wasAlreadySynced && port) port.postMessage({ type: Msg.VIDEO_READY });
      }
      return;
    }

    if (msg.type === Msg.READY_COUNT && window === window.top) {
      updateReadyCount(msg.ready, msg.has_tab, msg.total);
      return;
    }

    if (!hookedVideo) return;

    // If we're waiting for a user gesture, ignore commands — they'll just fail.
    if (needsGesture) return;

    switch (msg.type) {
      case Msg.COMMAND_PLAY:
        if (pauseEnforcer) { clearInterval(pauseEnforcer); pauseEnforcer = null; }
        expectedPlayState = State.PLAYING;
        startCommandCooldown();
        if (msg.position != null) hookedVideo.currentTime = msg.position;
        if (hookedVideo.paused) {
          hookedVideo.play().catch(() => {});
        }
        startStateCheck();
        break;

      case Msg.COMMAND_PAUSE:
        expectedPlayState = State.PAUSED;
        startCommandCooldown();
        if (msg.position != null) hookedVideo.currentTime = msg.position;
        hookedVideo.pause();
        // Enforce pause briefly — fights autoplay/delayed play from sites.
        if (pauseEnforcer) clearInterval(pauseEnforcer);
        pauseEnforcer = setInterval(() => {
          if (hookedVideo && !hookedVideo.paused) {
            hookedVideo.pause();
          }
        }, 200);
        setTimeout(() => { clearInterval(pauseEnforcer); pauseEnforcer = null; }, 2000);
        break;

      case Msg.COMMAND_SEEK:
        startCommandCooldown();
        hookedVideo.currentTime = msg.position;
        break;

    }
  }

  function tryAutoSync() {
    if (!hookedVideo) return;

    // If the user already provided a gesture (needsGesture=false), go
    // straight to sync — don't re-enter the waiting state even if the
    // video is momentarily paused (e.g. site replaced the video element).
    if (!needsGesture || !hookedVideo.paused) {
      needsGesture = false;
      hideJoinToast();
      requestSync();
    } else {
      // First time, video is paused — wait for user to click play
      needsGesture = true;
      updateSyncBarStatus(SyncStatus.CLICKJOIN);
      showJoinToast(Copy.CLICK_PLAY_TOAST);
      waitForNativePlay();
    }
  }

  function requestSync() {
    hideJoinToast();
    updateSyncBarStatus(SyncStatus.SYNCING);
    if (port) {
      port.postMessage({ type: Msg.VIDEO_REQUEST_SYNC });
    }
  }

  let _nativePlayListener = null;

  function waitForNativePlay() {
    if (!hookedVideo) return;

    // If video is already playing (race: site autoplayed during SW round-trip),
    // sync immediately instead of waiting for a click that already happened.
    if (!hookedVideo.paused) {
      needsGesture = false;
      requestSync();
      return;
    }

    // Remove any existing listener to prevent stacking
    if (_nativePlayListener) {
      hookedVideo.removeEventListener(Evt.PLAY, _nativePlayListener);
    }

    _nativePlayListener = () => {
      if (_nativePlayListener) {
        hookedVideo?.removeEventListener(Evt.PLAY, _nativePlayListener);
        _nativePlayListener = null;
      }
      // Video is actually playing now — clear gesture requirement
      needsGesture = false;
      requestSync();
    };
    hookedVideo.addEventListener(Evt.PLAY, _nativePlayListener);
  }

  function showJoinToast(text) {
    if (window !== window.top) return;
    hideJoinToast();

    const toast = document.createElement(Tag.DIV);
    toast.id = El.JOIN_TOAST;
    toast.style.cssText = `
      position: fixed; bottom: 48px; left: 50%; transform: translateX(-50%);
      z-index: 999999; background: ${Color.PURPLE}; color: white;
      font-family: system-ui, sans-serif; font-size: 15px; font-weight: 600;
      padding: 14px 28px; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(124,58,237, 0.5), 0 0 0 1px rgba(255,255,255,0.15);
      pointer-events: none;
      animation: byob-toast-pulse 2s ease-in-out infinite;
    `;
    toast.textContent = text;

    // Add pulse animation
    const style = document.createElement(Tag.STYLE);
    style.id = El.TOAST_STYLE;
    style.textContent = `
      @keyframes byob-toast-pulse {
        0%, 100% { opacity: 1; box-shadow: 0 4px 24px rgba(124,58,237, 0.5), 0 0 0 1px rgba(255,255,255,0.15); }
        50% { opacity: 0.85; box-shadow: 0 4px 32px rgba(124,58,237, 0.7), 0 0 0 1px rgba(255,255,255,0.25); }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(toast);
  }

  function hideJoinToast() {
    const toast = document.getElementById(El.JOIN_TOAST);
    if (toast) toast.remove();
    const style = document.getElementById(El.TOAST_STYLE);
    if (style) style.remove();
  }

  function injectSyncBar() {
    if (document.getElementById(El.SYNC_BAR)) return;

    // Try to insert after the video player area, not fixed to viewport
    // This avoids covering video controls
    const bar = document.createElement(Tag.DIV);
    bar.id = El.SYNC_BAR;

    bar.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 999999;
      background: rgba(0,0,0,0.92); color: white;
      font-family: system-ui, sans-serif; font-size: 13px;
      backdrop-filter: blur(10px); border-top: 1px solid rgba(255,255,255,0.15);
      transition: all 0.2s ease;
    `;

    const content = document.createElement(Tag.DIV);
    content.id = El.BAR_CONTENT;
    content.style.cssText = "display:flex;align-items:center;gap:10px;padding:6px 16px;";

    const logo = document.createElement(Tag.SPAN);
    logo.style.cssText = "font-weight:bold;font-size:14px;opacity:0.7;flex-shrink:0";
    logo.textContent = "byob";

    const dot = document.createElement(Tag.SPAN);
    dot.id = El.DOT;
    dot.style.cssText = "width:6px;height:6px;border-radius:50%;background:#888;flex-shrink:0";

    const status = document.createElement(Tag.SPAN);
    status.id = El.STATUS;
    status.style.cssText = "color:#888;font-size:12px;flex-shrink:0;cursor:default";
    status.textContent = "Loading...";

    // Play/pause button — hidden until synced
    const playPauseBtn = document.createElement(Tag.BUTTON);
    playPauseBtn.id = El.PLAYPAUSE;
    playPauseBtn.style.cssText = "display:none;background:none;border:none;color:white;cursor:pointer;font-size:14px;padding:0;margin:0;line-height:1;opacity:0.8;flex-shrink:0;outline:none;-webkit-user-select:none;user-select:none;vertical-align:middle;";
    playPauseBtn.textContent = "▶";
    playPauseBtn.addEventListener(Evt.CLICK, () => {
      if (port) {
        if (playPauseBtn.dataset.playing === "true") {
          port.postMessage({ type: Msg.VIDEO_PAUSE, position: parseFloat(playPauseBtn.dataset.position || 0) });
        } else {
          port.postMessage({ type: Msg.VIDEO_PLAY, position: parseFloat(playPauseBtn.dataset.position || 0) });
        }
      }
    });

    // Progress bar — hidden until synced
    const progressWrap = document.createElement(Tag.DIV);
    progressWrap.id = El.PROGRESS_WRAP;
    progressWrap.style.cssText = "display:none;flex:1;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;cursor:pointer;position:relative;min-width:60px;";
    const progressFill = document.createElement(Tag.DIV);
    progressFill.id = El.PROGRESS_FILL;
    progressFill.style.cssText = "height:100%;background:#7c3aed;border-radius:2px;width:0%;transition:width 0.3s linear;pointer-events:none;";
    progressWrap.appendChild(progressFill);
    progressWrap.addEventListener(Evt.CLICK, (e) => {
      const rect = progressWrap.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const dur = parseFloat(progressWrap.dataset.duration || 0);
      if (dur > 0 && port) {
        port.postMessage({ type: Msg.VIDEO_SEEK, position: frac * dur });
      }
    });

    const time = document.createElement(Tag.SPAN);
    time.id = El.TIME;
    time.style.cssText = "font-variant-numeric:tabular-nums;opacity:0.6;font-size:12px;flex-shrink:0";

    // Users ready indicator
    const usersEl = document.createElement(Tag.SPAN);
    usersEl.id = El.USERS;
    usersEl.style.cssText = "display:none;font-size:12px;flex-shrink:0;gap:4px;align-items:center;font-variant-numeric:tabular-nums;cursor:default";
    usersEl.innerHTML = `<svg id="byob-users-icon" width="14" height="14" viewBox="0 0 24 24" fill="rgba(255,255,255,0.5)" style="flex-shrink:0"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg><span id="byob-users-count" style="opacity:0.5">0/0</span>`;

    const collapse = document.createElement(Tag.BUTTON);
    collapse.id = El.COLLAPSE;
    collapse.style.cssText = "background:none;color:white;border:none;cursor:pointer;font-size:14px;opacity:0.5;padding:0 4px;line-height:1;outline:none;-webkit-user-select:none;user-select:none;flex-shrink:0;";
    collapse.textContent = "\u25BC";

    content.append(logo, dot, status, usersEl, playPauseBtn, progressWrap, time, collapse);
    bar.appendChild(content);

    // Collapse/expand toggle
    let collapsed = false;
    bar.querySelector("#" + El.COLLAPSE).addEventListener(Evt.CLICK, () => {
      collapsed = !collapsed;
      if (collapsed) {
        // Shrink to small pill on the right
        bar.style.left = "auto";
        bar.style.right = "16px";
        bar.style.bottom = "8px";
        bar.style.borderRadius = "6px";
        bar.style.border = "1px solid rgba(255,255,255,0.15)";
        bar.style.borderTop = "1px solid rgba(255,255,255,0.15)";
        bar.querySelector("#" + El.BAR_CONTENT).style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 10px;";
        bar.querySelectorAll("#byob-dot, #byob-status, #byob-time, #byob-playpause, #byob-progress-wrap").forEach(el => el.style.display = "none");
        bar.querySelector("#" + El.COLLAPSE).textContent = "▲";
      } else {
        // Expand to full bar
        bar.style.left = "0";
        bar.style.right = "0";
        bar.style.bottom = "0";
        bar.style.borderRadius = "0";
        bar.style.border = "none";
        bar.style.borderTop = "1px solid rgba(255,255,255,0.15)";
        bar.querySelector("#" + El.BAR_CONTENT).style.cssText = "display:flex;align-items:center;gap:10px;padding:6px 16px;";
        bar.querySelectorAll("#byob-dot, #byob-status, #byob-time").forEach(el => el.style.display = "");
        // Only show controls if synced
        if (synced) {
          bar.querySelectorAll("#byob-playpause, #byob-progress-wrap").forEach(el => el.style.display = "");
        }
        bar.querySelector("#" + El.COLLAPSE).textContent = "▼";
      }
    });

    document.body.appendChild(bar);
  }

  function updateReadyCount(ready, hasTab, total) {
    const el = document.getElementById(El.USERS);
    const icon = document.getElementById(El.USERS_ICON);
    const count = document.getElementById(El.USERS_COUNT);
    if (!el || !icon || !count) return;

    el.style.display = "flex";

    const allReady = ready >= total && total > 0;
    const allHaveTab = hasTab >= total;

    count.textContent = `${ready}/${total}`;

    icon.setAttribute("fill", allReady ? Color.GREEN : Color.WHITE_50);
    count.style.opacity = allReady ? "1" : "0.5";
    count.style.color = allReady ? Color.GREEN : "white";

    // Tooltip — detailed breakdown
    const parts = [];
    if (allReady) {
      parts.push(`All ${total} users synced and ready to play`);
    } else {
      parts.push(`${ready} of ${total} ready`);
      const needTab = total - hasTab;
      const needClick = hasTab - ready;
      if (needTab > 0) parts.push(`${needTab} need${needTab === 1 ? "s" : ""} to open external player`);
      if (needClick > 0) parts.push(`${needClick} need${needClick === 1 ? "s" : ""} to click play`);
    }
    el.title = parts.join(" · ");
  }

  let _countdownInterval = null;

  function startCountdown(durationMs) {
    clearCountdown();
    const endTime = Date.now() + durationMs;
    updateSyncBarStatus(SyncStatus.FINISHED);

    const statusEl = document.getElementById(El.STATUS);
    const update = () => {
      const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
      if (statusEl) {
        statusEl.textContent = remaining > 0 ? `${Copy.FINISHED} — next in ${remaining}s` : Copy.LOADING_NEXT;
        statusEl.style.color = Color.PURPLE;
      }
      if (remaining <= 0) clearCountdown();
    };
    update();
    _countdownInterval = setInterval(update, 500);
  }

  function clearCountdown() {
    if (_countdownInterval) {
      clearInterval(_countdownInterval);
      _countdownInterval = null;
    }
  }

  function updateSyncBarStatus(state) {
    const dot = document.getElementById(El.DOT);
    const status = document.getElementById(El.STATUS);
    if (!dot || !status) return;

    const states = {
      loading:   { color: Color.GRAY,    text: Copy.CONNECTING, tip: Copy.TIP_CONNECTING },
      searching: { color: Color.ORANGE, text: Copy.PLAY_TO_SYNC, tip: Copy.TIP_SEARCHING },
      syncing:   { color: Color.ORANGE, text: Copy.SYNCING, tip: Copy.TIP_SYNCING },
      clickjoin: { color: Color.ORANGE, text: Copy.CLICK_PLAY, tip: Copy.TIP_CLICKJOIN },
      playing:   { color: Color.GREEN, text: Copy.PLAYING, tip: Copy.TIP_PLAYING },
      paused:    { color: Color.ORANGE, text: Copy.PAUSED, tip: Copy.TIP_PAUSED },
      finished:  { color: Color.PURPLE, text: Copy.FINISHED, tip: Copy.TIP_FINISHED },
    };
    const s = states[state];
    if (!s) return;
    dot.style.background = s.color;
    status.style.color = s.color;
    status.textContent = s.text;
    status.title = s.tip;
  }

  // Update time display on the sync bar
  setInterval(() => {
    if (!hookedVideo) return;
    const timeEl = document.getElementById(El.TIME);
    if (!timeEl) return;

    const t = hookedVideo.currentTime || 0;
    const d = hookedVideo.duration || 0;
    const fmt = (s) => Math.floor(s / 60) + ":" + Math.floor(s % 60).toString().padStart(2, "0");
    timeEl.textContent = d > 0 ? `${fmt(t)} / ${fmt(d)}` : fmt(t);

    // Only update status when synced — before that, status is managed by
    // tryAutoSync/tryPlay/waitForNativePlay
    if (synced && !_countdownInterval) {
      updateSyncBarStatus(hookedVideo.paused ? State.PAUSED : State.PLAYING);
    }
  }, 250);

  function cleanup() {
    activateArgs = null; // prevent reconnection
    synced = false;
    unhookVideo();
    const bar = document.getElementById(El.SYNC_BAR);
    if (bar) bar.remove();
  }

  // === YouTube Embed Seek Bar Injection ===
  // If we're inside a YouTube embed iframe, listen for sponsor segments
  // from the parent page and inject colored bars into YouTube's seek bar.
  function initYouTubeEmbed() {
    if (!window.location.hostname.includes(Hosts.YOUTUBE)) return;
    if (!window.location.pathname.startsWith("/embed/")) return;

    window.addEventListener(Evt.MESSAGE, (e) => {
      if (!e.data || e.data.type !== "byob:sponsor-segments") return;
      const { segments, duration } = e.data;
      if (!segments || !duration) return;

      // Wait for YouTube's seek bar to appear
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

    // Tell parent we're ready
    window.parent.postMessage({ type: "byob:embed-ready" }, "*");
  }

  function injectSegments(progressBar, segments, duration) {
    // Remove any existing segments (shouldn't be any since iframe is fresh)
    progressBar.querySelectorAll(".byob-sponsor-segment").forEach((el) => el.remove());

    const colors = {
      sponsor: Color.SB_SPONSOR,
      selfpromo: Color.SB_SELFPROMO,
      interaction: Color.SB_INTERACTION,
      intro: Color.SB_INTRO,
      outro: Color.SB_OUTRO,
      preview: Color.SB_PREVIEW,
      music_offtopic: Color.SB_MUSIC_OFFTOPIC,
      filler: Color.SB_FILLER,
    };

    const labels = {
      sponsor: "Sponsor",
      selfpromo: "Self Promotion",
      interaction: "Interaction",
      intro: "Intro",
      outro: "Outro",
      preview: "Preview",
      music_offtopic: "Non-Music",
      filler: "Filler",
    };

    // Make sure the progress bar is positioned for absolute children
    if (getComputedStyle(progressBar).position === "static") {
      progressBar.style.position = "relative";
    }

    // Ensure YouTube's playhead renders above our segments
    const playhead = document.querySelector("yt-progress-bar-playhead, .ytp-scrubber-container");
    if (playhead) playhead.style.zIndex = "50";

    for (const seg of segments) {
      const left = (seg.segment[0] / duration) * 100;
      const width = Math.max(
        0.3,
        ((seg.segment[1] - seg.segment[0]) / duration) * 100
      );
      const el = document.createElement(Tag.DIV);
      el.className = "byob-sponsor-segment";
      el.title = labels[seg.category] || seg.category;
      el.style.cssText = `
        position: absolute;
        bottom: 0;
        left: ${left}%;
        width: ${width}%;
        height: 3px;
        background: ${colors[seg.category] || Color.SB_SPONSOR};
        opacity: 0.8;
        z-index: 0;
        pointer-events: none;
        border-radius: 1px;
      `;
      progressBar.appendChild(el);
    }
  }

  // Run
  init();
  initYouTubeEmbed();
})();
