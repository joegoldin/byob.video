// WatchParty content script — hooks <video> elements and relays sync commands via port to SW

(() => {
  "use strict";

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
  let syncCooldown = null; // { position, playState } — suppress outbound until video matches

  // Signal extension is installed — only on our domain so other sites can't detect it
  if (window.location.hostname === "byob.video" || window.location.hostname === "localhost") {
    document.documentElement.setAttribute("data-byob-extension", "true");
  }

  // Check if we should activate on this page
  async function init() {
    // Listen for room page messages — only accept from our own origin
    window.addEventListener("message", (e) => {
      if (e.origin !== window.location.origin) return;
      try {
        if (e.data?.type === "byob:clear-external") {
          chrome.storage.local.remove("watchparty_config");
          return;
        }
        if (e.data?.type === "byob:open-external") {
          chrome.storage.local.set({
            watchparty_config: {
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
        const config = await chrome.storage.local.get("watchparty_config");
        if (config.watchparty_config) {
          const { room_id, server_url, target_url, token, username, timestamp } = config.watchparty_config;
          const age = Date.now() - (timestamp || 0);
          if (age < 30 * 60 * 1000) {
            // Don't activate extension sync on our own domain — the main
            // site handles sync via LiveView. Extension only sets the
            // data-byob-extension attribute there (done above).
            const host = window.location.hostname;
            if (host === "byob.video" || host === "localhost") return;

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
                showJoinToast("Loading byob sync...");
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
      updateSyncBarStatus("loading");
    }

    // Connect port to service worker
    try {
      port = chrome.runtime.connect({ name: "watchparty" });
    } catch (e) {
      // Service worker not available — retry after a delay
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

    // Relay messages from nested iframes to the SW port
    window.addEventListener("message", (e) => {
      if (e.data?.type === "byob:relay" && e.data.payload && port) {
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
      if (host.includes("crunchyroll.com")) {
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
    const wasHooked = !!hookedVideo;
    if (hookedVideo) {
      // Unhook previous
      unhookVideo();
    }
    // If a previously-hooked video was replaced while synced, reset synced
    // to prevent sending position=0 from the new element before re-sync.
    if (wasHooked && synced) {
      synced = false;
    }

    hookedVideo = video;

    video.addEventListener("play", onVideoPlay);
    video.addEventListener("pause", onVideoPause);
    video.addEventListener("seeked", onVideoSeeked);
    video.addEventListener("ended", onVideoEnded);

    // Report that we found a video — include page metadata for byob display
    const meta = scrapePageMetadata();
    const reportHooked = { type: "video:hooked", duration: video.duration || 0, ...meta };
    if (port) {
      port.postMessage(reportHooked);
    }
    // Notify top frame via extension messaging (works cross-origin, no postMessage("*"))
    if (!window.location.hostname.includes("youtube.com")) {
      try { chrome.runtime.sendMessage({ type: "byob:video-hooked" }); } catch (_) {}
    }

    // If still waiting for gesture (site replaced video element), re-register
    if (needsGesture) {
      waitForNativePlay();
    } else {
      updateSyncBarStatus("syncing");
    }

    // Send periodic state updates (position, duration, playing) for relay to room + sync bar
    timeReportInterval = setInterval(() => {
      if (!hookedVideo) return;

      // Check if sync cooldown can be cleared — video matches target state
      if (syncCooldown && hookedVideo) {
        const posDist = Math.abs(hookedVideo.currentTime - syncCooldown.position);
        const actualState = hookedVideo.paused ? "paused" : "playing";
        if (posDist < 3 && actualState === syncCooldown.playState) {
          syncCooldown = null; // settled — outbound events can flow
        }
      }

      const msg = {
        type: "video:state",
        position: hookedVideo.currentTime,
        duration: hookedVideo.duration || 0,
        playing: !hookedVideo.paused,
      };
      // Only send state to server when synced (prevents corrupting canonical state)
      if (synced && port) port.postMessage(msg);
      // Always send bar update via port so background can relay to top frame
      if (port) port.postMessage({ type: "byob:bar-update", position: msg.position, duration: msg.duration, playing: msg.playing });
    }, 500);
  }

  function unhookVideo() {
    if (!hookedVideo) return;
    hookedVideo.removeEventListener("play", onVideoPlay);
    hookedVideo.removeEventListener("pause", onVideoPause);
    hookedVideo.removeEventListener("seeked", onVideoSeeked);
    hookedVideo.removeEventListener("ended", onVideoEnded);
    if (_nativePlayListener) {
      hookedVideo.removeEventListener("play", _nativePlayListener);
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
    if (!synced || syncCooldown) return;
    if (shouldSuppress("playing")) return;
    if (port && hookedVideo) {
      port.postMessage({
        type: "video:play",
        position: hookedVideo.currentTime,
      });
    }
  }

  function onVideoPause() {
    if (!synced || syncCooldown) return;
    if (shouldSuppress("paused")) return;
    if (port && hookedVideo) {
      port.postMessage({
        type: "video:pause",
        position: hookedVideo.currentTime,
      });
    }
  }

  function onVideoSeeked() {
    if (!synced || syncCooldown) return;
    if (shouldSuppress(null)) return;
    if (port && hookedVideo) {
      port.postMessage({
        type: "video:seek",
        position: hookedVideo.currentTime,
      });
    }
  }

  function onVideoEnded() {
    if (!synced) return;
    // Position-based ended detection: only send if valid duration >60s and
    // position is past 90%. This prevents spurious ended events from short
    // clips, ads, or when the site fires ended on element replacement.
    const dur = hookedVideo?.duration;
    const pos = hookedVideo?.currentTime || 0;
    if (!dur || !isFinite(dur) || dur < 60 || pos < dur * 0.9) return;
    if (port) {
      port.postMessage({ type: "video:ended" });
    }
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
    if (currentState === expectedState || expectedState === null) {
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
    if (msg.type === "byob:channel-ready" && window === window.top) {
      if (!synced && needsGesture) {
        updateSyncBarStatus("searching");
        showJoinToast("Play the video to start syncing");
      }
      return;
    }
    if (msg.type === "byob:video-hooked" && window === window.top) {
      // Only inject the sync bar if not already present — don't update
      // status here since it would overwrite per-client states like
      // "Click play to sync" across all tabs. Status is managed by
      // tryAutoSync/tryPlay/command:synced for each client individually.
      if (!window.location.hostname.includes("youtube.com")) {
        injectSyncBar();
      }
      return;
    }
    if (msg.type === "byob:bar-update" && window === window.top && synced) {
      const fmt = (s) => Math.floor(s / 60) + ":" + Math.floor(s % 60).toString().padStart(2, "0");
      const timeEl = document.getElementById("byob-time");
      const statusEl = document.getElementById("byob-status");
      const dotEl = document.getElementById("byob-dot");
      const playPauseBtn = document.getElementById("byob-playpause");
      const progressWrap = document.getElementById("byob-progress-wrap");
      const progressFill = document.getElementById("byob-progress-fill");

      if (timeEl && msg.duration > 0) timeEl.textContent = fmt(msg.position) + " / " + fmt(msg.duration);
      else if (timeEl) timeEl.textContent = fmt(msg.position);

      // Don't overwrite "Finished — next in Xs" countdown with "Paused"
      if (statusEl && dotEl && !_countdownInterval) {
        if (msg.playing) {
          statusEl.textContent = "Playing"; statusEl.style.color = "#00d400"; dotEl.style.background = "#00d400";
          statusEl.title = "Video is playing in sync with the room";
        } else {
          statusEl.textContent = "Paused"; statusEl.style.color = "#ff9900"; dotEl.style.background = "#ff9900";
          statusEl.title = "Video is paused — synced with room";
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

    // Handle synced before hookedVideo/needsGesture guards — the top frame
    // may not have a hooked video (it's in an iframe) but still needs to
    // hide the toast and update the sync bar.
    if (msg.type === "command:synced") {
      const wasAlreadySynced = synced;
      synced = true;
      needsGesture = false;
      // Suppress outbound events until video matches the sync target.
      // Target comes from the preceding command:play/pause/seek.
      if (hookedVideo) {
        syncCooldown = {
          position: hookedVideo.currentTime, // position we were just seeked to
          playState: expectedState === "playing" ? "playing" : "paused",
        };
      }
      hideJoinToast();
      if (hookedVideo) {
        updateSyncBarStatus(hookedVideo.paused ? "paused" : "playing");
        if (!wasAlreadySynced && port) port.postMessage({ type: "video:ready" });
      }
      return;
    }

    if (msg.type === "byob:ready-count" && window === window.top) {
      updateReadyCount(msg.ready, msg.has_tab, msg.total);
      return;
    }

    if (!hookedVideo) return;

    // If waiting for gesture and a play command arrives, try playing —
    // the browser may allow it if the user interacted with the page.
    if (needsGesture && msg.type === "command:play") {
      suppress("playing"); // prevent play event from sending stale position to server
      if (msg.position != null) hookedVideo.currentTime = msg.position;
      hookedVideo.play().then(() => {
        needsGesture = false;
        hideJoinToast();
        requestSync(); // gets computed position from server and seeks there
      }).catch(() => {});
      return;
    }

    // If we're waiting for a user gesture, ignore other commands.
    if (needsGesture) return;

    switch (msg.type) {
      case "command:play":
        if (pauseEnforcer) { clearInterval(pauseEnforcer); pauseEnforcer = null; }
        suppress("playing");
        // Seek if needed, then play. Don't use tryPlay() here — if the user
        // already clicked play (requestSync flow), the video is playing and
        // we just need to adjust position. play() on an already-playing video
        // resolves immediately without needing a gesture.
        if (msg.position != null) hookedVideo.currentTime = msg.position;
        if (hookedVideo.paused) {
          hookedVideo.play().catch(() => {});
        }
        break;

      case "command:pause":
        suppress("paused");
        if (msg.position != null) hookedVideo.currentTime = msg.position;
        hookedVideo.pause();
        // Enforce pause for 2s — fights autoplay/delayed play from sites
        if (pauseEnforcer) clearInterval(pauseEnforcer);
        pauseEnforcer = setInterval(() => {
          if (hookedVideo && !hookedVideo.paused) {
            suppress("paused");
            hookedVideo.pause();
          }
        }, 200);
        setTimeout(() => { clearInterval(pauseEnforcer); pauseEnforcer = null; }, 2000);
        break;

      case "command:seek":
        suppress(null);
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
      updateSyncBarStatus("clickjoin");
      showJoinToast("Click play on the video to start syncing");
      waitForNativePlay();
    }
  }

  function requestSync() {
    hideJoinToast();
    updateSyncBarStatus("syncing");
    if (port) {
      port.postMessage({ type: "video:request-sync" });
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
      hookedVideo.removeEventListener("play", _nativePlayListener);
    }

    _nativePlayListener = () => {
      if (_nativePlayListener) {
        hookedVideo?.removeEventListener("play", _nativePlayListener);
        _nativePlayListener = null;
      }
      // Video is actually playing now — clear gesture requirement
      needsGesture = false;
      requestSync();
    };
    hookedVideo.addEventListener("play", _nativePlayListener);
  }

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

    // Add pulse animation
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

  function injectSyncBar() {
    if (document.getElementById("byob-sync-bar")) return;

    // Try to insert after the video player area, not fixed to viewport
    // This avoids covering video controls
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

    // Play/pause button — hidden until synced
    const playPauseBtn = document.createElement("button");
    playPauseBtn.id = "byob-playpause";
    playPauseBtn.style.cssText = "display:none;background:none;border:none;color:white;cursor:pointer;font-size:14px;padding:0;margin:0;line-height:1;opacity:0.8;flex-shrink:0;outline:none;-webkit-user-select:none;user-select:none;vertical-align:middle;";
    playPauseBtn.textContent = "▶";
    playPauseBtn.addEventListener("click", () => {
      if (port) {
        if (playPauseBtn.dataset.playing === "true") {
          port.postMessage({ type: "video:pause", position: parseFloat(playPauseBtn.dataset.position || 0) });
        } else {
          port.postMessage({ type: "video:play", position: parseFloat(playPauseBtn.dataset.position || 0) });
        }
      }
    });

    // Progress bar — hidden until synced
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
      if (dur > 0 && port) {
        port.postMessage({ type: "video:seek", position: frac * dur });
      }
    });

    const time = document.createElement("span");
    time.id = "byob-time";
    time.style.cssText = "font-variant-numeric:tabular-nums;opacity:0.6;font-size:12px;flex-shrink:0";

    // Users ready indicator
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
    collapse.textContent = "\u25BC";

    content.append(logo, dot, status, usersEl, playPauseBtn, progressWrap, time, collapse);
    bar.appendChild(content);

    // Collapse/expand toggle
    let collapsed = false;
    bar.querySelector("#byob-collapse").addEventListener("click", () => {
      collapsed = !collapsed;
      if (collapsed) {
        // Shrink to small pill on the right
        bar.style.left = "auto";
        bar.style.right = "16px";
        bar.style.bottom = "8px";
        bar.style.borderRadius = "6px";
        bar.style.border = "1px solid rgba(255,255,255,0.15)";
        bar.style.borderTop = "1px solid rgba(255,255,255,0.15)";
        bar.querySelector("#byob-bar-content").style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 10px;";
        bar.querySelectorAll("#byob-dot, #byob-status, #byob-time, #byob-playpause, #byob-progress-wrap").forEach(el => el.style.display = "none");
        bar.querySelector("#byob-collapse").textContent = "▲";
      } else {
        // Expand to full bar
        bar.style.left = "0";
        bar.style.right = "0";
        bar.style.bottom = "0";
        bar.style.borderRadius = "0";
        bar.style.border = "none";
        bar.style.borderTop = "1px solid rgba(255,255,255,0.15)";
        bar.querySelector("#byob-bar-content").style.cssText = "display:flex;align-items:center;gap:10px;padding:6px 16px;";
        bar.querySelectorAll("#byob-dot, #byob-status, #byob-time").forEach(el => el.style.display = "");
        // Only show controls if synced
        if (synced) {
          bar.querySelectorAll("#byob-playpause, #byob-progress-wrap").forEach(el => el.style.display = "");
        }
        bar.querySelector("#byob-collapse").textContent = "▼";
      }
    });

    document.body.appendChild(bar);
  }

  function updateReadyCount(ready, hasTab, total) {
    const el = document.getElementById("byob-users");
    const icon = document.getElementById("byob-users-icon");
    const count = document.getElementById("byob-users-count");
    if (!el || !icon || !count) return;

    el.style.display = "flex";

    const allReady = ready >= total && total > 0;
    const allHaveTab = hasTab >= total;

    count.textContent = `${ready}/${total}`;

    icon.setAttribute("fill", allReady ? "#00d400" : "rgba(255,255,255,0.5)");
    count.style.opacity = allReady ? "1" : "0.5";
    count.style.color = allReady ? "#00d400" : "white";

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
    if (_countdownInterval) {
      clearInterval(_countdownInterval);
      _countdownInterval = null;
    }
  }

  function updateSyncBarStatus(state) {
    const dot = document.getElementById("byob-dot");
    const status = document.getElementById("byob-status");
    if (!dot || !status) return;

    const states = {
      loading:   { color: "#888",    text: "Connecting...", tip: "Connecting to the byob room server" },
      searching: { color: "#ff9900", text: "Play the video to start syncing", tip: "Waiting for a video element on this page" },
      syncing:   { color: "#ff9900", text: "Syncing...", tip: "Applying room state to this player" },
      clickjoin: { color: "#ff9900", text: "Click play to sync", tip: "Click play on the video player above to start syncing with the room" },
      playing:   { color: "#00d400", text: "Playing", tip: "Video is playing in sync with the room" },
      paused:    { color: "#ff9900", text: "Paused", tip: "Video is paused — synced with room" },
      finished:  { color: "#7c3aed", text: "Finished", tip: "Video ended — next video loading" },
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
    const timeEl = document.getElementById("byob-time");
    if (!timeEl) return;

    const t = hookedVideo.currentTime || 0;
    const d = hookedVideo.duration || 0;
    const fmt = (s) => Math.floor(s / 60) + ":" + Math.floor(s % 60).toString().padStart(2, "0");
    timeEl.textContent = d > 0 ? `${fmt(t)} / ${fmt(d)}` : fmt(t);

    // Only update status when synced — before that, status is managed by
    // tryAutoSync/tryPlay/waitForNativePlay
    if (synced && !_countdownInterval) {
      updateSyncBarStatus(hookedVideo.paused ? "paused" : "playing");
    }
  }, 250);

  function cleanup() {
    activateArgs = null; // prevent reconnection
    synced = false;
    unhookVideo();
    const bar = document.getElementById("byob-sync-bar");
    if (bar) bar.remove();
  }

  // === YouTube Embed Seek Bar Injection ===
  // If we're inside a YouTube embed iframe, listen for sponsor segments
  // from the parent page and inject colored bars into YouTube's seek bar.
  function initYouTubeEmbed() {
    if (!window.location.hostname.includes("youtube.com")) return;
    if (!window.location.pathname.startsWith("/embed/")) return;

    window.addEventListener("message", (e) => {
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
      sponsor: "#00d400",
      selfpromo: "#ffff00",
      interaction: "#cc00ff",
      intro: "#00ffff",
      outro: "#0202ed",
      preview: "#008fd6",
      music_offtopic: "#ff9900",
      filler: "#7300FF",
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
      const el = document.createElement("div");
      el.className = "byob-sponsor-segment";
      el.title = labels[seg.category] || seg.category;
      el.style.cssText = `
        position: absolute;
        bottom: 0;
        left: ${left}%;
        width: ${width}%;
        height: 3px;
        background: ${colors[seg.category] || "#00d400"};
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
