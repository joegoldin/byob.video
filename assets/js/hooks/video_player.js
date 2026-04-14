import { ClockSync } from "../sync/clock_sync";
import { Suppression } from "../sync/suppression";
import { Reconcile } from "../sync/reconcile";
import * as YouTubePlayer from "../players/youtube";
import * as DirectPlayer from "../players/direct";
import * as ExtensionPlayer from "../players/extension";
import * as SponsorBlock from "../sponsor_block";
import { showToast, showSkipToast } from "../ui/toasts";
import { showQueueFinished } from "../ui/queue_finished";

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
      this._applySponsorSettingsFull();
    });
    this.handleEvent("video:change", (data) => this._onVideoChange(data));
    this.handleEvent("queue:ended", () => this._onQueueEnded());
    this.handleEvent("media:metadata", (data) => {
      if (data.title) this._lastTitle = data.title;
      if (data.thumbnail_url) this._lastThumb = data.thumbnail_url;
    });
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
          if (this._embedBlocked) return; // Don't retry if embed was blocked
          let isPlaying = false;
          if (this.sourceType === "youtube") {
            isPlaying = this.player?.getState?.() === "playing" ||
                        this.player?.getState?.() === "buffering";
          } else if (this.sourceType === "direct_url") {
            isPlaying = this.player?.getState?.() === "playing";
          }

          if (!isPlaying) {
            if (attempt < 3) {
              this.suppression.suppress("playing");
              this._play();
              checkAndRetry(attempt + 1);
            } else if (!this._embedBlocked) {
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
    this._lastThumb = mediaItem?.thumbnail_url ||
      (sourceType === "youtube" && sourceId ? `https://img.youtube.com/vi/${sourceId}/hqdefault.jpg` : null);
    this._embedBlocked = false;
    if (this._extPollInterval) { clearInterval(this._extPollInterval); this._extPollInterval = null; }

    const shouldPlay = this._pendingState?.play_state === "playing";

    if (sourceType === "youtube") {
      await this._loadYouTube(sourceId, shouldPlay);
    } else if (sourceType === "direct_url") {
      this._loadDirectUrl(url);
    } else {
      this._loadExtension(mediaItem, url);
    }
  },

  async _loadYouTube(videoId, shouldPlay) {
    // Can we reuse the existing YouTube player?
    const canReuse = this.player && this.player.loadVideoById && this.sourceType === "youtube";

    const callbacks = {
      onReady: () => {
        this.isReady = true;
        this._applyPendingState();
        this._startSeekDetector();
        this._retrySponsorBar();
      },
      onLoadStart: () => {
        this.isReady = false;
        this._endedFired = false;
      },
      onStateChange: (stateName) => {
        this._onPlayerStateChange(stateName);
      },
      onBuffering: () => {
        this.reconcile.pauseFor(2000);
      },
      onError: (event) => {
        this._onYTError(event);
      },
    };

    if (canReuse) {
      // Reuse path: the raw YT player is inside our wrapper
      const rawPlayer = this.player.raw;
      this.player = await YouTubePlayer.create(this.el, callbacks, {
        videoId,
        shouldPlay,
        reuse: rawPlayer,
      });
    } else {
      // Fresh creation: destroy old player first
      if (this.player && this.player.destroy) {
        this.player.destroy();
      }
      this.isReady = false;

      this.player = await YouTubePlayer.create(this.el, callbacks, {
        videoId,
        shouldPlay,
        reuse: null,
      });
    }
  },

  _loadDirectUrl(url) {
    // Clear existing player
    if (this.player && this.player.destroy) {
      try { this.player.destroy(); } catch (_) {}
    }
    this.player = null;
    this.isReady = false;

    const callbacks = {
      onReady: () => {
        this.isReady = true;
        this._applyPendingState();
        this._startSeekDetector();
      },
      onStateChange: (stateName) => {
        if (stateName === "playing") {
          if (this.suppression.shouldSuppress("playing")) return;
          this.expectedPlayState = "playing";
          const position = this.player.getCurrentTime();
          this.pushEvent("video:play", { position });
          const serverTime = this.clockSync.serverNow();
          this.reconcile.setServerState(position, serverTime, this.clockSync);
          this.reconcile.pauseFor(1000);
          this.reconcile.start();
        } else if (stateName === "paused") {
          if (this.suppression.shouldSuppress("paused")) return;
          this.expectedPlayState = "paused";
          const position = this.player.getCurrentTime();
          this.pushEvent("video:pause", { position });
          this.reconcile.stop();
        } else if (stateName === "ended") {
          this.expectedPlayState = null;
          this.reconcile.stop();
          const currentIndex = this.el.dataset.currentIndex;
          if (currentIndex != null) {
            this.pushEvent("video:ended", { index: parseInt(currentIndex) });
          }
        }
      },
      onSeeked: (currentTime) => {
        if (this.suppression.isActive()) return;
        this.pushEvent("video:seek", { position: currentTime });
        const serverTime = this.clockSync.serverNow();
        this.reconcile.setServerState(currentTime, serverTime, this.clockSync);
        this.reconcile.pauseFor(1000);
      },
    };

    this.player = DirectPlayer.create(this.el, callbacks, { url });
  },

  _loadExtension(mediaItem, url) {
    // Destroy existing player
    if (this.player && this.player.destroy) {
      try { this.player.destroy(); } catch (_) {}
      this.player = null;
    }

    const title = mediaItem?.title || url;
    const thumb = mediaItem?.thumbnail_url;

    const callbacks = {
      onReady: () => {
        this.isReady = true;
        this._applyPendingState();
      },
    };

    this.player = ExtensionPlayer.create(this.el, callbacks, {
      title,
      thumbnailUrl: thumb,
    });
  },

  // Unified YouTube state change handler (called from YouTube player module)
  _onPlayerStateChange(stateName) {
    if (stateName && this.suppression.shouldSuppress(stateName)) {
      return;
    }

    if (stateName === "playing") {
      this.expectedPlayState = "playing";
      const position = this.player.getCurrentTime();
      this.pushEvent("video:play", { position });
      // Update own reconcile so it doesn't drift-correct back to old position
      const serverTime = this.clockSync.serverNow();
      this.reconcile.setServerState(position, serverTime, this.clockSync);
      this.reconcile.pauseFor(1000); // let server catch up before correcting
      this.reconcile.start();
    } else if (stateName === "paused") {
      this.expectedPlayState = "paused";
      const position = this.player.getCurrentTime();
      this.pushEvent("video:pause", { position });
      this.reconcile.stop();
    } else if (stateName === "ended") {
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
      this._embedBlocked = true;
      const videoId = this.sourceId;
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const title = this._lastTitle || url;
      const thumb = this._lastThumb;

      // Destroy the broken player
      if (this.player && this.player.destroy) {
        try { this.player.destroy(); } catch (_) {}
      }
      this.player = null;

      // Detect extension from page attribute (set by extension content script)
      const hasExtension = document.documentElement.hasAttribute("data-byob-extension");

      // Build fallback UI
      const container = document.createElement("div");
      container.className = "absolute inset-0 flex flex-col items-center justify-center gap-3 text-base-content/60 bg-base-300";

      if (thumb) {
        const img = document.createElement("img");
        img.src = thumb;
        img.className = "w-32 h-20 object-cover rounded opacity-80";
        container.appendChild(img);
      }

      const warning = document.createElement("div");
      warning.className = "flex items-center gap-2 text-warning";
      warning.innerHTML = `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z"/><path stroke-linecap="round" stroke-linejoin="round" d="M12 15.75h.007v.008H12v-.008z"/></svg>`;
      const warningText = document.createElement("span");
      warningText.className = "text-sm font-medium";
      warningText.textContent = "This video can't be embedded";
      warning.appendChild(warningText);
      container.appendChild(warning);

      const titleEl = document.createElement("p");
      titleEl.className = "text-xs text-base-content/40 max-w-sm text-center px-4 line-clamp-2";
      titleEl.textContent = title;
      container.appendChild(titleEl);

      const subtext = document.createElement("p");
      subtext.className = "text-xs text-base-content/30";
      subtext.textContent = "Age-restricted or embedding disabled by uploader";
      container.appendChild(subtext);

      const btnContainer = document.createElement("div");
      btnContainer.className = "flex gap-2 mt-1";

      if (hasExtension) {
        // Has extension — show "Watch on YouTube" (extension will sync)
        const ytBtn = document.createElement("a");
        ytBtn.href = url;
        ytBtn.target = "_blank";
        ytBtn.className = "btn btn-sm btn-primary gap-1";
        ytBtn.innerHTML = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg> Watch on YouTube`;
        btnContainer.appendChild(ytBtn);

        const hint = document.createElement("p");
        hint.className = "text-[10px] text-base-content/20 mt-1";
        hint.textContent = "Extension will sync playback automatically";
        container.appendChild(btnContainer);
        container.appendChild(hint);
      } else {
        // No extension — show "Get Extension" with link
        const extBtn = document.createElement("a");
        extBtn.className = "btn btn-sm btn-primary gap-1";
        extBtn.style.cursor = "pointer";
        // Detect browser for correct store link
        const isFirefox = /Firefox/.test(navigator.userAgent);
        extBtn.href = isFirefox
          ? "https://addons.mozilla.org/en-US/firefox/addon/byob-bring-your-own-binge/"
          : "https://chromewebstore.google.com/detail/jlpogmjckejgpbbfhafgjgkbnocjfbmb";
        extBtn.target = "_blank";
        extBtn.innerHTML = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/></svg> Get Extension`;
        btnContainer.appendChild(extBtn);

        const hint = document.createElement("p");
        hint.className = "text-[10px] text-base-content/20 mt-1";
        hint.textContent = "Install the byob extension to watch age-restricted videos in sync";
        container.appendChild(btnContainer);
        container.appendChild(hint);
      }

      this.el.innerHTML = "";
      this.el.appendChild(container);

      // Poll for extension install — update UI when detected
      if (!hasExtension) {
        this._extPollInterval = setInterval(() => {
          if (document.documentElement.hasAttribute("data-byob-extension")) {
            clearInterval(this._extPollInterval);
            this._extPollInterval = null;
            // Re-render with extension UI
            this._onYTError({ data: code });
          }
        }, 2000);
      }

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

    showQueueFinished(
      this.el,
      this._lastTitle || "the queue",
      this._lastThumb
    );
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
    SponsorBlock.sendSegmentsToEmbed(
      this.el,
      this._sponsorBarSegments,
      this._sponsorBarDuration
    );
  },

  _retrySponsorBar(attempt = 0) {
    SponsorBlock.retrySponsorBar(this, attempt);
  },

  _onSponsorSegments(data) {
    this._lastSponsorData = data;
    this._applySponsorSettingsFull();
  },

  _applySponsorSettingsFull() {
    const data = this._lastSponsorData;
    if (!data) return;

    const { sponsorSegments, barSegments, duration } =
      SponsorBlock.applySponsorSettings(
        data,
        this.sbSettings,
        () => this.player?.getDuration?.() || 0
      );

    this.sponsorSegments = sponsorSegments;
    this._sponsorBarSegments = barSegments;
    this._sponsorBarDuration = duration;

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
      const playerState = this.player.getState?.();
      const isPaused = playerState === "paused";
      // Detect seeks: large position jumps (>3s while playing, >1s while paused)
      const jumpThreshold = isPaused ? 1 : 3;
      if (Math.abs(pos - this.lastKnownPosition) > jumpThreshold) {
        if (!this.suppression.isActive()) {
          this.pushEvent("video:seek", { position: pos });
          const serverTime = this.clockSync.serverNow();
          this.reconcile.setServerState(pos, serverTime, this.clockSync);
          this.reconcile.pauseFor(1000);
        }
      }
      this.lastKnownPosition = pos;

      // Detect video ended — YouTube embeds may not fire YT_ENDED reliably
      const dur = this.player?.getDuration?.() || 0;
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
      const localState = this.player.getState?.();
      if (!localState || localState === "buffering" || localState === "ended") return;
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
      if (!this.player || this.sponsorSegments.length === 0) return;
      const pos = this._getCurrentTime();
      this._lastSkippedUUID = SponsorBlock.checkSponsorSkip(
        pos,
        this.sponsorSegments,
        this._lastSkippedUUID,
        (t) => this._seekTo(t),
        (cat) => this._showSkipToast(cat)
      );
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
    showToast(text);
  },

  _showSkipToast(category) {
    showSkipToast(category);
  },

  // Player abstraction — delegate to unified player interface
  _getCurrentTime() {
    return this.player?.getCurrentTime?.() || 0;
  },

  _seekTo(seconds) {
    this.player?.seek?.(seconds);
  },

  _play() {
    this.player?.play?.();
  },

  _pause() {
    this.player?.pause?.();
  },

  _setPlaybackRate(rate) {
    this.player?.setPlaybackRate?.(rate);
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
