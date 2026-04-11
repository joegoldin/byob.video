// WatchParty content script — hooks <video> elements and relays sync commands via port to SW

(() => {
  "use strict";

  let port = null;
  let hookedVideo = null;
  let suppressGen = 0;
  let suppressUntilGen = 0;
  let expectedState = null;
  let safetyTimeout = null;
  let timeReportInterval = null;

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
    // Only show sync bar in the frame that hooks the video, not immediately
    // (nested iframes will show it when they find a <video>)

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

    // Update sync bar to show we found a video
    updateSyncBarStatus("hooked");

    // Send periodic state updates (position, duration, playing) for relay to room
    timeReportInterval = setInterval(() => {
      if (hookedVideo) {
        const msg = {
          type: "video:state",
          position: hookedVideo.currentTime,
          duration: hookedVideo.duration || 0,
          playing: !hookedVideo.paused,
        };
        if (port) port.postMessage(msg);
        // Also relay up in case port isn't working in nested iframe
        try { window.top.postMessage({ type: "byob:relay", payload: msg }, "*"); } catch (_) {}
      }
    }, 1000);
  }

  function unhookVideo() {
    if (!hookedVideo) return;
    hookedVideo.removeEventListener("play", onVideoPlay);
    hookedVideo.removeEventListener("pause", onVideoPause);
    hookedVideo.removeEventListener("seeked", onVideoSeeked);
    hookedVideo = null;
    if (timeReportInterval) {
      clearInterval(timeReportInterval);
      timeReportInterval = null;
    }
  }

  // Event handlers — with suppression
  function onVideoPlay() {
    if (shouldSuppress("playing")) return;
    if (port && hookedVideo) {
      port.postMessage({
        type: "video:play",
        position: hookedVideo.currentTime,
      });
    }
  }

  function onVideoPause() {
    if (shouldSuppress("paused")) return;
    if (port && hookedVideo) {
      port.postMessage({
        type: "video:pause",
        position: hookedVideo.currentTime,
      });
    }
  }

  function onVideoSeeked() {
    if (shouldSuppress(null)) return;
    if (port && hookedVideo) {
      port.postMessage({
        type: "video:seek",
        position: hookedVideo.currentTime,
      });
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
    if (currentState === expectedState) {
      suppressUntilGen = 0;
      expectedState = null;
      if (safetyTimeout) {
        clearTimeout(safetyTimeout);
        safetyTimeout = null;
      }
    }
    return true;
  }

  // Handle commands from service worker
  function handleSWMessage(msg) {
    // Show sync bar in top frame when notified a nested frame hooked a video
    if (msg.type === "byob:video-hooked" && window === window.top) {
      if (!window.location.hostname.includes("youtube.com")) {
        injectSyncBar();
        updateSyncBarStatus("hooked");
      }
      return;
    }

    if (!hookedVideo) return;

    switch (msg.type) {
      case "command:play":
        suppress("playing");
        if (msg.position != null) hookedVideo.currentTime = msg.position;
        hookedVideo.play().catch(() => {});
        break;

      case "command:pause":
        suppress("paused");
        if (msg.position != null) hookedVideo.currentTime = msg.position;
        hookedVideo.pause();
        break;

      case "command:seek":
        suppress(null);
        hookedVideo.currentTime = msg.position;
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
      transition: transform 0.2s ease;
    `;

    bar.innerHTML = `
      <div id="byob-bar-content" style="display:flex;align-items:center;gap:12px;padding:6px 16px;">
        <span style="font-weight:bold;font-size:14px;opacity:0.7">byob</span>
        <span id="byob-dot" style="width:6px;height:6px;border-radius:50%;background:#ff9900;flex-shrink:0"></span>
        <span id="byob-status" style="color:#ff9900;font-size:12px">Waiting for video...</span>
        <div style="flex:1"></div>
        <span id="byob-time" style="font-variant-numeric:tabular-nums;opacity:0.6;font-size:12px"></span>
      </div>
      <button id="byob-collapse" style="
        position:absolute;top:-20px;right:12px;
        background:rgba(0,0,0,0.85);color:white;border:1px solid rgba(255,255,255,0.15);
        border-bottom:none;border-radius:6px 6px 0 0;
        padding:2px 10px;font-size:11px;cursor:pointer;
        backdrop-filter:blur(8px);
      ">▼</button>
    `;

    // Collapse/expand toggle
    let collapsed = false;
    bar.querySelector("#byob-collapse").addEventListener("click", () => {
      collapsed = !collapsed;
      bar.style.transform = collapsed ? "translateY(100%)" : "translateY(0)";
      bar.querySelector("#byob-collapse").textContent = collapsed ? "▲ byob" : "▼";
      bar.querySelector("#byob-collapse").style.top = collapsed ? "-24px" : "-20px";
    });

    document.body.appendChild(bar);
  }

  function updateSyncBarStatus(state) {
    const dot = document.getElementById("byob-dot");
    const status = document.getElementById("byob-status");
    if (!dot || !status) return;

    if (state === "hooked") {
      dot.style.background = "#00d400";
      status.style.color = "#00d400";
      status.textContent = "Video captured - Syncing";
    } else if (state === "waiting") {
      dot.style.background = "#ff9900";
      status.style.color = "#ff9900";
      status.textContent = "Waiting for video... Click play to start";
    }
  }

  // Update time display on the sync bar
  setInterval(() => {
    if (!hookedVideo) return;
    const timeEl = document.getElementById("byob-time");
    const statusEl = document.getElementById("byob-status");
    const dotEl = document.getElementById("byob-dot");
    if (!timeEl) return;

    const t = hookedVideo.currentTime || 0;
    const d = hookedVideo.duration || 0;
    const fmt = (s) => Math.floor(s / 60) + ":" + Math.floor(s % 60).toString().padStart(2, "0");
    timeEl.textContent = d > 0 ? `${fmt(t)} / ${fmt(d)}` : fmt(t);

    if (statusEl && dotEl) {
      if (hookedVideo.paused) {
        statusEl.textContent = "Paused";
        statusEl.style.color = "#ff9900";
        dotEl.style.background = "#ff9900";
      } else {
        statusEl.textContent = "Syncing";
        statusEl.style.color = "#00d400";
        dotEl.style.background = "#00d400";
      }
    }
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
