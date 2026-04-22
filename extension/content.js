// WatchParty content script — hooks <video> elements and relays sync commands via port to SW

(() => {
  "use strict";

  let port = null;
  let hookedVideo = null;
  let synced = false; // Don't send events until initial sync is done
  let pauseEnforcer = null;
  let suppressGen = 0;
  let suppressUntilGen = 0;
  let expectedState = null;
  let safetyTimeout = null;
  let timeReportInterval = null;

  // Signal extension is installed — only on our domain so other sites can't detect it
  if (window.location.hostname === "byob.video" || window.location.hostname === "localhost") {
    document.documentElement.setAttribute("data-byob-extension", "true");
  }

  // Check if we should activate on this page
  async function init() {
    // Listen for room page messages — only accept from our own origin
    window.addEventListener("message", (e) => {
      if (e.origin !== window.location.origin) return;
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
            timestamp: Date.now(),
          },
        });
      }
    });

    // Check storage for active room config — retry a few times since
    // storage write from room page may not have completed yet
    const tryActivate = async (attempt) => {
      if (attempt > 5) return;
      try {
        const config = await chrome.storage.local.get("watchparty_config");
        if (config.watchparty_config) {
          const { room_id, server_url, target_url, token, timestamp } = config.watchparty_config;
          const age = Date.now() - (timestamp || 0);
          if (age < 30 * 60 * 1000) {
            // In nested iframes (video player embeds), always activate
            const isTopFrame = window === window.top;
            if (!isTopFrame) {
              activate(room_id, server_url, token);
              return;
            }
            // In top frame, match URL
            if (target_url) {
              const targetBase = new URL(target_url).origin + new URL(target_url).pathname;
              const currentBase = window.location.origin + window.location.pathname;
              if (currentBase.startsWith(targetBase) || targetBase.startsWith(currentBase)) {
                activate(room_id, server_url, token);
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

  function activate(roomId, serverUrl, token) {
    // Show sync bar immediately in top frame with "Loading..." status
    if (window === window.top) {
      injectSyncBar();
      updateSyncBarStatus("loading");
    }

    // Connect port to service worker
    port = chrome.runtime.connect({ name: "watchparty" });
    port.postMessage({
      type: "connect",
      room_id: roomId,
      server_url: serverUrl,
      token: token,
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
      cleanup();
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

  function hookVideo(video) {
    if (hookedVideo === video) return;
    if (hookedVideo) {
      // Unhook previous
      unhookVideo();
    }

    hookedVideo = video;

    video.addEventListener("play", onVideoPlay);
    video.addEventListener("pause", onVideoPause);
    video.addEventListener("seeked", onVideoSeeked);
    video.addEventListener("ended", onVideoEnded);

    // Report that we found a video — try port first, fall back to top-frame relay
    const reportHooked = { type: "video:hooked", duration: video.duration || 0 };
    if (port) {
      port.postMessage(reportHooked);
    }
    // Notify top frame via extension messaging (works cross-origin, no postMessage("*"))
    if (!window.location.hostname.includes("youtube.com")) {
      try { chrome.runtime.sendMessage({ type: "byob:video-hooked" }); } catch (_) {}
    }

    // Update sync bar to show we found a video and are syncing
    updateSyncBarStatus("syncing");

    // Send periodic state updates (position, duration, playing) for relay to room + sync bar
    timeReportInterval = setInterval(() => {
      if (!hookedVideo) return;
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
    hookedVideo = null;
    if (timeReportInterval) {
      clearInterval(timeReportInterval);
      timeReportInterval = null;
    }
  }

  // Event handlers — with suppression
  function onVideoPlay() {
    if (!synced) return;
    if (shouldSuppress("playing")) return;
    if (port && hookedVideo) {
      port.postMessage({
        type: "video:play",
        position: hookedVideo.currentTime,
      });
    }
  }

  function onVideoPause() {
    if (!synced) return;
    if (shouldSuppress("paused")) return;
    if (port && hookedVideo) {
      port.postMessage({
        type: "video:pause",
        position: hookedVideo.currentTime,
      });
    }
  }

  function onVideoSeeked() {
    if (!synced) return;
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
    if (port) {
      port.postMessage({ type: "video:ended" });
    }
  }

  // Suppression — time-window based (matches suppression.js in main app)
  let terminalReached = false;
  let terminalAt = null;

  function suppress(state) {
    suppressGen++;
    suppressUntilGen = suppressGen;
    expectedState = state;
    terminalReached = false;
    terminalAt = null;
    if (safetyTimeout) clearTimeout(safetyTimeout);
    safetyTimeout = setTimeout(() => {
      suppressUntilGen = 0;
      expectedState = null;
      terminalReached = false;
      terminalAt = null;
    }, 3000);
  }

  function shouldSuppress(currentState) {
    if (suppressUntilGen === 0) return false;
    if (currentState === expectedState || expectedState === null) {
      if (!terminalReached) {
        terminalReached = true;
        terminalAt = performance.now();
      }
      if (performance.now() - terminalAt > 200) {
        suppressUntilGen = 0;
        expectedState = null;
        terminalReached = false;
        terminalAt = null;
        if (safetyTimeout) { clearTimeout(safetyTimeout); safetyTimeout = null; }
      }
    }
    // Suppress ALL events while active
    return true;
  }

  // Handle commands from service worker
  function handleSWMessage(msg) {
    if (msg.type === "byob:channel-ready" && window === window.top) {
      updateSyncBarStatus("searching");
      return;
    }
    if (msg.type === "byob:video-hooked" && window === window.top) {
      if (!window.location.hostname.includes("youtube.com")) {
        injectSyncBar();
        updateSyncBarStatus("syncing");
      }
      return;
    }
    if (msg.type === "byob:bar-update" && window === window.top) {
      const fmt = (s) => Math.floor(s / 60) + ":" + Math.floor(s % 60).toString().padStart(2, "0");
      const timeEl = document.getElementById("byob-time");
      const statusEl = document.getElementById("byob-status");
      const dotEl = document.getElementById("byob-dot");
      if (timeEl && msg.duration > 0) timeEl.textContent = fmt(msg.position) + " / " + fmt(msg.duration);
      else if (timeEl) timeEl.textContent = fmt(msg.position);
      if (statusEl && dotEl) {
        if (msg.playing) {
          statusEl.textContent = "Playing"; statusEl.style.color = "#00d400"; dotEl.style.background = "#00d400";
        } else {
          statusEl.textContent = "Paused"; statusEl.style.color = "#ff9900"; dotEl.style.background = "#ff9900";
        }
      }
      return;
    }

    if (msg.type === "command:initial-state") {
      updateSyncBarStatus("clickjoin");
      showAutoplayOverlay(msg.play_state, msg.current_time);
      return;
    }

    if (!hookedVideo) return;

    switch (msg.type) {
      case "command:play":
        if (pauseEnforcer) { clearInterval(pauseEnforcer); pauseEnforcer = null; }
        suppress("playing");
        if (msg.position != null) hookedVideo.currentTime = msg.position;
        hookedVideo.play().catch(() => {});
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

      case "command:synced":
        synced = true;
        break;
    }
  }

  function showAutoplayOverlay(playState, currentTime) {
    if (!hookedVideo) return;
    removeAutoplayOverlay();

    const overlay = document.createElement("div");
    overlay.id = "byob-autoplay-overlay";
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 999998;
      background: rgba(0,0,0,0.6); display: flex; align-items: center;
      justify-content: center; cursor: pointer; backdrop-filter: blur(2px);
    `;

    const btn = document.createElement("div");
    btn.style.cssText = `
      background: rgba(0,0,0,0.8); border: 2px solid rgba(255,255,255,0.3);
      border-radius: 16px; padding: 24px 36px; text-align: center;
      color: white; font-family: system-ui, sans-serif;
    `;
    btn.innerHTML = `
      <div style="font-size:48px;margin-bottom:12px">&#9654;</div>
      <div style="font-size:16px;font-weight:bold">Click to join playback</div>
      <div style="font-size:12px;opacity:0.6;margin-top:4px">Required by browser autoplay policy</div>
    `;

    overlay.appendChild(btn);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", () => {
      removeAutoplayOverlay();
      activateAfterGesture(playState, currentTime);
    }, { once: true });

    // Also detect if user clicks play on the native player directly
    const onNativePlay = () => {
      if (document.getElementById("byob-autoplay-overlay")) {
        removeAutoplayOverlay();
        activateAfterGesture(playState, currentTime);
      }
      hookedVideo?.removeEventListener("play", onNativePlay);
    };
    hookedVideo.addEventListener("play", onNativePlay);
  }

  function removeAutoplayOverlay() {
    const el = document.getElementById("byob-autoplay-overlay");
    if (el) el.remove();
  }

  function activateAfterGesture(playState, currentTime) {
    if (!hookedVideo) return;

    // Don't do play-pause-play to "unlock" autoplay — that breaks DRM players
    // (e.g. Crunchyroll). Instead, use the gesture directly for what we need:
    // seek to position, then play if room is playing.
    suppress(playState === "playing" ? "playing" : "paused");
    hookedVideo.currentTime = currentTime;

    if (playState === "playing") {
      // The click gesture is still active in this call stack — play() should work
      hookedVideo.play().then(() => {
        synced = true;
        updateSyncBarStatus("playing");
      }).catch(() => {
        // Autoplay still blocked or DRM not ready — enable sync anyway
        // so that when the user manually hits play, it syncs
        synced = true;
        updateSyncBarStatus("paused");
      });
    } else {
      synced = true;
      updateSyncBarStatus("paused");
    }
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
    content.style.cssText = "display:flex;align-items:center;gap:12px;padding:6px 16px;";

    const logo = document.createElement("span");
    logo.style.cssText = "font-weight:bold;font-size:14px;opacity:0.7";
    logo.textContent = "byob";

    const dot = document.createElement("span");
    dot.id = "byob-dot";
    dot.style.cssText = "width:6px;height:6px;border-radius:50%;background:#888;flex-shrink:0";

    const status = document.createElement("span");
    status.id = "byob-status";
    status.style.cssText = "color:#888;font-size:12px";
    status.textContent = "Loading...";

    const spacer = document.createElement("div");
    spacer.style.flex = "1";

    const time = document.createElement("span");
    time.id = "byob-time";
    time.style.cssText = "font-variant-numeric:tabular-nums;opacity:0.6;font-size:12px";

    const collapse = document.createElement("button");
    collapse.id = "byob-collapse";
    collapse.style.cssText = "background:none;color:white;border:none;cursor:pointer;font-size:14px;opacity:0.5;padding:0 4px;line-height:1;outline:none;-webkit-user-select:none;user-select:none;";
    collapse.textContent = "\u25BC";

    content.append(logo, dot, status, spacer, time, collapse);
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
        bar.querySelectorAll("#byob-dot, #byob-status, #byob-time, #byob-bar-content > div").forEach(el => el.style.display = "none");
        bar.querySelector("#byob-collapse").textContent = "▲";
      } else {
        // Expand to full bar
        bar.style.left = "0";
        bar.style.right = "0";
        bar.style.bottom = "0";
        bar.style.borderRadius = "0";
        bar.style.border = "none";
        bar.style.borderTop = "1px solid rgba(255,255,255,0.15)";
        bar.querySelector("#byob-bar-content").style.cssText = "display:flex;align-items:center;gap:12px;padding:6px 16px;";
        bar.querySelectorAll("#byob-dot, #byob-status, #byob-time, #byob-bar-content > div").forEach(el => el.style.display = "");
        bar.querySelector("#byob-collapse").textContent = "▼";
      }
    });

    document.body.appendChild(bar);
  }

  function updateSyncBarStatus(state) {
    const dot = document.getElementById("byob-dot");
    const status = document.getElementById("byob-status");
    if (!dot || !status) return;

    const states = {
      loading:   { color: "#888",    text: "Loading..." },
      searching: { color: "#ff9900", text: "Searching for video..." },
      syncing:   { color: "#ff9900", text: "Syncing..." },
      clickjoin: { color: "#ff9900", text: "Click video to join playback" },
      playing:   { color: "#00d400", text: "Playing" },
      paused:    { color: "#ff9900", text: "Paused" },
    };
    const s = states[state];
    if (!s) return;
    dot.style.background = s.color;
    status.style.color = s.color;
    status.textContent = s.text;
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

    // Show actual video state once we have a video (don't wait for synced flag)
    updateSyncBarStatus(hookedVideo.paused ? "paused" : "playing");
  }, 250);

  function cleanup() {
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
