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

    // Close external player window on page unload/refresh
    this._unloadHandler = () => {
      if (window._byobPlayerWindow && !window._byobPlayerWindow.closed) {
        try { window._byobPlayerWindow.close(); } catch (_) {}
      }
    };
    window.addEventListener("beforeunload", this._unloadHandler);

    // Listen for server events
    this.handleEvent("sync:state", (state) => this._onSyncState(state));
    this.handleEvent("sync:play", (data) => this._onSyncPlay(data));
    this.handleEvent("sync:pause", (data) => this._onSyncPause(data));
    this.handleEvent("sync:seek", (data) => this._onSyncSeek(data));
    this.handleEvent("sync:pong", (data) => this.clockSync.handlePong(data));
    this.handleEvent("sync:correction", (data) => this._onSyncCorrection(data));
    this.handleEvent("sponsor:segments", (data) => this._onSponsorSegments(data));
    this.handleEvent("ext:player-state", (data) => this._onExtPlayerState(data));
    this.handleEvent("ext:media-info", (data) => this._onExtMediaInfo(data));
    this.handleEvent("sb:settings", (data) => {
      this.sbSettings = data;
      this._applySponsorSettings();
    });
    this.handleEvent("video:change", (data) => this._onVideoChange(data));
    this.handleEvent("queue:ended", () => this._onQueueEnded());
    this.handleEvent("toast", (data) => this._showToast(data.text));

    // Size the player to fit viewport: cap height so aspect-ratio shrinks width
    this._sizePlayer();
    this._resizeHandler = () => this._sizePlayer();
    window.addEventListener("resize", this._resizeHandler);
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
    if (this._unloadHandler) window.removeEventListener("beforeunload", this._unloadHandler);
    if (this._resizeHandler) window.removeEventListener("resize", this._resizeHandler);
    this._unloadHandler?.();
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
        this._loadVideo(item.source_type, item.source_id, item.url, item);

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

      // Retry play if autoplay was blocked, then show click-to-play overlay
      const checkAndRetry = (attempt) => {
        setTimeout(() => {
          let isPlaying = false;
          if (this.sourceType === "youtube") {
            const yt = this.player?.getPlayerState?.();
            isPlaying = yt === YT_PLAYING || yt === YT_BUFFERING;
          } else if (this.sourceType === "direct_url") {
            isPlaying = this.player && !this.player.paused;
          }

          if (!isPlaying) {
            if (attempt < 3) {
              this.suppression.suppress("playing");
              this._play();
              checkAndRetry(attempt + 1);
            } else {
              // Autoplay blocked — show click-to-play overlay
              this._showClickToPlay(position);
            }
          }
        }, attempt * 500);
      };
      checkAndRetry(1);
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
    this._lastTitle = mediaItem?.title || url;
    this._lastThumb = mediaItem?.thumbnail_url;

    if (sourceType === "youtube") {
      await this._loadYouTube(sourceId);
    } else if (sourceType === "direct_url") {
      this._loadDirectUrl(url);
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
    const shouldPlay = this._pendingState?.play_state === "playing";

    // Reuse existing player if possible — preserves user gesture context for autoplay
    if (this.player && this.player.loadVideoById && this.sourceType === "youtube") {
      this.isReady = false;
      this._endedFired = false;
      if (shouldPlay) {
        this.player.loadVideoById(videoId);
      } else {
        this.player.cueVideoById(videoId);
      }
      this.isReady = true;
      this._applyPendingState();
      this._startSeekDetector();
      this._retrySponsorBar();
      return;
    }

    // First time — create player from scratch
    if (this.player && this.player.destroy) {
      this.player.destroy();
    }

    this.isReady = false;

    this.el.innerHTML = "";
    const container = document.createElement("div");
    container.id = "yt-player";
    this.el.appendChild(container);

    this.player = new YT.Player("yt-player", {
      videoId: videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: shouldPlay ? 1 : 0,
        controls: 1,
        modestbranding: 1,
        rel: 0,
      },
      events: {
        onReady: () => {
          this.isReady = true;
          const iframe = this.el.querySelector("iframe");
          if (iframe) {
            iframe.style.width = "100%";
            iframe.style.height = "100%";
            iframe.allow = "autoplay; encrypted-media; picture-in-picture";
          }
          this._applyPendingState();
          this._startSeekDetector();
          this._retrySponsorBar();
        },
        onStateChange: (event) => this._onYTStateChange(event),
        onError: (event) => this._onYTError(event),
      },
    });
  },

  _loadDirectUrl(url) {
    // Clear existing player
    if (this.player && this.player.destroy) {
      try { this.player.destroy(); } catch (_) {}
    }
    this.player = null;
    this.isReady = false;

    this.el.innerHTML = "";
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.backgroundColor = "#000";
    video.preload = "auto";
    video.crossOrigin = "anonymous";

    this.el.appendChild(video);
    this.player = video;

    video.addEventListener("loadedmetadata", () => {
      this.isReady = true;
      this._applyPendingState();
      this._startSeekDetector();
    });

    video.addEventListener("play", () => {
      if (this.suppression.shouldSuppress("playing")) return;
      this.expectedPlayState = "playing";
      const position = video.currentTime;
      this.pushEvent("video:play", { position });
      const serverTime = this.clockSync.serverNow();
      this.reconcile.setServerState(position, serverTime, this.clockSync);
      this.reconcile.pauseFor(1000);
      this.reconcile.start();
    });

    video.addEventListener("pause", () => {
      if (this.suppression.shouldSuppress("paused")) return;
      this.expectedPlayState = "paused";
      const position = video.currentTime;
      this.pushEvent("video:pause", { position });
      this.reconcile.stop();
    });

    video.addEventListener("seeked", () => {
      if (this.suppression.isActive()) return;
      this.pushEvent("video:seek", { position: video.currentTime });
      const serverTime = this.clockSync.serverNow();
      this.reconcile.setServerState(video.currentTime, serverTime, this.clockSync);
      this.reconcile.pauseFor(1000);
    });

    video.addEventListener("ended", () => {
      this.expectedPlayState = null;
      this.reconcile.stop();
      const currentIndex = this.el.dataset.currentIndex;
      if (currentIndex != null) {
        this.pushEvent("video:ended", { index: parseInt(currentIndex) });
      }
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
      // Stop heartbeat from force-replaying the video
      this.expectedPlayState = null;
      this.reconcile.stop();
      // Only send ended if the position-based detector hasn't already
      if (!this._endedFired) {
        this._endedFired = true;
        const currentIndex = this.el.dataset.currentIndex;
        if (currentIndex != null) {
          this.pushEvent("video:ended", { index: parseInt(currentIndex) });
        }
      }
    }
  },

  _onYTError(event) {
    const code = event.data;
    // 100 = video not found, 101/150 = embedding restricted (age-restricted, etc.)
    if (code === 100 || code === 101 || code === 150) {
      const videoId = this.sourceId;
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const title = this._lastTitle || url;
      const thumb = this._lastThumb;

      // Destroy the broken player
      if (this.player && this.player.destroy) {
        try { this.player.destroy(); } catch (_) {}
      }
      this.player = null;

      // Show fallback UI like extension-required
      const thumbHtml = thumb
        ? `<img src="${thumb}" class="w-32 h-20 object-cover rounded opacity-80" />`
        : "";

      this.el.innerHTML = `
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-base-content/60 bg-base-300">
          ${thumbHtml}
          <div class="flex items-center gap-2 text-warning">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z"/>
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 15.75h.007v.008H12v-.008z"/>
            </svg>
            <span class="text-sm font-medium">This video can't be embedded</span>
          </div>
          <p class="text-xs text-base-content/40 max-w-sm text-center px-4 line-clamp-2">${title}</p>
          <p class="text-xs text-base-content/30">Age-restricted or embedding disabled by uploader</p>
          <div class="flex gap-2 mt-1">
            <a href="${url}" target="_blank" class="btn btn-sm btn-primary gap-1">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
              Watch on YouTube
            </a>
          </div>
          <p class="text-[10px] text-base-content/20 mt-1">Use the byob extension to sync playback</p>
        </div>
      `;

      // Notify server this is now extension-required
      this.pushEvent("video:embed_blocked", { video_id: videoId, url: url });
    }
  },

  _onSyncPlay(data) {
    this.expectedPlayState = "playing";
    // Remove click-to-play overlay if present
    this.el.querySelector(".byob-click-to-play")?.remove();
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

  _onQueueEnded() {
    this.reconcile.stop();
    this.expectedPlayState = null;
    if (this.player && this.player.destroy) {
      try { this.player.destroy(); } catch (_) {}
    }
    this.player = null;
    this.sourceType = null;

    // Get last played item info from the current player element's last known state
    const lastTitle = this._lastTitle || "the queue";
    const lastThumb = this._lastThumb;

    // Build finished screen with DOM APIs (no innerHTML)
    const container = document.createElement("div");
    container.className = "absolute inset-0 flex flex-col items-center justify-center gap-4 bg-base-300";

    if (lastThumb) {
      const img = document.createElement("img");
      img.src = lastThumb;
      img.className = "w-48 h-28 object-cover rounded-lg opacity-50";
      container.appendChild(img);
    }

    const icon = document.createElement("div");
    icon.className = "w-12 h-12 rounded-full bg-success/20 flex items-center justify-center";
    icon.innerHTML = '<svg class="w-6 h-6 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
    container.appendChild(icon);

    const heading = document.createElement("p");
    heading.className = "text-base font-semibold text-base-content/60";
    heading.textContent = "Queue finished";
    container.appendChild(heading);

    const title = document.createElement("p");
    title.className = "text-sm text-base-content/40 max-w-md text-center px-6 line-clamp-2";
    title.textContent = `Last played: ${lastTitle}`;
    container.appendChild(title);

    const hint = document.createElement("p");
    hint.className = "text-xs text-base-content/25 mt-2";
    hint.textContent = "Paste a URL above to keep watching";
    container.appendChild(hint);

    this.el.innerHTML = "";
    this.el.appendChild(container);
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

  _onExtMediaInfo(data) {
    const placeholder = document.getElementById("ext-placeholder");
    if (!placeholder) return;

    // Update thumbnail
    const existingImg = placeholder.querySelector("img");
    const existingSvg = placeholder.querySelector("svg");
    if (data.thumbnail_url) {
      if (existingImg) {
        existingImg.src = data.thumbnail_url;
      } else {
        const img = document.createElement("img");
        img.src = data.thumbnail_url;
        img.className = "w-32 h-20 object-cover rounded opacity-80";
        if (existingSvg) existingSvg.replaceWith(img);
        else placeholder.prepend(img);
      }
    }

    // Update title
    const titleEl = placeholder.querySelector("p.font-medium");
    if (titleEl && data.title) {
      titleEl.textContent = data.title;
      titleEl.title = data.title;
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
      if (!this.player) return;
      const pos = this._getCurrentTime();
      const isPaused = this.sourceType === "youtube"
        ? this.player.getPlayerState?.() === YT_PAUSED
        : this.sourceType === "direct_url"
          ? this.player.paused
          : false;
      // Only detect seeks while paused
      if (isPaused && Math.abs(pos - this.lastKnownPosition) > 1) {
        if (!this.suppression.isActive()) {
          this.pushEvent("video:seek", { position: pos });
          const serverTime = this.clockSync.serverNow();
          this.reconcile.setServerState(pos, serverTime, this.clockSync);
          this.reconcile.pauseFor(1000);
        }
      }
      this.lastKnownPosition = pos;

      // Detect video ended — YouTube embeds may not fire YT_ENDED reliably
      const dur = this.sourceType === "youtube"
        ? (this.player.getDuration?.() || 0)
        : this.sourceType === "direct_url"
          ? (this.player.duration || 0)
          : 0;
      if (dur > 0 && pos >= dur - 1) {
        if (!this._endedFired) {
          this._endedFired = true;
          this.expectedPlayState = null;
          this.reconcile.stop();
          const currentIndex = this.el.dataset.currentIndex;
          if (currentIndex != null) {
            this.pushEvent("video:ended", { index: parseInt(currentIndex) });
          }
        }
      } else if (pos < dur - 2) {
        this._endedFired = false;
      }
    }, 500);

    // State sync heartbeat — catches fast pause/unpause desync
    // Tracks how long state has been wrong. After 500ms of mismatch, force correction.
    this._mismatchSince = null;
    if (this.stateCheckInterval) clearInterval(this.stateCheckInterval);
    this.stateCheckInterval = setInterval(() => {
      if (!this.player || !this.expectedPlayState) return;
      let localState = null;
      if (this.sourceType === "youtube" && this.player.getPlayerState) {
        const ytState = this.player.getPlayerState();
        localState = ytState === YT_PLAYING ? "playing" : ytState === YT_PAUSED ? "paused" : null;
      } else if (this.sourceType === "direct_url") {
        localState = this.player.paused ? "paused" : "playing";
      }
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

  _showClickToPlay(position) {
    // Remove any existing overlay
    this.el.querySelector(".byob-click-to-play")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "byob-click-to-play";
    overlay.style.cssText = "position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;cursor:pointer;background:rgba(0,0,0,0.4);";

    const btn = document.createElement("div");
    btn.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:8px;";
    btn.innerHTML = `
      <div style="width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,0.9);display:flex;align-items:center;justify-content:center;">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="#000"><polygon points="6,3 20,12 6,21"/></svg>
      </div>
      <span style="color:white;font-size:14px;font-weight:600;text-shadow:0 1px 3px rgba(0,0,0,0.5);">Click to join playback</span>
    `;
    overlay.appendChild(btn);

    overlay.addEventListener("click", () => {
      overlay.remove();
      this.suppression.suppress("playing");
      if (position != null) this._seekTo(position);
      this._play();
      this.reconcile.start();
    }, { once: true });

    this.el.appendChild(overlay);
  },

  _showToast(text) {
    if (!text) return;
    const existing = document.querySelector(".byob-action-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "byob-action-toast";
    toast.style.cssText = `
      position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
      padding:6px 16px;border-radius:8px;
      background:rgba(0,0,0,0.8);color:rgba(255,255,255,0.8);
      font-size:12px;z-index:9998;pointer-events:none;
      animation:sb-toast-in 0.2s ease-out;
      max-width:400px;text-align:center;
    `;
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = "sb-toast-out 0.3s ease-in forwards";
      setTimeout(() => toast.remove(), 300);
    }, 2500);
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
    if (this.sourceType === "youtube" && this.player?.getCurrentTime) {
      return this.player.getCurrentTime();
    }
    if (this.sourceType === "direct_url" && this.player) {
      return this.player.currentTime || 0;
    }
    return 0;
  },

  _seekTo(seconds) {
    if (this.sourceType === "youtube" && this.player?.seekTo) {
      this.player.seekTo(seconds, true);
    } else if (this.sourceType === "direct_url" && this.player) {
      this.player.currentTime = seconds;
    }
  },

  _play() {
    if (this.sourceType === "youtube" && this.player?.playVideo) {
      this.player.playVideo();
    } else if (this.sourceType === "direct_url" && this.player) {
      this.player.play().catch(() => {});
    }
  },

  _pause() {
    if (this.sourceType === "youtube" && this.player?.pauseVideo) {
      this.player.pauseVideo();
    } else if (this.sourceType === "direct_url" && this.player) {
      this.player.pause();
    }
  },

  _setPlaybackRate(rate) {
    if (this.sourceType === "youtube" && this.player?.setPlaybackRate) {
      this.player.setPlaybackRate(rate);
    } else if (this.sourceType === "direct_url" && this.player) {
      this.player.playbackRate = rate;
    }
  },

  _sizePlayer() {
    // Size player to fill width at 16:9, but cap by available height on desktop.
    // On mobile (stacked layout), just use 16:9 from width without height capping.
    const sizer = this.el.parentElement;
    const availW = sizer.clientWidth;
    const isDesktop = window.innerWidth >= 1024; // lg breakpoint
    let w = availW;
    let h = w * 9 / 16;
    if (isDesktop) {
      const availH = window.innerHeight - 80; // nav + padding
      if (h > availH && availH >= 300) {
        h = availH;
        w = h * 16 / 9;
      }
    }
    h = Math.max(150, h);
    if (!isDesktop) w = availW; // on mobile, always fill width
    this.el.style.width = w + "px";
    this.el.style.height = h + "px";
  },
};

export default VideoPlayer;
