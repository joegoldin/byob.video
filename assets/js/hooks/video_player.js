import { loadYouTubeAPI } from "../lib/youtube_loader";
import { ClockSync } from "../sync/clock_sync";
import { Suppression } from "../sync/suppression";
import { Reconcile } from "../sync/reconcile";

// YouTube player state constants
const YT_UNSTARTED = -1;
const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;
const YT_CUED = 5;

const VideoPlayer = {
  mounted() {
    this.player = null;
    this.clockSync = new ClockSync((event, payload) =>
      this.pushEvent(event, payload)
    );
    this.suppression = new Suppression();
    this.reconcile = new Reconcile({
      getCurrentTime: () => this._getCurrentTime(),
      seekTo: (t) => this._seekTo(t),
      setPlaybackRate: (r) => this._setPlaybackRate(r),
    });

    this.sourceType = null;
    this.sourceId = null;
    this.bufferedState = null;
    this.isReady = false;
    this.userId = null;
    this.lastKnownPosition = 0;
    this.seekDetectorInterval = null;
    this.stateCheckInterval = null;
    this.expectedPlayState = null; // "playing" or "paused"
    this.sponsorSegments = [];
    this.sponsorCheckInterval = null;
    this.sbSettings = {};
    this._lastSponsorData = null;

    // Listen for YouTube embed iframe signaling it's ready for segments
    this._embedReadyHandler = (e) => {
      if (e.data?.type === "byob:embed-ready") {
        this._sendSegmentsToEmbed();
      }
    };
    window.addEventListener("message", this._embedReadyHandler);

    // Listen for server events
    this.handleEvent("sync:state", (state) => this._onSyncState(state));
    this.handleEvent("sync:play", (data) => this._onSyncPlay(data));
    this.handleEvent("sync:pause", (data) => this._onSyncPause(data));
    this.handleEvent("sync:seek", (data) => this._onSyncSeek(data));
    this.handleEvent("sync:pong", (data) => this.clockSync.handlePong(data));
    this.handleEvent("sync:correction", (data) => this._onSyncCorrection(data));
    this.handleEvent("sponsor:segments", (data) => this._onSponsorSegments(data));
    this.handleEvent("ext:player-state", (data) => this._onExtPlayerState(data));
    this.handleEvent("sb:settings", (data) => {
      this.sbSettings = data;
      this._applySponsorSettings();
    });
    this.handleEvent("video:change", (data) => this._onVideoChange(data));
  },

  reconnected() {
    // LiveView reconnected — server will push fresh sync:state
    // Reset clock sync to re-calibrate
    this.clockSync.stop();
    this.clockSync = new ClockSync((event, payload) =>
      this.pushEvent(event, payload)
    );
  },

  destroyed() {
    this.reconcile.stop();
    this.suppression.destroy();
    this.clockSync.stop();
    if (this.seekDetectorInterval) clearInterval(this.seekDetectorInterval);
    if (this.stateCheckInterval) clearInterval(this.stateCheckInterval);
    if (this.sponsorCheckInterval) clearInterval(this.sponsorCheckInterval);
    if (this._embedReadyHandler) window.removeEventListener("message", this._embedReadyHandler);
    if (this.player && this.player.destroy) {
      this.player.destroy();
    }
  },

  // Two-step join: buffer state, clock sync, then apply
  async _onSyncState(state) {
    if (state.user_id) this.userId = state.user_id;
    this.bufferedState = state;
    await this.clockSync.start();
    this.clockSync.maintainSync();
    this._applyBufferedState();
  },

  _applyBufferedState() {
    const state = this.bufferedState;
    if (!state) return;
    this.bufferedState = null;

    if (state.queue && state.queue.length > 0 && state.current_index != null) {
      const item = state.queue[state.current_index];
      if (item) {
        this._loadVideo(item.source_type, item.source_id, item.url);

        // After player is ready, seek to correct position
        this._pendingState = state;
      }
    }
  },

  _applyPendingState() {
    const state = this._pendingState;
    if (!state) return;
    this._pendingState = null;

    if (state.play_state === "playing") {
      const elapsed =
        (this.clockSync.serverNow() - state.server_time) / 1000;
      const position = state.current_time + elapsed;
      this.expectedPlayState = "playing";
      this.suppression.suppress("playing");
      this._seekTo(position);
      this._play();
      this.reconcile.setServerState(
        state.current_time,
        state.server_time,
        this.clockSync
      );
      this.reconcile.pauseFor(2000);
      this.reconcile.start();

      // Retry play if autoplay was blocked — check at 500ms, 1s, 2s
      const retryPlay = (attempt) => {
        if (attempt > 3) return;
        setTimeout(() => {
          const yt = this.player?.getPlayerState?.();
          if (yt !== undefined && yt !== YT_PLAYING && yt !== YT_BUFFERING) {
            this.suppression.suppress("playing");
            this._play();
          }
        }, attempt * 500);
      };
      retryPlay(1);
      retryPlay(2);
      retryPlay(3);
    } else if (state.play_state === "paused") {
      this.expectedPlayState = "paused";
      this.suppression.suppress("paused");
      // Use cueVideoById to show thumbnail at the right position without playing
      if (this.sourceType === "youtube" && this.player?.cueVideoById) {
        this.player.cueVideoById({
          videoId: this.sourceId,
          startSeconds: state.current_time,
        });
      } else {
        this._seekTo(state.current_time);
      }
    }
  },

  async _loadVideo(sourceType, sourceId, url, mediaItem) {
    this.sourceType = sourceType;
    this.sourceId = sourceId;

    if (sourceType === "youtube") {
      await this._loadYouTube(sourceId);
    } else {
      // Extension-required: destroy YouTube player, show placeholder
      if (this.player && this.player.destroy) {
        try { this.player.destroy(); } catch (_) {}
        this.player = null;
      }
      const title = mediaItem?.title || url;
      const thumb = mediaItem?.thumbnail_url;
      const thumbHtml = thumb
        ? `<img src="${thumb}" class="w-32 h-20 object-cover rounded opacity-80" />`
        : `<svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>`;
      this.el.innerHTML = `
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-base-content/60" id="ext-placeholder">
          ${thumbHtml}
          <p class="text-sm font-medium text-base-content/70 max-w-md text-center px-4 line-clamp-2" title="${title}">${title}</p>
          <p class="text-xs" id="ext-status">Waiting for external player...</p>
          <div id="ext-progress-container" class="w-3/4 max-w-md" style="display:none">
            <div class="relative h-1 rounded bg-base-content/10 overflow-hidden">
              <div id="ext-progress-fill" class="absolute left-0 top-0 h-full bg-primary rounded transition-all" style="width:0%"></div>
            </div>
            <div class="flex justify-between mt-1">
              <span id="ext-time-current" class="text-xs text-base-content/40 tabular-nums">0:00</span>
              <span id="ext-time-duration" class="text-xs text-base-content/40 tabular-nums">0:00</span>
            </div>
          </div>
        </div>
      `;
    }
  },

  async _loadYouTube(videoId) {
    const YT = await loadYouTubeAPI();

    // Clear existing player
    if (this.player && this.player.destroy) {
      this.player.destroy();
    }

    this.isReady = false;

    // Always create a fresh container — destroys old iframe and any injected segments
    this.el.innerHTML = "";
    const container = document.createElement("div");
    container.id = "yt-player";
    this.el.appendChild(container);

    // Autoplay if we have a pending state that says playing
    const shouldAutoplay = this._pendingState?.play_state === "playing" ? 1 : 0;

    this.player = new YT.Player("yt-player", {
      videoId: videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: shouldAutoplay,
        controls: 1,
        modestbranding: 1,
        rel: 0,
      },
      events: {
        onReady: () => {
          this.isReady = true;
          // Absolutely position the iframe inside the padding-bottom container
          const iframe = this.el.querySelector("iframe");
          if (iframe) {
            iframe.style.position = "absolute";
            iframe.style.top = "0";
            iframe.style.left = "0";
            iframe.style.width = "100%";
            iframe.style.height = "100%";
          }
          this._applyPendingState();
          this._startSeekDetector();
          // Re-render sponsor bar — retry until getDuration() returns > 0
          this._retrySponsorBar();
        },
        onStateChange: (event) => this._onYTStateChange(event),
      },
    });
  },

  _onYTStateChange(event) {
    const state = event.data;

    // Map YT state to our state names for suppression
    let stateName = null;
    if (state === YT_PLAYING) stateName = "playing";
    else if (state === YT_PAUSED) stateName = "paused";
    else if (state === YT_ENDED) stateName = "ended";

    // Buffering means a seek or rebuffer is happening — pause reconcile
    // so it doesn't fight the position change before PLAYING fires
    if (state === YT_BUFFERING) {
      this.reconcile.pauseFor(2000);
      return;
    }

    if (stateName && this.suppression.shouldSuppress(stateName)) {
      return;
    }

    if (state === YT_PLAYING) {
      this.expectedPlayState = "playing";
      const position = this.player.getCurrentTime();
      this.pushEvent("video:play", { position });
      // Update own reconcile so it doesn't drift-correct back to old position
      const serverTime = this.clockSync.serverNow();
      this.reconcile.setServerState(position, serverTime, this.clockSync);
      this.reconcile.pauseFor(1000); // let server catch up before correcting
      this.reconcile.start();
    } else if (state === YT_PAUSED) {
      this.expectedPlayState = "paused";
      const position = this.player.getCurrentTime();
      this.pushEvent("video:pause", { position });
      this.reconcile.stop();
    } else if (state === YT_ENDED) {
      const currentIndex = this.el.dataset.currentIndex;
      if (currentIndex != null) {
        this.pushEvent("video:ended", { index: parseInt(currentIndex) });
      }
    }
  },

  _onSyncPlay(data) {
    this.expectedPlayState = "playing";
    if (data.user_id === this.userId) return;
    this.suppression.suppress("playing");
    this._seekTo(data.time);
    this._play();
    this.reconcile.setServerState(
      data.time,
      data.server_time,
      this.clockSync
    );
    this.reconcile.start();
  },

  _onSyncPause(data) {
    this.expectedPlayState = "paused";
    if (data.user_id === this.userId) return;
    this.suppression.suppress("paused");
    // Don't seekTo here — it causes YouTube to fire double PAUSED events,
    // one of which leaks past suppression and echoes back as a stale pause.
    // Position will be corrected on next play via reconcile.
    this._pause();
    this.reconcile.stop();
  },

  _onSyncSeek(data) {
    if (data.user_id === this.userId) return;
    this.suppression.suppress(null); // suppress next state change regardless
    this._seekTo(data.time);
    this.reconcile.setServerState(
      data.time,
      data.server_time,
      this.clockSync
    );
  },

  _onSyncCorrection(data) {
    this.reconcile.setServerState(
      data.expected_time,
      data.server_time,
      this.clockSync
    );
  },

  _onVideoChange(data) {
    const item = data.media_item;
    this.el.dataset.currentIndex = data.index;
    this.reconcile.stop();
    // Close any open external player window
    if (window._byobPlayerWindow && !window._byobPlayerWindow.closed) {
      try { window._byobPlayerWindow.close(); } catch (_) {}
      window._byobPlayerWindow = null;
    }
    // Clear extension storage config
    window.postMessage({ type: "byob:clear-external" }, "*");
    // Clear old sponsor data — new segments will arrive via sponsor:segments event
    this._lastSponsorData = null;
    this.sponsorSegments = [];
    this._sponsorBarSegments = null;
    this._sponsorBarDuration = 0;
    this._loadVideo(item.source_type, item.source_id, item.url, item);
    this._pendingState = {
      play_state: "playing",
      current_time: 0,
      server_time: this.clockSync.serverNow(),
    };
  },

  _onExtPlayerState(data) {
    const status = document.getElementById("ext-status");
    const container = document.getElementById("ext-progress-container");
    const fill = document.getElementById("ext-progress-fill");
    const timeCur = document.getElementById("ext-time-current");
    const timeDur = document.getElementById("ext-time-duration");
    if (!status) return;

    const fmt = (s) => Math.floor(s / 60) + ":" + Math.floor(s % 60).toString().padStart(2, "0");

    if (data.hooked) {
      status.textContent = data.playing ? "Playing in external window" : "Paused in external window";
      if (container) container.style.display = "block";
      if (fill && data.duration > 0) fill.style.width = ((data.position / data.duration) * 100) + "%";
      if (timeCur) timeCur.textContent = fmt(data.position);
      if (timeDur) timeDur.textContent = fmt(data.duration);
    } else {
      status.textContent = "Waiting for external player...";
      if (container) container.style.display = "none";
    }
  },

  _sendSegmentsToEmbed() {
    if (!this._sponsorBarSegments || !this._sponsorBarDuration) return;
    const iframe = this.el.querySelector("iframe");
    if (iframe) {
      iframe.contentWindow.postMessage({
        type: "byob:sponsor-segments",
        segments: this._sponsorBarSegments,
        duration: this._sponsorBarDuration,
      }, "*");
    }
  },

  _retrySponsorBar(attempt = 0) {
    if (!this._lastSponsorData || attempt > 4) return;
    const dur = this.player?.getDuration?.() || 0;
    if (dur > 0) {
      this._applySponsorSettings();
    } else {
      setTimeout(() => this._retrySponsorBar(attempt + 1), 250);
    }
  },

  _onSponsorSegments(data) {
    this._lastSponsorData = data;
    this._applySponsorSettings();
  },

  _applySponsorSettings() {
    const data = this._lastSponsorData;
    if (!data) return;
    const allSegments = data.segments || [];

    const getSetting = (cat) => {
      if (this.sbSettings && this.sbSettings[cat]) return this.sbSettings[cat];
      // Defaults matching server defaults
      const defaults = {
        sponsor: "auto_skip", selfpromo: "show_bar", interaction: "show_bar",
        intro: "show_bar", outro: "show_bar", preview: "show_bar",
        music_offtopic: "disabled", filler: "show_bar",
      };
      return defaults[cat] || "disabled";
    };

    this.sponsorSegments = allSegments.filter((s) => getSetting(s.category) === "auto_skip");
    const barSegments = allSegments.filter((s) => getSetting(s.category) !== "disabled");

    // Try multiple sources for duration
    const playerDur = this.player?.getDuration?.() || 0;
    const apiDur = data.duration || 0;
    // Fallback: max segment end time
    const segDur = allSegments.reduce((max, s) => Math.max(max, s.segment?.[1] || 0), 0);
    const duration = playerDur > 0 ? playerDur : apiDur > 0 ? apiDur : segDur;

    this._sponsorBarSegments = barSegments;
    this._sponsorBarDuration = duration;

    // Send segments to YouTube embed iframe for in-player rendering (requires extension)
    if (barSegments.length > 0) {
      this._sendSegmentsToEmbed();
    }

    // Retry sending if duration wasn't ready
    if (duration <= 0 && this.player) {
      const retry = () => {
        const d = this.player?.getDuration?.() || 0;
        if (d > 0) {
          this._sponsorBarDuration = d;
          this._sendSegmentsToEmbed();
        }
      };
      setTimeout(retry, 1000);
      setTimeout(retry, 3000);
    }
  },

  // Detect seeks while paused (YouTube doesn't fire onStateChange for these)
  _startSeekDetector() {
    if (this.seekDetectorInterval) clearInterval(this.seekDetectorInterval);
    this.seekDetectorInterval = setInterval(() => {
      if (!this.player || !this.player.getCurrentTime) return;
      const pos = this.player.getCurrentTime();
      const state = this.player.getPlayerState?.();
      // Only detect seeks while paused
      if (state === YT_PAUSED && Math.abs(pos - this.lastKnownPosition) > 1) {
        if (!this.suppression.isActive()) {
          this.pushEvent("video:seek", { position: pos });
          // Update reconcile immediately so it doesn't fight the seek
          const serverTime = this.clockSync.serverNow();
          this.reconcile.setServerState(pos, serverTime, this.clockSync);
          this.reconcile.pauseFor(1000);
        }
      }
      this.lastKnownPosition = pos;
    }, 500);

    // State sync heartbeat — catches fast pause/unpause desync
    // Tracks how long state has been wrong. After 500ms of mismatch, force correction.
    this._mismatchSince = null;
    if (this.stateCheckInterval) clearInterval(this.stateCheckInterval);
    this.stateCheckInterval = setInterval(() => {
      if (!this.player || !this.player.getPlayerState || !this.expectedPlayState) return;
      const ytState = this.player.getPlayerState();
      const localState = ytState === YT_PLAYING ? "playing" : ytState === YT_PAUSED ? "paused" : null;
      if (!localState) return;
      if (localState !== this.expectedPlayState) {
        if (!this._mismatchSince) {
          this._mismatchSince = performance.now();
        } else if (performance.now() - this._mismatchSince > 500) {
          // Mismatch persisted — force correction regardless of suppression
          this._mismatchSince = null;
          this.suppression.suppress(this.expectedPlayState);
          if (this.expectedPlayState === "playing") {
            this._play();
          } else {
            this._pause();
          }
        }
      } else {
        this._mismatchSince = null;
      }
    }, 100);

    // SponsorBlock skip check
    this._lastSkippedUUID = null;
    if (this.sponsorCheckInterval) clearInterval(this.sponsorCheckInterval);
    this.sponsorCheckInterval = setInterval(() => {
      if (!this.player || !this.player.getCurrentTime || this.sponsorSegments.length === 0) return;
      const pos = this.player.getCurrentTime();
      for (const seg of this.sponsorSegments) {
        if (pos >= seg.segment[0] && pos < seg.segment[1] - 0.5) {
          if (this._lastSkippedUUID !== seg.uuid) {
            this._lastSkippedUUID = seg.uuid;
            this._seekTo(seg.segment[1]);
            this._showSkipToast(seg.category);
          }
          break;
        }
      }
    }, 250);
  },

  _showSkipToast(category) {
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
    const label = labels[category] || category;
    const color = colors[category] || "#00d400";

    // Remove existing toast
    document.querySelector(".sb-skip-toast")?.remove();

    const toast = document.createElement("div");
    toast.className = "sb-skip-toast";
    toast.style.cssText = `
      position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
      padding:8px 16px;border-radius:8px;
      background:rgba(0,0,0,0.85);color:white;
      font-size:13px;z-index:9999;
      display:flex;align-items:center;gap:8px;
      animation:sb-toast-in 0.2s ease-out;
    `;
    toast.innerHTML = `
      <span style="width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0;"></span>
      Skipped ${label}
    `;

    // Add animation keyframes if not present
    if (!document.getElementById("sb-toast-style")) {
      const style = document.createElement("style");
      style.id = "sb-toast-style";
      style.textContent = `
        @keyframes sb-toast-in { from { opacity:0; transform:translateX(-50%) translateY(10px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
        @keyframes sb-toast-out { from { opacity:1; } to { opacity:0; } }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = "sb-toast-out 0.3s ease-in forwards";
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  },

  // Player abstraction
  _getCurrentTime() {
    if (this.sourceType === "youtube" && this.player && this.player.getCurrentTime) {
      return this.player.getCurrentTime();
    }
    return 0;
  },

  _seekTo(seconds) {
    if (this.sourceType === "youtube" && this.player && this.player.seekTo) {
      this.player.seekTo(seconds, true);
    }
  },

  _play() {
    if (this.sourceType === "youtube" && this.player && this.player.playVideo) {
      this.player.playVideo();
    }
  },

  _pause() {
    if (this.sourceType === "youtube" && this.player && this.player.pauseVideo) {
      this.player.pauseVideo();
    }
  },

  _setPlaybackRate(rate) {
    if (this.sourceType === "youtube" && this.player && this.player.setPlaybackRate) {
      this.player.setPlaybackRate(rate);
    }
  },
};

export default VideoPlayer;
