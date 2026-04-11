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

    // Listen for server events
    this.handleEvent("sync:state", (state) => this._onSyncState(state));
    this.handleEvent("sync:play", (data) => this._onSyncPlay(data));
    this.handleEvent("sync:pause", (data) => this._onSyncPause(data));
    this.handleEvent("sync:seek", (data) => this._onSyncSeek(data));
    this.handleEvent("sync:pong", (data) => this.clockSync.handlePong(data));
    this.handleEvent("sync:correction", (data) => this._onSyncCorrection(data));
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
      const position = this.player.getCurrentTime();
      this.pushEvent("video:play", { position });
      // Update own reconcile so it doesn't drift-correct back to old position
      const serverTime = this.clockSync.serverNow();
      this.reconcile.setServerState(position, serverTime, this.clockSync);
      this.reconcile.start();
    } else if (state === YT_PAUSED) {
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
    if (data.user_id === this.userId) return;
    this.suppression.suppress("paused");
    this._seekTo(data.time);
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
