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

    // Listen for server events
    this.handleEvent("sync:state", (state) => this._onSyncState(state));
    this.handleEvent("sync:play", (data) => this._onSyncPlay(data));
    this.handleEvent("sync:pause", (data) => this._onSyncPause(data));
    this.handleEvent("sync:seek", (data) => this._onSyncSeek(data));
    this.handleEvent("sync:pong", (data) => this.clockSync.handlePong(data));
    this.handleEvent("sync:correction", (data) => this._onSyncCorrection(data));
    this.handleEvent("sponsor:segments", (data) => this._onSponsorSegments(data));
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
    if (this._sponsorBarInterval) clearInterval(this._sponsorBarInterval);
    this.el.parentElement
      ?.querySelectorAll(".sponsor-bar")
      .forEach((el) => el.remove());
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
      // Seek then briefly play+pause to force YouTube to render a frame
      // (YouTube shows black at paused positions until a frame is decoded)
      this._seekTo(state.current_time);
      this._play();
      setTimeout(() => {
        this.suppression.suppress("paused");
        this._pause();
      }, 200);
    }
  },

  async _loadVideo(sourceType, sourceId, url) {
    this.sourceType = sourceType;
    this.sourceId = sourceId;

    if (sourceType === "youtube") {
      await this._loadYouTube(sourceId);
    }
    // Extension mode handled in Phase 3
  },

  async _loadYouTube(videoId) {
    const YT = await loadYouTubeAPI();

    // Clear existing player
    if (this.player && this.player.destroy) {
      this.player.destroy();
    }

    this.isReady = false;

    // Create container div inside the hook element
    let container = this.el.querySelector("#yt-player");
    if (!container) {
      container = document.createElement("div");
      container.id = "yt-player";
      this.el.innerHTML = "";
      this.el.appendChild(container);
    }

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
    this._loadVideo(item.source_type, item.source_id, item.url);
    this._pendingState = {
      play_state: "playing",
      current_time: 0,
      server_time: this.clockSync.serverNow(),
    };
  },

  _retrySponsorBar(attempt = 0) {
    if (!this._lastSponsorData || attempt > 10) return;
    const dur = this.player?.getDuration?.() || 0;
    if (dur > 0) {
      this._applySponsorSettings();
    } else {
      setTimeout(() => this._retrySponsorBar(attempt + 1), 500);
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
    this._renderSponsorBar(barSegments, duration);

    // If duration was 0, retry once player is ready
    if (duration <= 0 && this.player) {
      const retryRender = () => {
        const d = this.player?.getDuration?.() || 0;
        if (d > 0) this._renderSponsorBar(this._sponsorBarSegments || [], d);
      };
      setTimeout(retryRender, 1000);
      setTimeout(retryRender, 3000);
    }
  },

  _renderSponsorBar(segments, duration) {
    // Remove existing bar
    this.el.parentElement
      ?.querySelectorAll(".sponsor-bar")
      .forEach((el) => el.remove());
    if (!duration) return;

    this._sponsorBarDuration = duration;

    const bar = document.createElement("div");
    bar.className = "sponsor-bar";
    bar.style.cssText =
      "position:relative;height:3px;border-radius:2px;background:rgba(255,255,255,0.12);margin:2px auto 8px auto;width:92.9%;overflow:visible;cursor:pointer;";

    // Segment blocks
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

    if (segments && segments.length > 0) {
      for (const seg of segments) {
        const left = (seg.segment[0] / duration) * 100;
        const width = Math.max(0.3, ((seg.segment[1] - seg.segment[0]) / duration) * 100);
        const block = document.createElement("div");
        block.style.cssText = `position:absolute;left:${left}%;width:${width}%;height:100%;background:${colors[seg.category] || "#00d400"};opacity:0.7;border-radius:2px;`;
        const labels = {
          sponsor: "Sponsor", selfpromo: "Self Promotion", interaction: "Interaction",
          intro: "Intro", outro: "Outro", preview: "Preview",
          music_offtopic: "Non-Music", filler: "Filler",
        };
        block.title = labels[seg.category] || seg.category;
        bar.appendChild(block);
      }
    }

    // Playhead — thin red line, same height as bar
    const playhead = document.createElement("div");
    playhead.className = "sponsor-bar-playhead";
    playhead.style.cssText =
      "position:absolute;top:0;width:2px;height:100%;background:#e33;z-index:3;left:0%;transition:left 0.1s linear;";
    bar.appendChild(playhead);

    // Progress fill — red tinted
    const fill = document.createElement("div");
    fill.className = "sponsor-bar-fill";
    fill.style.cssText =
      "position:absolute;left:0;top:0;height:100%;background:rgba(230,50,50,0.25);border-radius:2px 0 0 2px;z-index:1;width:0%;transition:width 0.1s linear;";
    bar.appendChild(fill);

    // Click to seek
    bar.style.pointerEvents = "auto";
    bar.addEventListener("click", (e) => {
      const rect = bar.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const seekTime = pct * duration;
      this._seekTo(seekTime);
      this.pushEvent("video:seek", { position: seekTime });
      const serverTime = this.clockSync.serverNow();
      this.reconcile.setServerState(seekTime, serverTime, this.clockSync);
      this.reconcile.pauseFor(1000);
    });

    this.el.insertAdjacentElement("afterend", bar);

    // Start updating playhead
    if (this._sponsorBarInterval) clearInterval(this._sponsorBarInterval);
    this._sponsorBarInterval = setInterval(() => {
      if (!this.player || !this.player.getCurrentTime) return;
      const pos = this.player.getCurrentTime();
      const pct = (pos / duration) * 100;
      const ph = bar.querySelector(".sponsor-bar-playhead");
      const fl = bar.querySelector(".sponsor-bar-fill");
      if (ph) ph.style.left = pct + "%";
      if (fl) fl.style.width = pct + "%";
    }, 100);
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
