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

  // Signal extension is installed (page JS can detect this)
  document.documentElement.setAttribute("data-byob-extension", "true");

  // Check if we should activate on this page
  async function init() {
    // Listen for room page messages
    window.addEventListener("message", (e) => {
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
          const { room_id, server_url, target_url, timestamp } = config.watchparty_config;
          const age = Date.now() - (timestamp || 0);
          if (age < 30 * 60 * 1000) {
            // In nested iframes (video player embeds), always activate
            const isTopFrame = window === window.top;
            if (!isTopFrame) {
              activate(room_id, server_url);
              return;
            }
            // In top frame, match URL
            if (target_url) {
              const targetBase = new URL(target_url).origin + new URL(target_url).pathname;
              const currentBase = window.location.origin + window.location.pathname;
              if (currentBase.startsWith(targetBase) || targetBase.startsWith(currentBase)) {
                activate(room_id, server_url);
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

  function activate(roomId, serverUrl) {
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
    // Also relay up to top frame in case port isn't working in nested iframe
    try { window.top.postMessage({ type: "byob:relay", payload: reportHooked }, "*"); } catch (_) {}

    // Notify top frame via chrome.runtime that video was hooked
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

  // Suppression (generation counter)
  function suppress(state) {
    suppressGen++;
    suppressUntilGen = suppressGen;
    expectedState = state;
    if (safetyTimeout) clearTimeout(safetyTimeout);
    safetyTimeout = setTimeout(() => {
      suppressUntilGen = 0;
      expectedState = null;
    }, 3000);
  }

  function shouldSuppress(currentState) {
    if (suppressUntilGen === 0) return false;
    // Only suppress the event we're expecting (e.g. suppress "playing" after command:play)
    // Don't suppress other events — user actions like manual pause should go through
    if (currentState === expectedState) {
      suppressUntilGen = 0;
      expectedState = null;
      if (safetyTimeout) {
        clearTimeout(safetyTimeout);
        safetyTimeout = null;
      }
      return true;
    }
    // Not the expected event — clear suppression and let it through
    suppressUntilGen = 0;
    expectedState = null;
    if (safetyTimeout) {
      clearTimeout(safetyTimeout);
      safetyTimeout = null;
    }
    return false;
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

    bar.innerHTML = `
      <div id="byob-bar-content" style="display:flex;align-items:center;gap:12px;padding:6px 16px;">
        <span style="font-weight:bold;font-size:14px;opacity:0.7">byob</span>
        <span id="byob-dot" style="width:6px;height:6px;border-radius:50%;background:#888;flex-shrink:0"></span>
        <span id="byob-status" style="color:#888;font-size:12px">Loading...</span>
        <div style="flex:1"></div>
        <span id="byob-time" style="font-variant-numeric:tabular-nums;opacity:0.6;font-size:12px"></span>
        <button id="byob-collapse" style="
          background:none;color:white;border:none;cursor:pointer;
          font-size:14px;opacity:0.5;padding:0 4px;line-height:1;
          outline:none;-webkit-user-select:none;user-select:none;
        ">▼</button>
      </div>
    `;

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
