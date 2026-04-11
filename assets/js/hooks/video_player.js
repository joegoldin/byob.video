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
      // Re-render bar with updated settings
      if (this._lastSponsorData) {
        this._onSponsorSegments(this._lastSponsorData);
      }
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
      this.suppression.suppress("playing");
      this._seekTo(position);
      this._play();
      this.reconcile.setServerState(
        state.current_time,
        state.server_time,
        this.clockSync
      );
      this.reconcile.start();
    } else if (state.play_state === "paused") {
      this.suppression.suppress("paused");
      this._seekTo(state.current_time);
      this._pause();
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

    this.player = new YT.Player("yt-player", {
      videoId: videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: 0,
        controls: 1,
        modestbranding: 1,
        rel: 0,
      },
      events: {
        onReady: () => {
          this.isReady = true;
          this._applyPendingState();
          this._startSeekDetector();
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

  _onSponsorSegments(data) {
    this._lastSponsorData = data;
    const allSegments = data.segments || [];
    // Filter segments based on room SB settings
    this.sponsorSegments = allSegments.filter(
      (s) => this.sbSettings[s.category] === "auto_skip"
    );
    const barSegments = allSegments.filter(
      (s) => this.sbSettings[s.category] && this.sbSettings[s.category] !== "disabled"
    );
    const duration =
      (this.player && this.player.getDuration && this.player.getDuration()) ||
      data.duration ||
      0;
    this._renderSponsorBar(barSegments, duration);
  },

  _renderSponsorBar(segments, duration) {
    // Remove existing bar
    const existing = this.el.querySelector(".sponsor-bar");
    if (existing) existing.remove();
    if (!segments || segments.length === 0 || !duration) return;

    // Overlay bar positioned at the bottom of the player, above YouTube's controls
    const bar = document.createElement("div");
    bar.className = "sponsor-bar";
    bar.style.cssText = [
      "position:absolute",
      "bottom:0",
      "left:0",
      "right:0",
      "height:4px",
      "z-index:30",
      "pointer-events:none",
      "background:rgba(255,255,255,0.1)",
    ].join(";");

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

    for (const seg of segments) {
      const left = (seg.segment[0] / duration) * 100;
      const width = Math.max(0.3, ((seg.segment[1] - seg.segment[0]) / duration) * 100);
      const block = document.createElement("div");
      block.style.cssText = `position:absolute;left:${left}%;width:${width}%;height:100%;background:${colors[seg.category] || "#00d400"};opacity:0.85;border-radius:1px;`;
      block.title = seg.category;
      bar.appendChild(block);
    }

    this.el.style.position = "relative";
    // Force iframe below the bar in stacking order
    const iframe = this.el.querySelector("iframe");
    if (iframe) {
      iframe.style.position = "relative";
      iframe.style.zIndex = "1";
    }
    this.el.appendChild(bar);
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
    if (this.sponsorCheckInterval) clearInterval(this.sponsorCheckInterval);
    this.sponsorCheckInterval = setInterval(() => {
      if (!this.player || !this.player.getCurrentTime || this.sponsorSegments.length === 0) return;
      const pos = this.player.getCurrentTime();
      for (const seg of this.sponsorSegments) {
        if (pos >= seg.segment[0] && pos < seg.segment[1] - 0.5) {
          this._seekTo(seg.segment[1]);
          break;
        }
      }
    }, 250);
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
