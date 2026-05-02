import { ClockSync } from "../sync/clock_sync";
import { Suppression } from "../sync/suppression";
import { Reconcile } from "../sync/reconcile";
import * as YouTubePlayer from "../players/youtube";
import * as VimeoPlayer from "../players/vimeo";
import * as DirectPlayer from "../players/direct";
import * as ExtensionPlayer from "../players/extension";
import { handleYTError } from "../players/youtube_error";
import * as SponsorBlock from "../sponsor_block";
import { showToast, showSkipToast } from "../ui/toasts";
import { showQueueFinished } from "../ui/queue_finished";
import { LV_EVT } from "../sync/event_names";

// 2 Hz so SyncDecision can act on a fresh post-seek drift sample
// within ~500 ms instead of waiting a full second. Cost is one extra
// WebSocket message per second per peer — negligible.
const DRIFT_REPORT_INTERVAL_MS = 500;
const PAUSE_ON_LOAD_POLL_MS = 100;
const PAUSE_ON_LOAD_MAX_ATTEMPTS = 10;
const VIDEO_CHANGE_RETRY_1_MS = 1000;
const VIDEO_CHANGE_RETRY_2_MS = 3000;
const LIVE_DETECTION_INTERVAL_MS = 3000;

const VideoPlayer = {
  mounted() {
    this.player = null;
    this.clockSync = new ClockSync((event, payload) =>
      this.pushEvent(event, payload)
    );
    this.suppression = new Suppression();
    this._playerSettled = true;
    this.reconcile = new Reconcile({
      getCurrentTime: () => this._getCurrentTime(),
      // Reconcile-initiated seeks are *corrective* — they shouldn't echo
      // back to peers as new sync events, and on iOS the seek causes a
      // PAUSED → BUFFERING → PLAYING flicker that, unsuppressed, would
      // push :sync_pause to the room and pause everyone. Suppress before
      // the seek so the resulting state-change burst is swallowed.
      seekTo: (t) => {
        this.suppression.suppress("playing");
        this._seekTo(t);
      },
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
    // Throttle for the bottom-right "Re-syncing…" pill while paused —
    // shown once per pause session, then suppressed so cascading
    // sync seeks don't produce a flickering repeat. Reset on each
    // transition (in either direction) involving the paused state.
    this._pausedSyncPillShown = false;
    // Seek-latency measurement. _seekIssuedAt is set the moment a sync
    // seek command is dispatched to the player; _lastObservedL captures
    // the time-to-PLAYING delta and is reported in the next drift
    // report (server uses it as the overshoot for future seeks).
    this._seekIssuedAt = 0;
    this._lastObservedL = 0;
    this.sponsorSegments = [];
    this.sponsorCheckInterval = null;
    this.sbSettings = {};
    this._lastSponsorData = null;

    // Listen for YouTube embed iframe signaling it's ready for segments
    this._embedReadyHandler = (e) => {
      if (e.data?.type === LV_EVT.PW_EMBED_READY) {
        this._sendSegmentsToEmbed();
      }
    };
    window.addEventListener("message", this._embedReadyHandler);

    // Close external player window on page unload/refresh. Same COOP
    // caveat as _onVideoChange — don't gate on .closed.
    this._unloadHandler = () => {
      if (window._byobPlayerWindow) {
        try { window._byobPlayerWindow.close(); } catch (_) {}
      }
    };
    window.addEventListener("beforeunload", this._unloadHandler);

    // Listen for server events
    this.handleEvent(LV_EVT.SYNC_STATE, (state) => this._onSyncState(state));
    this.handleEvent(LV_EVT.SYNC_PLAY, (data) => this._onSyncPlay(data));
    this.handleEvent(LV_EVT.SYNC_PAUSE, (data) => this._onSyncPause(data));
    this.handleEvent(LV_EVT.SYNC_PONG, (data) => this.clockSync.handlePong(data));
    this.handleEvent(LV_EVT.SYNC_CORRECTION, (data) => this._onSyncCorrection(data));
    this.handleEvent(LV_EVT.SYNC_HEARTBEAT, (data) => this._onSyncHeartbeat(data));
    this.handleEvent(LV_EVT.SYNC_ROOM_TOLERANCE, (data) => {
      // Server-driven model: room consensus is informational only. The
      // server already used these values to make seek decisions and
      // included them in `sync:client_stats` for panel display. Kept as
      // a no-op shim in case Reconcile gains a use for it later.
      this.reconcile.setRoomTolerance?.({
        jitter: data?.room_jitter_ms || 0,
        maxDrift: data?.room_max_drift_ms || 0,
      });
    });

    // Server-authoritative seek: when the server's SyncDecision module
    // determines this client needs to seek, it pushes this command with
    // a pre-computed target (already includes learned_L overshoot).
    // Reconcile just executes it.
    //
    // L_processing measurement: timestamp the moment we tell the player
    // to seek; on the next PLAYING transition compute the elapsed time
    // and stash it for the next drift report. The server uses that
    // observed L directly as the next overshoot — no post-seek-window
    // inference, no observation-pending bookkeeping.
    this.handleEvent(LV_EVT.SYNC_SEEK_COMMAND, (data) => {
      if (!this.player || !this.isReady) return;
      // Suppress player events during the seek so the iOS PAUSED →
      // BUFFERING → PLAYING flicker doesn't broadcast spurious sync
      // events to the room.
      this.suppression.suppress("playing");
      this._seekIssuedAt = performance.now();
      this._showSyncingOverlay("Re-syncing…");
      this.reconcile.executeSeek?.(data?.position || 0, data?.server_time);
    });
    this.handleEvent(LV_EVT.SYNC_AUTOPLAY_COUNTDOWN, (data) => this._onAutoplayCountdown(data));
    this.handleEvent(LV_EVT.SYNC_AUTOPLAY_CANCELLED, () => this._hideAutoplayCountdown());
    this.handleEvent(LV_EVT.SPONSOR_SEGMENTS, (data) => this._onSponsorSegments(data));
    this.handleEvent(LV_EVT.EXT_PLAYER_STATE, (data) => this._onExtPlayerState(data));
    this.handleEvent(LV_EVT.EXT_MEDIA_INFO, (data) => this._onExtMediaInfo(data));
    this.handleEvent(LV_EVT.READY_COUNT, (data) => this._onReadyCount(data));
    this.handleEvent(LV_EVT.SB_SETTINGS, (data) => {
      this.sbSettings = data;
      this._applySponsorSettingsFull();
    });
    this.handleEvent(LV_EVT.VIDEO_CHANGE, (data) => this._onVideoChange(data));
    this.handleEvent(LV_EVT.QUEUE_ENDED, () => this._onQueueEnded());
    this.handleEvent(LV_EVT.LIVE_STATUS, (data) => this._onServerLiveStatus(data));
    this.handleEvent(LV_EVT.MEDIA_METADATA, (data) => {
      if (data.title) this._lastTitle = data.title;
      if (data.thumbnail_url) this._lastThumb = data.thumbnail_url;
    });
    this.handleEvent(LV_EVT.TOAST, (data) => showToast(data.text));

    // Size the player to fit viewport: cap height so aspect-ratio shrinks width
    this._sizePlayer();
    this._resizeHandler = () => this._sizePlayer();
    window.addEventListener("resize", this._resizeHandler);

    // Report drift + observed L on a regular cadence so the panel
    // and SyncDecision have fresh data. The same helper is also
    // invoked immediately on seek-land (see _pushDriftReport callers
    // in _onPlayerStateChange) so server-driven cascades don't have
    // to wait for the next 500 ms tick.
    this._driftReportInterval = setInterval(
      () => this._pushDriftReport(),
      DRIFT_REPORT_INTERVAL_MS
    );

    // Auto-detect live vs VOD. The URL parser sets is_live on a
    // best-effort basis (youtube.com/live/<id>, twitch.tv/<channel>),
    // but most live broadcasts live under /watch?v=<id> too — and
    // a live stream eventually ends and becomes a VOD. Sample
    // getDuration() over time: live duration grows at ~wall-clock
    // rate, VOD duration is stable. Bidirectional: when a live
    // stream stops growing we flip back so the queue's
    // ended-detection re-engages.
    this._liveDetectionInterval = setInterval(() => this._sampleLiveStatus(), LIVE_DETECTION_INTERVAL_MS);
  },

  reconnected() {
    // LiveView reconnected — server may have lost state (e.g. after a deploy
    // the room GenServer reloads from SQLite with play_state=:paused and a
    // possibly stale current_time, up to 30 s old).
    //
    // Reset clock sync to re-calibrate, then push our current local state so
    // the server can heal BEFORE it starts broadcasting heartbeats that would
    // pull us backward. v3.4.17's :play handler only updates current_time on
    // a real state transition, so this is safe: if the server already has
    // accurate state (didn't restart), the echo is harmless.
    this.clockSync.stop();
    this.clockSync = new ClockSync((event, payload) =>
      this.pushEvent(event, payload)
    );
    // Kick off the probe burst + maintenance immediately rather than
    // waiting for the server's mount-time SYNC_STATE push to arrive.
    // After a deploy that round-trip can stall by several seconds, and
    // until clockSync.isReady() flips back true the drift-report
    // interval (mounted()) early-returns — which makes this client
    // disappear from other peers' Stats-for-nerds Connected clients
    // panel for the duration of the gap. Fire-and-forget; if
    // _onSyncState lands later it'll re-call start() harmlessly (a
    // second burst overlays this one and the existing ready flag
    // stays true throughout).
    this.clockSync.start();
    this.clockSync.maintainSync();

    if (this.player && this.isReady) {
      const localState = this.player.getState?.();
      const position = this.player.getCurrentTime?.();
      if (typeof position === "number" && !isNaN(position)) {
        if (localState === "playing") {
          this.pushEvent(LV_EVT.EV_VIDEO_PLAY, { position });
        } else if (localState === "paused") {
          this.pushEvent(LV_EVT.EV_VIDEO_PAUSE, { position });
        }
      }
    }
  },

  destroyed() {
    window.__byobPlaying = false;
    this._hideAutoplayCountdown();
    this._hideSyncingOverlay();
    this.reconcile.stop();
    this.suppression.destroy();
    this.clockSync.stop();
    if (this.seekDetectorInterval) clearInterval(this.seekDetectorInterval);
    if (this.stateCheckInterval) clearInterval(this.stateCheckInterval);
    if (this.sponsorCheckInterval) clearInterval(this.sponsorCheckInterval);
    if (this._driftReportInterval) clearInterval(this._driftReportInterval);
    if (this._liveDetectionInterval) clearInterval(this._liveDetectionInterval);
    if (this._extPollInterval) clearInterval(this._extPollInterval);
    if (this._extBtnPoll) clearInterval(this._extBtnPoll);
    if (this._embedReadyHandler) window.removeEventListener("message", this._embedReadyHandler);
    if (this._unloadHandler) window.removeEventListener("beforeunload", this._unloadHandler);
    if (this._resizeHandler) window.removeEventListener("resize", this._resizeHandler);
    if (this._onVisibilityChange) document.removeEventListener("visibilitychange", this._onVisibilityChange);
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
        // Set _pendingState BEFORE _loadVideo so the shouldPlay check inside
        // _loadVideo sees the correct play_state ("playing"). Otherwise the
        // YouTube embed URL ends up with autoplay=0 on a fresh mount, which
        // can leave the player paused at 0 after the subsequent seek.
        this._pendingState = state;
        this._loadVideo(item.source_type, item.source_id, item.url, item);
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
      // For live content, every player joins at its own live edge —
      // a server-derived position would knock us off live. Skip the
      // seek + reconcile entirely; play() lands us at live by default.
      if (!this._isLive) {
        this._seekTo(position);
        // Show "Joining…" overlay during the initial seek + the
        // server's adaptive-L-learning second seek (roughly 2-3 s).
        // It auto-hides once the player transitions to playing or
        // the safety timer fires.
        this._showSyncingOverlay("Joining…");
      }
      this._play();
      if (!this._isLive) {
        this.reconcile.setServerState(
          state.current_time,
          state.server_time,
          this.clockSync
        );
        this.reconcile.pauseFor(2000);
        this.reconcile.start();
      }

      this._retryPlayOrShowOverlay(position);
    } else if (state.play_state === "paused") {
      // If this tab has never received a user gesture, the YouTube embed
      // often renders as a frozen black rectangle that ignores clicks
      // on its own controls (browser autoplay policy + iframe quirks).
      // Preempt that by showing our own overlay; one click activates the
      // tab so the later sync:play can actually start playback.
      this._maybeShowReadyOverlay(state.current_time);
      this.expectedPlayState = "paused";
      this.suppression.suppress("paused");
      if (this.sourceType === "youtube" && this.player?.loadVideoById) {
        // Load fully (not cue) so the video is ready to play instantly on resume.
        // _loadingPaused flag tells _onPlayerStateChange to swallow the pause event
        // once the load completes, rather than echoing it to the server.
        this._loadingPaused = true;
        this.player.loadVideoById({
          videoId: this.sourceId,
          startSeconds: state.current_time,
        });
        // Pause as soon as YouTube starts loading
        const pauseOnLoad = () => {
          const s = this.player?.getState?.();
          if (s === "playing" || s === "buffering") {
            this._pause();
            return;
          }
          if (this._loadPauseAttempts < PAUSE_ON_LOAD_MAX_ATTEMPTS) {
            this._loadPauseAttempts = (this._loadPauseAttempts || 0) + 1;
            setTimeout(pauseOnLoad, PAUSE_ON_LOAD_POLL_MS);
          }
        };
        this._loadPauseAttempts = 0;
        setTimeout(pauseOnLoad, PAUSE_ON_LOAD_POLL_MS);
      } else {
        this._seekTo(state.current_time);
      }
    }
  },

  async _loadVideo(sourceType, sourceId, url, mediaItem) {
    this._playerSettled = false;
    this.sourceType = sourceType;
    this.sourceId = sourceId;
    // Live content (YT live, Twitch) skips time-based sync — drift
    // reports, reconcile loop, seek-event push, and ended detection
    // are all gated on this flag downstream. The URL parser seeds
    // this; runtime auto-detection (_sampleLiveStatus) confirms or
    // overrides it from the player's actual duration behavior.
    this._isLive = !!mediaItem?.is_live;
    this._lastDurationSample = null;
    // Tracking the playing item by its server-assigned id (rather
    // than queue index) lets a stale `:ended` from a backgrounded
    // tab whose tick fired post-advance be rejected by the server.
    // current_index is always 0 server-side after each advance,
    // so the previous index-based check accepted any :ended whose
    // pending_advance ref slot was empty.
    this._currentItemId = mediaItem?.id || null;
    // Reset the per-item "have we sent video:loaded yet" flag — used
    // by _signalLoaded to avoid double-pushing for the same item.
    this._loadedReportedFor = null;
    this._lastTitle = mediaItem?.title || url;
    this._lastThumb = mediaItem?.thumbnail_url ||
      (sourceType === "youtube" && sourceId ? `https://img.youtube.com/vi/${sourceId}/hqdefault.jpg` : null);
    this._embedBlocked = false;
    if (this._extPollInterval) { clearInterval(this._extPollInterval); this._extPollInterval = null; }
    if (this._extBtnPoll) { clearInterval(this._extBtnPoll); this._extBtnPoll = null; }
    // Structural offset is a property of the current player pipeline. A new
    // source can mean different latency; let it re-learn from scratch.
    this.reconcile.resetOffset();

    const pending = this._pendingState;
    const shouldPlay = pending?.play_state === "playing";

    // Compute where to start playback. Using YouTube's `start` playerVar avoids
    // the load-at-0-then-seek flash (and keeps the correct position even if
    // the post-load seek is swallowed by autoplay blocking).
    let startSeconds = 0;
    if (pending && this.clockSync?.isReady?.()) {
      const elapsed = pending.play_state === "playing"
        ? (this.clockSync.serverNow() - pending.server_time) / 1000
        : 0;
      startSeconds = Math.max(0, (pending.current_time || 0) + elapsed);
    }

    // Diagnostic — surface the computed start so we can see in the console
    // whether the server is handing us a stale current_time after a deploy.
    console.debug("[byob] _loadVideo", {
      sourceType,
      shouldPlay,
      startSeconds,
      pending_current_time: pending?.current_time,
      pending_server_time: pending?.server_time,
      clockSync_ready: this.clockSync?.isReady?.(),
      clockSync_offset: this.clockSync?.offset,
    });

    if (sourceType === "youtube") {
      await this._loadYouTube(sourceId, shouldPlay, startSeconds);
    } else if (sourceType === "vimeo") {
      await this._loadVimeo(sourceId, shouldPlay, startSeconds);
    } else if (sourceType === "direct_url") {
      this._loadDirectUrl(url);
    } else {
      this._loadExtension(mediaItem, url);
    }
  },

  async _loadYouTube(videoId, shouldPlay, startSeconds = 0) {
    // Can we reuse the existing YouTube player?
    const canReuse = this.player && this.player.loadVideoById && this.sourceType === "youtube";

    const callbacks = {
      onReady: (player) => {
        // Assign synchronously so _applyPendingState's seek/play call find the
        // player. Previously `this.player` was only set after the awaited
        // `create()` resolved — which happens AFTER this callback fires —
        // leaving the initial seek as a no-op.
        if (player) this.player = player;
        this.isReady = true;
        this._signalLoaded();
        this._applyPendingState();
        this._startSeekDetector();
        this._retrySponsorBar();
      },
      onLoadStart: () => {
        this.isReady = false;
        this._endedFired = false;
        this._endedAt = null;
        this._endStallTicks = 0;
        this._endStallLastPos = 0;
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
        startSeconds,
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
        startSeconds,
        reuse: null,
      });
    }
  },

  async _loadVimeo(videoId, shouldPlay, startSeconds = 0) {
    // Destroy existing player if switching source types
    if (this.player && this.player.destroy) {
      try { this.player.destroy(); } catch (_) {}
    }
    this.player = null;
    this.isReady = false;

    const callbacks = {
      onReady: (player) => {
        if (player) this.player = player;
        this.isReady = true;
        this._signalLoaded();
        this._applyPendingState();
        this._startSeekDetector();
      },
      onStateChange: (name) => this._onPlayerStateChange(name),
      onLoadStart: () => {},
    };

    this.player = await VimeoPlayer.create(this.el, callbacks, {
      videoId,
      shouldPlay,
      startSeconds,
    });
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
        this._signalLoaded();
        this._applyPendingState();
        this._startSeekDetector();
      },
      onStateChange: (stateName) => {
        if (stateName === "playing") {
          if (this.suppression.shouldSuppress("playing")) return;
          this.expectedPlayState = "playing";
          const position = this.player.getCurrentTime();
          this.pushEvent(LV_EVT.EV_VIDEO_PLAY, { position });
          const serverTime = this.clockSync.serverNow();
          this.reconcile.setServerState(position, serverTime, this.clockSync);
          this.reconcile.pauseFor(1000);
          this.reconcile.start();
        } else if (stateName === "paused") {
          if (this.suppression.shouldSuppress("paused")) return;
          this.expectedPlayState = "paused";
          const position = this.player.getCurrentTime();
          this.pushEvent(LV_EVT.EV_VIDEO_PAUSE, { position });
          this.reconcile.stop();
        } else if (stateName === "ended") {
          this.expectedPlayState = null;
          this.reconcile.stop();
          if (this._currentItemId) {
            this.pushEvent(LV_EVT.EV_VIDEO_ENDED, { item_id: this._currentItemId });
          }
        }
      },
      onSeeked: (currentTime) => {
        if (this.suppression.isActive()) return;
        this.pushEvent(LV_EVT.EV_VIDEO_SEEK, { position: currentTime });
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
        this._signalLoaded();
        this._applyPendingState();
      },
    };

    this.player = ExtensionPlayer.create(this.el, callbacks, {
      title,
      thumbnailUrl: thumb,
      url,
      hook: this,
    });
  },

  // Unified YouTube state change handler (called from YouTube player module)
  _onPlayerStateChange(stateName) {
    // Any transition into actually-playing (or buffering en route to playing)
    // makes our click-to-play overlays obsolete — tear them down so they
    // don't sit on top of a playing video waiting for a click that would
    // do nothing useful.
    if (stateName === "playing" || stateName === "buffering") {
      this.el.querySelector(".byob-join-ready")?.remove();
      this.el.querySelector(".byob-click-to-play")?.remove();
    }

    // The "Syncing…" overlay hides only when the player has actually
    // resumed playing — buffering still means the seek hasn't fully
    // landed, so leave it up to keep the user informed.
    if (stateName === "playing") {
      this._hideSyncingOverlay();
      // L_processing measurement. Captured BEFORE the suppression
      // check below (which swallows the event for sync-issued seeks).
      //
      // YouTube's typical post-seek pattern is PLAYING → BUFFERING →
      // PLAYING — the FIRST PLAYING fires when the player thinks it's
      // about to render frames at the new position; the SECOND fires
      // when it actually is. We update on every PLAYING within the
      // post-seek window so the LATEST timestamp wins (i.e. the
      // accurate, "actually rendering frames" one). _seekIssuedAt is
      // not cleared here — it's cleared in the next drift report,
      // after we ship the measurement to the server.
      if (this._seekIssuedAt > 0) {
        const elapsed = performance.now() - this._seekIssuedAt;
        if (elapsed >= 50 && elapsed < 3000) {
          this._lastObservedL = elapsed;
          // Push an out-of-cadence drift report so SyncDecision can
          // fire the next compensating seek immediately instead of
          // waiting up to 500 ms for the regular interval. Most
          // useful on slow-L devices (iPhone YT IFrame) where each
          // saved cadence wait compounds across cascading seeks.
          // Tiny defer (50 ms) lets the player's getCurrentTime()
          // reflect the post-seek position before we measure drift.
          if (this._postSeekReportTimer) clearTimeout(this._postSeekReportTimer);
          this._postSeekReportTimer = setTimeout(() => {
            this._postSeekReportTimer = null;
            this._pushDriftReport();
          }, 50);
        }
      }
    }

    // Buffering is transient — don't push to server, don't update
    // expectedPlayState. Also cancel any pending suppression settle:
    // YouTube typically fires PLAYING → BUFFERING → PLAYING after a
    // seek (including the seek that runs as part of joining a playing
    // room), and we want the second PLAYING to stay suppressed instead
    // of leaking out as a stale :sync_play that snaps every peer to our
    // (still-settling) position.
    if (stateName === "buffering") {
      this.suppression.cancelSettle?.();
      return;
    }

    // Mark player as settled on first stable state after load.
    // Do this BEFORE suppression so that suppressed events (from programmatic
    // commands like loadVideoById) still mark the player as ready.
    if (!this._playerSettled && (stateName === "playing" || stateName === "paused")) {
      this._playerSettled = true;
      // Belt-and-suspenders: also signal loaded here in case the
      // player adapter's onReady fired before _currentItemId was set
      // (rare but possible during reuse paths). _signalLoaded is
      // idempotent per item_id.
      this._signalLoaded();
      // If we were loading-for-pause, the pause has landed — don't push it
      if (this._loadingPaused && stateName === "paused") {
        this._loadingPaused = false;
        // Still let suppression consume this event
        this.suppression.shouldSuppress(stateName);
        return;
      }
    }

    // Always let suppression consume events (tracks terminal state)
    if (stateName && this.suppression.shouldSuppress(stateName)) {
      return;
    }

    // Don't push events to server until player is settled after load
    if (!this._playerSettled) {
      return;
    }

    if (stateName === "playing") {
      // YouTube can auto-replay (end-card UI, related-video carousel,
      // or just internal state churn between ENDED and a fresh state)
      // within ~100-300ms of firing the ended event. Treat any
      // "playing" transition that lands within 500ms of ended as
      // auto-replay — don't push :play to the server (that would
      // cancel the autoplay-advance timer) and pause the player so
      // the queue can finalize. A user clicking the YT replay button
      // takes much longer (seconds), so the gate cleanly separates
      // the two intents.
      if (this._endedFired && this._endedAt && Date.now() - this._endedAt < 500) {
        try { this._pause(); } catch (_) {}
        return;
      }

      this.expectedPlayState = "playing";
      window.__byobPlaying = true;
      // Reset the ended marker so a subsequent end-of-replay run still
      // pushes :ended.
      this._endedFired = false;
      this._endedAt = null;
      const position = this.player.getCurrentTime();
      this.pushEvent(LV_EVT.EV_VIDEO_PLAY, { position });
      // For live content, position has no meaning to peers, and the
      // reconcile loop would constantly fight the player's own live-
      // edge management. Skip starting it.
      if (!this._isLive) {
        const serverTime = this.clockSync.serverNow();
        this.reconcile.setServerState(position, serverTime, this.clockSync);
        this.reconcile.pauseFor(1000);
        this.reconcile.start();
      }
    } else if (stateName === "paused") {
      this.expectedPlayState = "paused";
      window.__byobPlaying = false;
      const position = this.player.getCurrentTime();
      this.pushEvent(LV_EVT.EV_VIDEO_PAUSE, { position });
      this.reconcile.stop();
    } else if (stateName === "ended") {
      // Stop heartbeat from force-replaying the video
      this.expectedPlayState = null;
      window.__byobPlaying = false;
      this.reconcile.stop();
      this._endedAt = Date.now();
      // Live streams don't have a meaningful "ended" — a brief stall
      // (broadcaster blip, reconnection) shouldn't auto-advance the
      // queue. We rely on duration-growth detection to flip _isLive
      // off if the broadcast actually ended and became a VOD.
      if (this._isLive) return;
      // Only send ended if the position-based detector hasn't already
      if (!this._endedFired) {
        this._endedFired = true;
        if (this._currentItemId) {
          this.pushEvent(LV_EVT.EV_VIDEO_ENDED, { item_id: this._currentItemId });
        }
      }
    }
  },

  _onYTError(event) {
    handleYTError(this, event);
  },

  _onSyncPlay(data) {
    this.expectedPlayState = "playing";
    // Resuming from pause — clear the per-pause-session pill throttle
    // so the next time we land in paused, the FIRST sync command
    // there can pop the pill once again.
    this._pausedSyncPillShown = false;
    // Remove any of our own overlays — host is taking us out of the
    // paused "waiting to join" state, or we're already playing and this
    // is a redundant broadcast.
    this.el.querySelector(".byob-click-to-play")?.remove();
    this.el.querySelector(".byob-join-ready")?.remove();
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
    // Another user started playback. If autoplay is blocked in THIS tab
    // (e.g. user just arrived and hasn't interacted yet), the _play()
    // call above silently fails and we get a black player with no way
    // to recover. Same retry-then-show-overlay dance as initial sync.
    this._retryPlayOrShowOverlay(data.time);
  },

  // Check every 500ms up to 3× whether playback actually started after
  // _play(). If not — autoplay was blocked — show the click-to-play
  // overlay so the user has an obvious way to bypass it.
  _retryPlayOrShowOverlay(position) {
    const checkAndRetry = (attempt) => {
      setTimeout(() => {
        if (this._embedBlocked || this._playerSettled) return;
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
            this._showClickToPlay(position);
          }
        }
      }, attempt * 500);
    };
    checkAndRetry(1);
  },

  _onSyncPause(data) {
    this.expectedPlayState = "paused";
    // Pause supersedes any in-flight syncing pill — there's nothing
    // to "be in sync" with while paused. Reset the per-pause-session
    // throttle so the FIRST sync command in this new paused session
    // can still pop the pill once.
    this._hideSyncingOverlayNow?.();
    this._pausedSyncPillShown = false;
    if (data.user_id === this.userId) return;
    this.suppression.suppress("paused");
    // Don't seekTo here — it causes YouTube to fire double PAUSED events,
    // one of which leaks past suppression and echoes back as a stale pause.
    // Position will be corrected on next play via reconcile.
    this._pause();
    this.reconcile.stop();
  },

  _onSyncCorrection(data) {
    // Periodic reference refresh (1s cadence) — keep drift history warm so
    // the median filter can actually smooth jitter between corrections.
    this.reconcile.setServerState(
      data.expected_time,
      data.server_time,
      this.clockSync,
      { resetHistory: false }
    );
  },

  // Lightweight periodic heartbeat from server. Two jobs:
  //   1. Confirm play_state matches (catches missed sync:play / sync:pause
  //      broadcasts after transient disconnects).
  //   2. Refresh the reconcile loop's reference point so drift extrapolation
  //      doesn't accumulate error between natural state changes.
  // Deliberately NOT a full re-init (no clock-sync burst, no video reload).
  _onSyncHeartbeat(data) {
    if (!this.player) return;
    // Skip while we're in the middle of joining / applying initial state —
    // _applyBufferedState / _applyPendingState owns reconcile setup during
    // those windows.
    if (this.bufferedState || this._pendingState) return;

    const expected = data.play_state; // "playing" | "paused"

    // If server disagrees with what we expected, adopt server's view. The
    // existing stateCheckInterval will then drive the YouTube player to match.
    // But don't override after video ended — server says "paused" but the
    // player is in "ended" state; forcing "paused" can restart the video.
    if (expected && this.expectedPlayState !== expected && !this._endedFired) {
      this.expectedPlayState = expected;
    }

    // Always refresh the drift-correction reference point. Periodic refresh
    // (5s cadence) — preserve drift history so the median filter stays warm.
    if (typeof data.current_time === "number" && typeof data.server_time === "number") {
      this.reconcile.setServerState(data.current_time, data.server_time, this.clockSync, { resetHistory: false });
    }
  },

  _onAutoplayCountdown(data) {
    const duration = data?.duration_ms || 5000;
    this._showAutoplayCountdown(duration);
  },

  _showAutoplayCountdown(duration) {
    this._hideAutoplayCountdown();

    const overlay = document.createElement("div");
    overlay.id = "byob-autoplay-countdown";
    overlay.setAttribute("aria-label", "Up next in " + Math.round(duration / 1000) + " seconds");
    overlay.style.cssText = [
      "position:absolute",
      "bottom:16px",
      "right:16px",
      "width:64px",
      "height:64px",
      "z-index:30",
      "pointer-events:none",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "color:white",
      "font:600 18px/1 system-ui",
      "text-shadow:0 1px 2px rgba(0,0,0,0.5)",
      // Pie-slice: conic-gradient filling clockwise from 12 o'clock
      "background:conic-gradient(var(--byob-pie-color,#0094ff) var(--byob-pie-angle,0deg), rgba(0,0,0,0.5) 0)",
      "border-radius:50%",
      "box-shadow:0 2px 12px rgba(0,0,0,0.4)",
      "--byob-pie-angle:0deg",
    ].join(";");

    const label = document.createElement("span");
    label.style.cssText = "position:relative;z-index:1;";
    label.textContent = Math.ceil(duration / 1000);
    overlay.appendChild(label);

    // Mount inside the player element so it's positioned relative to it
    const anchor = this.el;
    if (anchor) anchor.appendChild(overlay);

    // Animate the pie angle with requestAnimationFrame
    const start = performance.now();
    const tick = () => {
      const elapsed = performance.now() - start;
      const ratio = Math.min(1, elapsed / duration);
      const angle = ratio * 360;
      overlay.style.setProperty("--byob-pie-angle", angle + "deg");
      const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
      label.textContent = remaining;
      if (ratio < 1) {
        this._autoplayFrame = requestAnimationFrame(tick);
      }
    };
    this._autoplayFrame = requestAnimationFrame(tick);
    this._autoplayOverlay = overlay;
  },

  _hideAutoplayCountdown() {
    if (this._autoplayFrame) {
      cancelAnimationFrame(this._autoplayFrame);
      this._autoplayFrame = null;
    }
    if (this._autoplayOverlay && this._autoplayOverlay.parentElement) {
      this._autoplayOverlay.parentElement.removeChild(this._autoplayOverlay);
    }
    this._autoplayOverlay = null;
  },

  _onVideoChange(data) {
    this._hideAutoplayCountdown();
    const item = data.media_item;
    this.el.dataset.currentIndex = data.index;
    this.reconcile.stop();

    // If the new video is also extension-required, keep the popup window
    // and chrome.storage config alive — the extension's content script
    // will navigate the existing tab to the new URL itself. Closing /
    // clearing now would race with that nav and force the user to click
    // "Open in extension" again on every episode.
    const newIsExtension = item && item.source_type === "extension_required";

    if (!newIsExtension) {
      // Close any open external player window. Don't gate on .closed —
      // YouTube sets COOP=same-origin which severs the opener and makes
      // WindowProxy.closed return true even for an open popup. close() is
      // a no-op on an actually-closed window, so call it unconditionally.
      if (window._byobPlayerWindow) {
        try { window._byobPlayerWindow.close(); } catch (_) {}
        window._byobPlayerWindow = null;
      }
      // Clear extension storage config
      window.postMessage({ type: LV_EVT.PW_CLEAR_EXTERNAL }, "*");
    }
    // Clear old sponsor data — new segments will arrive via sponsor:segments event
    this._lastSponsorData = null;
    this.sponsorSegments = [];
    this._sponsorBarSegments = null;
    this._sponsorBarDuration = 0;
    // Reset the cached ext-player state so the placeholder doesn't carry
    // the previous video's progress bar / timeline through the transition.
    // The new popup re-hooks and pushes fresh `ext:player-state` events
    // within ~1s, but the gap shouldn't display stale 1:17/23:40 figures
    // from the previous episode.
    this._lastExtPlayerState = null;
    this._renderExtStatus();
    // Server tells us the play_state to apply on load. With the
    // ready-then-play handshake, video changes initially set this to
    // "paused" and we wait for the explicit `sync:play` once every
    // peer signals `video:loaded`. Older servers (or callers that
    // didn't include the field) fall back to "playing".
    //
    // CRITICAL: set _pendingState BEFORE _loadVideo. _loadVideo reads
    // _pendingState to compute shouldPlay (and start position). If we
    // set it after, the player picks up the PREVIOUS video's pending
    // state — for video changes that's always "playing", which makes
    // the new video auto-play and defeats the ready-then-play hold.
    const pendingPlayState = data.play_state === "paused" ? "paused" : "playing";
    this._pendingState = {
      play_state: pendingPlayState,
      current_time: 0,
      server_time: this.clockSync.serverNow(),
    };
    // Show the bottom-right pill while the player loads + the
    // ready-then-play handshake completes. Without this the user just
    // sees a black YouTube embed for several seconds before the
    // server's `:sync_play` arrives and playback actually starts.
    // _hideSyncingOverlay's existing 1.5 s grace lets it stay
    // continuously visible across the load → sync_play → first
    // PLAYING transition; the 5 s safety timer covers the worst case.
    // Fresh video = fresh logical session — clear the per-pause-
    // session pill throttle so the "Waiting for room…" pill can pop
    // even if the previous pause session already used its one show.
    this._pausedSyncPillShown = false;
    const overlayText =
      pendingPlayState === "paused" ? "Waiting for room…" : "Joining…";
    this._showSyncingOverlay(overlayText);
    this._loadVideo(item.source_type, item.source_id, item.url, item);
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

  // Server told us the current item's live status changed. The
  // sender may be us (ignore — we already updated locally before
  // pushing) or a peer (apply locally so we drop into / out of
  // skip-sync mode in lockstep).
  _onServerLiveStatus(data) {
    const next = !!data?.is_live;
    if (next === this._isLive) return;
    this._isLive = next;
    if (next) {
      // Switched into live — stop the reconcile loop so we don't
      // fight the player's live-edge management, and clear any
      // pending end-detection state from the prior VOD pass.
      this.reconcile.stop();
      this._endedFired = false;
      this._endedAt = null;
    } else {
      // Switched out of live (broadcast ended → became a VOD with
      // a finite duration). Re-engage reconcile only if we're
      // currently playing, mirroring the path _applyPendingState
      // takes on a fresh VOD load.
      const playerState = this.player?.getState?.();
      if (playerState === "playing") {
        const pos = this._getCurrentTime();
        const serverTime = this.clockSync?.serverNow?.();
        if (typeof pos === "number" && typeof serverTime === "number") {
          this.reconcile.setServerState(pos, serverTime, this.clockSync);
          this.reconcile.pauseFor(1000);
          this.reconcile.start();
        }
      }
    }
  },

  // Poll the player for live vs VOD signals. YT/Vimeo: live
  // duration grows at ≈ wall-clock rate; VOD duration is stable.
  // Direct video / HLS: video.duration is Infinity / NaN for live.
  _sampleLiveStatus() {
    if (!this.player || !this.isReady) return;
    const playerState = this.player.getState?.();
    // getDuration() doesn't update reliably while paused, so only
    // sample during active playback. Reset the sample buffer when
    // we're not playing so a pause→play cycle compares fresh.
    if (playerState !== "playing") {
      this._lastDurationSample = null;
      return;
    }

    let detected = null;

    if (this.sourceType === "direct_url") {
      const v = this.el.querySelector("video");
      if (v) {
        if (v.duration === Infinity || (typeof v.duration === "number" && isNaN(v.duration))) {
          detected = true;
        } else if (typeof v.duration === "number" && v.duration > 0 && isFinite(v.duration)) {
          detected = false;
        }
      }
    } else if (this.sourceType === "youtube" || this.sourceType === "vimeo") {
      const dur = this.player.getDuration?.();
      if (typeof dur !== "number" || isNaN(dur)) return;

      const now = performance.now();
      const prev = this._lastDurationSample;
      this._lastDurationSample = { dur, at: now };
      if (!prev) return;

      const elapsed = (now - prev.at) / 1000;
      if (elapsed < 2) return;

      const grew = dur - prev.dur;
      // Live: duration tracks wall clock (give some slack for
      // sample jitter — 0.5x to 1.5x the elapsed seconds).
      // VOD: duration is stable — drifts < 0.5 second over our
      // sample interval.
      // Anything outside both bands (e.g., a metadata-late VOD
      // jumping from 0 to 3600) stays inconclusive.
      if (grew >= elapsed * 0.5 && grew <= elapsed * 1.5) {
        detected = true;
      } else if (grew < 0.5) {
        detected = false;
      }
    }

    if (detected !== null && detected !== this._isLive) {
      this._isLive = detected;
      this.pushEvent(LV_EVT.EV_VIDEO_LIVE_STATUS, { is_live: detected });
      if (detected) {
        // Stop fighting the live edge.
        this.reconcile.stop();
        this._endedFired = false;
        this._endedAt = null;
      }
      // The server broadcast will round-trip back as LIVE_STATUS
      // and _onServerLiveStatus will re-engage reconcile for the
      // VOD case if we're playing — no need to do it here.
    }
  },

  _onReadyCount(data) {
    this._lastReadyCount = data;
    if (this._lastExtPlayerState) this._renderExtStatus();
    // Notify the extension placeholder's inline button so its label
    // ("Open" vs "Focus") flips with port-disconnect / new-popup events.
    if (typeof this._extPlaceholderRefreshLabel === "function") {
      try { this._extPlaceholderRefreshLabel(); } catch (_) {}
    }
  },

  _onExtPlayerState(data) {
    this._lastExtPlayerState = data;
    this._renderExtStatus();
  },

  // Compose "<base> — <readiness>" for the extension placeholder. Mirrors
  // the per-tab tooltip text the third-party sync bar shows so users on
  // the main page can see at a glance whether their friends still need
  // to open a player window or hit play.
  _renderExtStatus() {
    const status = document.getElementById("ext-status");
    const container = document.getElementById("ext-progress-container");
    const fill = document.getElementById("ext-progress-fill");
    const timeCur = document.getElementById("ext-time-current");
    const timeDur = document.getElementById("ext-time-duration");
    if (!status) return;

    const fmt = (s) => Math.floor(s / 60) + ":" + Math.floor(s % 60).toString().padStart(2, "0");
    const data = this._lastExtPlayerState || {};

    if (data.hooked) {
      const base = data.playing ? "Playing in external window" : "Paused in external window";
      status.textContent = base + this._readinessSuffix();
      if (container) container.style.display = "block";
      if (fill && data.duration > 0) fill.style.width = ((data.position / data.duration) * 100) + "%";
      if (timeCur) timeCur.textContent = fmt(data.position);
      if (timeDur) timeDur.textContent = fmt(data.duration);
    } else {
      status.textContent = "Waiting for external player..." + this._readinessSuffix();
      if (container) container.style.display = "none";
    }
  },

  // " — N/M ready" or " — N/M ready · 1 needs to open · Bob needs to hit play"
  // Mirrors the extension sync bar's tooltip semantics; empty string when
  // there's nothing useful to add (no extension users connected, or the
  // count hasn't arrived yet).
  _readinessSuffix() {
    const r = this._lastReadyCount;
    if (!r || !r.total || r.total <= 0) return "";

    const allReady = r.ready >= r.total;
    if (allReady) return ` — ${r.ready}/${r.total} ready`;

    const parts = [`${r.ready}/${r.total} ready`];
    const openList = Array.isArray(r.needs_open) ? r.needs_open : [];
    const playList = Array.isArray(r.needs_play) ? r.needs_play : [];
    const needTab = openList.length || (r.total - r.has_tab);
    const needClick = playList.length || (r.has_tab - r.ready);

    if (needTab > 0) {
      const names = openList.length ? ` (${openList.join(", ")})` : "";
      parts.push(`${needTab} need${needTab === 1 ? "s" : ""} to open${names}`);
    }
    if (needClick > 0) {
      const names = playList.length ? ` (${playList.join(", ")})` : "";
      parts.push(`${needClick} need${needClick === 1 ? "s" : ""} to hit play${names}`);
    }
    return ` — ${parts.join(" · ")}`;
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
      setTimeout(retry, VIDEO_CHANGE_RETRY_1_MS);
      setTimeout(retry, VIDEO_CHANGE_RETRY_2_MS);
    }
  },

  // Detect seeks while paused (YouTube doesn't fire onStateChange for these)
  _startSeekDetector() {
    if (this.seekDetectorInterval) clearInterval(this.seekDetectorInterval);
    this.seekDetectorInterval = setInterval(() => {
      if (!this.player) return;
      // For live content, seeks are local-only (live edge / DVR) and
      // don't broadcast — every player is at its own live position.
      // The ended-detection block below also no-ops for live since
      // duration grows with wall clock and pos never reaches dur.
      if (this._isLive) {
        this.lastKnownPosition = this._getCurrentTime();
        return;
      }
      const pos = this._getCurrentTime();
      const playerState = this.player.getState?.();
      const isPaused = playerState === "paused";
      // Detect seeks: large position jumps (>3s while playing, >1s while paused)
      const jumpThreshold = isPaused ? 1 : 3;
      const jumped = Math.abs(pos - this.lastKnownPosition) > jumpThreshold;
      if (jumped) {
        if (!this.suppression.isActive()) {
          this.pushEvent(LV_EVT.EV_VIDEO_SEEK, { position: pos });
          const serverTime = this.clockSync.serverNow();
          this.reconcile.setServerState(pos, serverTime, this.clockSync);
          this.reconcile.pauseFor(1000);
        }
        // Any seek is unambiguous evidence the user isn't at the end of
        // the video anymore. Reset the ended marker so a subsequent play-
        // through to dur fires :ended again. Without this, a rapid
        // sequence of seeks (e.g. past-end → start → near-end within <500ms,
        // faster than this 500ms tick) leaves _endedFired stuck true from
        // the first seek's "past dur-1" trigger and the natural end of
        // the next play-through silently no-ops.
        this._endedFired = false;
        this._endedAt = null;
      }
      this.lastKnownPosition = pos;

      // Detect video ended — YouTube embeds may not fire YT_ENDED reliably
      const dur = this.player?.getDuration?.() || 0;
      // Track position-stall ticks: some YT videos sit at the final frame
      // a couple seconds short of `getDuration()` and never advance. The
      // dur-1 threshold below misses them; the stall counter catches the
      // case as a fallback.
      const stalledNow = Math.abs(pos - this._endStallLastPos) < 0.05;
      if (stalledNow) this._endStallTicks = (this._endStallTicks || 0) + 1;
      else this._endStallTicks = 0;
      this._endStallLastPos = pos;

      const fireEnded = () => {
        this._endedFired = true;
        this._endedAt = Date.now();
        this.expectedPlayState = null;
        this.reconcile.stop();
        if (this._currentItemId) {
          this.pushEvent(LV_EVT.EV_VIDEO_ENDED, { item_id: this._currentItemId });
        }
      };

      if (dur > 0 && pos >= dur - 1) {
        if (!this._endedFired) fireEnded();
      } else if (
        // Stall fallback. Some YT videos park a few seconds short of
        // `getDuration()` in a paused-ish state without firing the
        // ENDED state-change event, leaving the queue hung. Conditions:
        //   * within the last 5s of duration (tight window — false
        //     positives are limited to the literal last few seconds),
        //   * local player state is paused or ended (so we know it's
        //     stopped, not just buffering),
        //   * server still expects playing (rules out an intentional
        //     user pause — that would have flipped expectedPlayState
        //     to "paused" too via onStateChange's :pause push),
        //   * position hasn't moved for ~3 s.
        !this._endedFired &&
        dur > 0 &&
        pos >= dur - 5 &&
        (playerState === "paused" || playerState === "ended") &&
        this.expectedPlayState === "playing" &&
        this._endStallTicks >= 6
      ) {
        fireEnded();
      } else if (pos < dur - 2) {
        this._endedFired = false;
        this._endedAt = null;
      }
    }, 500);

    // State sync heartbeat — catches fast pause/unpause desync
    // Tracks how long state has been wrong. After 500ms of mismatch, force correction.
    this._mismatchSince = null;
    this._stuckBufferingSince = null;
    if (this.stateCheckInterval) clearInterval(this.stateCheckInterval);
    this.stateCheckInterval = setInterval(() => {
      if (!this.player || !this.expectedPlayState) return;
      const localState = this.player.getState?.();
      if (!localState || localState === "ended") return;

      // Buffering is usually transient — but a player that's stuck
      // buffering (e.g. after returning from a backgrounded tab) needs a
      // kick. If we've been in "buffering" + expected "playing" for more
      // than 5 s, pretend it's a real mismatch and force a play(+seek).
      if (localState === "buffering") {
        if (this.expectedPlayState !== "playing") {
          this._stuckBufferingSince = null;
          return;
        }
        if (!this._stuckBufferingSince) {
          this._stuckBufferingSince = performance.now();
          return;
        }
        if (performance.now() - this._stuckBufferingSince > 5000) {
          this._stuckBufferingSince = null;
          // Resume at the server's expected position, not wherever the
          // stuck buffer is.
          const expectedPos = this.reconcile?.serverPosition;
          if (typeof expectedPos === "number" && expectedPos > 0) {
            this._seekTo(expectedPos);
          }
          this.suppression.suppress("playing");
          this._play();
        }
        return;
      } else {
        this._stuckBufferingSince = null;
      }

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

    // When the tab returns from the background, aggressively reconcile:
    // timers were throttled, reconcile drift is likely huge, and the
    // player may have been paused by the OS/browser. Echo our state
    // back to the server so everyone is on the same page again.
    if (this._onVisibilityChange) {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
    }
    this._onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (!this.player) return;

      // Kick the reconcile: if the player was paused while backgrounded,
      // force it back to the expected state via the mismatch path above.
      this._mismatchSince = null;
      this._stuckBufferingSince = null;

      // Force a quick clock resync so drift-correction isn't acting on
      // stale offsets.
      if (this.clockSync && this.clockSync.resync) {
        this.clockSync.resync(3).catch(() => {});
      }

      // Echo our current state to the server. If we locally pushed through
      // play/pause while backgrounded (or got desynced from the room),
      // this pulls the server onto our actual state.
      setTimeout(() => {
        try {
          const localState = this.player?.getState?.();
          const pos = this._getCurrentTime();
          if (localState === "playing") {
            this.pushEvent(LV_EVT.EV_VIDEO_PLAY, { position: pos });
          } else if (localState === "paused") {
            this.pushEvent(LV_EVT.EV_VIDEO_PAUSE, { position: pos });
          }
        } catch (_) {}
      }, 200);
    };
    document.addEventListener("visibilitychange", this._onVisibilityChange);

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
        (cat, onUndo) => showSkipToast(cat, onUndo)
      );
    }, 250);
  },

  // Joined-while-paused overlay. The YouTube embed, before the tab has
  // received any user gesture, sometimes renders as a frozen black box
  // that even swallows its own native play-button clicks — so we lay
  // our own overlay on top. The click activates the tab for autoplay;
  // we don't start playback here because the room state is paused.
  // Skipped if the user has already interacted with this document
  // (`navigator.userActivation.hasBeenActive`).
  _maybeShowReadyOverlay(position) {
    if (this.sourceType !== "youtube") return;
    // If the user has already interacted with the doc since load,
    // the embed will be fully interactive — no overlay needed.
    if (navigator.userActivation?.hasBeenActive) return;
    if (document.getElementById("ext-placeholder")) return;
    // Don't stack with the other overlays.
    if (this.el.querySelector(".byob-click-to-play")) return;
    if (this.el.querySelector(".byob-join-ready")) return;
    // Never obscure a video that's actually playing locally.
    if (this._isLocallyPlaying()) return;

    // The "Click to join" overlay supersedes any in-flight "Re-syncing…"
    // pill — playback is paused waiting on the user, so the syncing
    // status is misleading. Bypass the deferred-hide grace.
    this._hideSyncingOverlayNow?.();
    const overlay = document.createElement("div");
    overlay.className = "byob-join-ready";
    // Background layer: video thumbnail (so the user sees the video even
    // while the YouTube embed is still a black box), dimmed underneath
    // the call-to-action.
    const thumbBg = this._lastThumb
      ? `background-image:url(${JSON.stringify(this._lastThumb)});background-size:cover;background-position:center;`
      : "";
    overlay.style.cssText = `position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;cursor:pointer;background:#000;${thumbBg}`;

    const dim = document.createElement("div");
    dim.style.cssText = "position:absolute;inset:0;background:rgba(0,0,0,0.55);";
    overlay.appendChild(dim);

    const btn = document.createElement("div");
    btn.style.cssText = "position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;";
    btn.innerHTML = `
      <div style="width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,0.9);display:flex;align-items:center;justify-content:center;">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="#000"><polygon points="6,3 20,12 6,21"/></svg>
      </div>
      <span style="color:white;font-size:14px;font-weight:600;text-shadow:0 1px 3px rgba(0,0,0,0.5);">Click to join the room</span>
      <span style="color:white;opacity:0.8;font-size:11px;text-shadow:0 1px 3px rgba(0,0,0,0.5);">Video is paused — you'll start playing when the host does</span>
    `;
    overlay.appendChild(btn);

    overlay.addEventListener("click", () => {
      overlay.remove();
      // Poke the YouTube embed with a tiny play-then-pause so the iframe
      // fully initializes (loads the first frame, shows its thumbnail,
      // accepts later playVideo() without a gesture). `_loadingPaused`
      // tells the onStateChange handler to swallow the resulting pause
      // event rather than echoing it to the server.
      if (this.player?.play && this.player?.pause) {
        this._loadingPaused = true;
        try { this.player.play(); } catch (_) {}
        setTimeout(() => {
          try { this.player.pause(); } catch (_) {}
          if (position != null) this._seekTo(position);
        }, 150);
      }
    }, { once: true });

    this.el.appendChild(overlay);
  },

  _showClickToPlay(position) {
    // Don't show when external player is active — user watches in the
    // extension window, not the embedded YouTube player
    if (document.getElementById("ext-placeholder")) return;
    // Never obscure a video that's actually playing locally.
    if (this._isLocallyPlaying()) return;

    // Remove any existing overlay
    this.el.querySelector(".byob-click-to-play")?.remove();

    // Click-to-play means playback is gated on the user — the
    // "Re-syncing…" pill would be misleading next to the gated state.
    this._hideSyncingOverlayNow?.();

    const overlay = document.createElement("div");
    overlay.className = "byob-click-to-play";
    // Thumbnail background so the user sees the video even when the
    // underlying embed is still a black box.
    const thumbBg = this._lastThumb
      ? `background-image:url(${JSON.stringify(this._lastThumb)});background-size:cover;background-position:center;`
      : "";
    overlay.style.cssText = `position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;cursor:pointer;background:#000;${thumbBg}`;

    const dim = document.createElement("div");
    dim.style.cssText = "position:absolute;inset:0;background:rgba(0,0,0,0.4);";
    overlay.appendChild(dim);

    const btn = document.createElement("div");
    btn.style.cssText = "position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;";
    btn.innerHTML = `
      <div style="width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,0.9);display:flex;align-items:center;justify-content:center;">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="#000"><polygon points="6,3 20,12 6,21"/></svg>
      </div>
      <span style="color:white;font-size:14px;font-weight:600;text-shadow:0 1px 3px rgba(0,0,0,0.5);">Click to join playback</span>
      <span style="color:white;opacity:0.8;font-size:11px;text-shadow:0 1px 3px rgba(0,0,0,0.5);">(Tip: enable autoplay to skip this)</span>
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

    // Show the help dialog the first time we hit a blocked-autoplay
    // situation in this browser. User can tick "don't show again" to
    // silence future prompts.
    this._maybeShowAutoplayHelp();
  },

  _maybeShowAutoplayHelp() {
    // Mobile browsers (iOS Safari, Android Chrome, etc.) don't support
    // the desktop "always allow autoplay for this site" toggle the
    // dialog walks the user through — autoplay is gated per-gesture
    // there regardless of any setting. Showing the help would just
    // confuse mobile users with instructions that don't apply, so
    // skip it entirely on touch-primary devices.
    const isMobile =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(pointer: coarse)")?.matches ||
        /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || ""));
    if (isMobile) return;

    try {
      if (localStorage.getItem("byob_autoplay_help_dismissed") === "1") return;
    } catch (_) {
      // localStorage disabled — show once per page load via a session flag
      if (window.__byob_autoplay_help_shown) return;
      window.__byob_autoplay_help_shown = true;
    }

    const dialog = document.getElementById("byob-autoplay-help");
    if (!dialog || dialog.open) return;
    try {
      dialog.showModal();
    } catch (_) {
      // <dialog> not supported — bail silently
      return;
    }

    // Capture dismissal: if the "don't show again" box is checked (default
    // true), persist that choice so we don't nag on subsequent blocks.
    const onClose = () => {
      const check = document.getElementById("byob-autoplay-help-dont-show");
      if (check && check.checked) {
        try {
          localStorage.setItem("byob_autoplay_help_dismissed", "1");
        } catch (_) {}
      }
      dialog.removeEventListener("close", onClose);
    };
    dialog.addEventListener("close", onClose);
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

  // True iff the YouTube/direct player is actually playing or buffering
  // right now. Used to suppress "click to play" overlays that would
  // otherwise sit on top of a live video.
  _isLocallyPlaying() {
    const s = this.player?.getState?.();
    return s === "playing" || s === "buffering";
  },

  // ── "Syncing…" overlay ────────────────────────────────────────────────
  // Shown briefly when the player is mid-correction:
  //   * Initial join's seek+play (_applyPendingState)
  //   * Server commanded a seek (SYNC_SEEK_COMMAND handler — covers both
  //     SyncDecision-issued seeks and personalised user-seek commands)
  // pointer-events: none — purely informational, doesn't block interaction.
  // Auto-hides on next "playing" state change, or after 3 s safety timeout
  // (whichever is first). Re-showing while already visible just resets the
  // safety timer, so the multi-seek L-learning sequence on join displays
  // continuously rather than flickering.
  _showSyncingOverlay(text = "Syncing…") {
    if (this.el.querySelector(".byob-click-to-play")) return;
    if (this.el.querySelector(".byob-join-ready")) return;
    // While paused, show the pill ONCE per pause session (first sync
    // command after the pause), then suppress subsequent shows so we
    // don't get a flicker of repeating Re-syncing… pills as the
    // server's per-peer commands cascade across paused clients. The
    // flag is reset whenever play_state transitions through pause→
    // play→pause, so each fresh paused session gets one pill.
    const isPaused =
      this.expectedPlayState === "paused" ||
      this.player?.getState?.() === "paused";
    if (isPaused) {
      if (this._pausedSyncPillShown) return;
      this._pausedSyncPillShown = true;
    }

    // Stamp the moment of this show — the deferred hide uses this to
    // keep the overlay visible for at least SYNCING_MIN_LIFETIME_MS
    // past the latest show. Cascading sync seeks within that window
    // therefore see the overlay as one continuous element instead of
    // flickering between hides and shows.
    this._lastSyncingShownAt = performance.now();
    if (this._syncingHideTimer) {
      clearTimeout(this._syncingHideTimer);
      this._syncingHideTimer = null;
    }

    let overlay = this.el.querySelector(".byob-syncing");
    if (overlay) {
      const labelEl = overlay.querySelector("[data-byob-syncing-label]");
      if (labelEl && labelEl.textContent !== text) labelEl.textContent = text;
    } else {
      if (!document.getElementById("byob-syncing-style")) {
        const style = document.createElement("style");
        style.id = "byob-syncing-style";
        style.textContent = "@keyframes byob-spin { to { transform: rotate(360deg); } }";
        document.head.appendChild(style);
      }
      overlay = document.createElement("div");
      overlay.className = "byob-syncing";
      // Compact bottom-right pill — same anchor area as the autoplay
      // countdown wheel — instead of a full-screen dimming overlay.
      // Doesn't obscure the video; just signals "background sync in
      // progress". pointer-events:none keeps clicks passing through.
      overlay.style.cssText = [
        "position:absolute",
        "bottom:16px",
        "right:16px",
        "z-index:30",
        "display:flex",
        "align-items:center",
        "gap:8px",
        "padding:6px 12px 6px 8px",
        "background:rgba(0,0,0,0.7)",
        "border-radius:9999px",
        "box-shadow:0 2px 12px rgba(0,0,0,0.4)",
        "color:white",
        "font:600 12px/1 system-ui",
        "pointer-events:none",
        "transition:opacity 200ms",
      ].join(";");
      overlay.innerHTML =
        `<svg width="16" height="16" viewBox="0 0 24 24" style="animation:byob-spin 0.8s linear infinite;flex:0 0 auto">` +
        `<circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" stroke-width="3" fill="none"/>` +
        `<path d="M12 2 a10 10 0 0 1 10 10" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/>` +
        `</svg>` +
        `<span data-byob-syncing-label>${text}</span>`;
      this.el.appendChild(overlay);
    }

    // Safety auto-hide so a stuck convergence doesn't leave the
    // overlay visible forever. 5 s covers ~3 cascading seeks.
    if (this._syncingTimer) clearTimeout(this._syncingTimer);
    this._syncingTimer = setTimeout(() => this._hideSyncingOverlayNow(), 5000);
  },

  // Public hide — defers the actual removal so a cascading sync seek
  // arriving within MIN_LIFETIME of the last show keeps the overlay
  // continuously visible. Use this from "playing" state changes.
  _hideSyncingOverlay() {
    const SYNCING_MIN_LIFETIME_MS = 1500;
    const elapsed = performance.now() - (this._lastSyncingShownAt || 0);
    if (elapsed >= SYNCING_MIN_LIFETIME_MS) {
      this._hideSyncingOverlayNow();
      return;
    }
    if (this._syncingHideTimer) return; // already pending
    this._syncingHideTimer = setTimeout(
      () => this._hideSyncingOverlay(),
      SYNCING_MIN_LIFETIME_MS - elapsed
    );
  },

  // Bypass the lifetime gate. Used by the safety timeout and the
  // call sites that genuinely want the overlay gone immediately
  // (e.g. video unloaded, click-to-play taking over).
  _hideSyncingOverlayNow() {
    if (this._syncingTimer) {
      clearTimeout(this._syncingTimer);
      this._syncingTimer = null;
    }
    if (this._syncingHideTimer) {
      clearTimeout(this._syncingHideTimer);
      this._syncingHideTimer = null;
    }
    const overlay = this.el.querySelector(".byob-syncing");
    if (!overlay) return;
    overlay.style.opacity = "0";
    setTimeout(() => overlay.remove(), 200);
  },

  // Tell the server we've loaded the current media item. Called
  // from each player adapter's onReady (which fires regardless of
  // whether autoplay succeeded) AND as a belt-and-suspenders signal
  // from the first stable state in _onPlayerStateChange. Idempotent
  // per item_id via _loadedReportedFor — autoplay-blocked peers
  // therefore still release the server's ready-then-play hold even
  // though they can't actually start playing until the user clicks.
  _signalLoaded() {
    const itemId = this._currentItemId;
    if (!itemId) return;
    if (this._loadedReportedFor === itemId) return;
    this._loadedReportedFor = itemId;
    this.pushEvent(LV_EVT.EV_VIDEO_LOADED, { item_id: itemId });
  },

  // Push a single drift report to the server. Called both by the
  // regular cadence interval AND immediately when a sync seek lands
  // (so SyncDecision can fire the next compensating seek without
  // waiting for the next cadence tick — typically ~250 ms shaved off
  // each cascade iteration). `observed_l_ms` and `_seekIssuedAt` are
  // cleared after sending so a stale value doesn't get re-applied.
  _pushDriftReport() {
    if (!this.player || !this.isReady) return;
    if (!this.clockSync?.isReady?.()) return;
    if (this._isLive) return;
    // Placeholder players (extension-required content with no real
    // <video> attached on this peer) have getCurrentTime = 0 forever.
    // Reporting that as drift would tell the server we're 136 s behind
    // a 136-s-into-the-video room, triggering an endless seek cascade
    // at a no-op shell. Stay silent — the extension peer in another
    // tab is the one actually playing and reporting drift.
    if (this.player?.isPlaceholder) return;
    const state = this.player.getState?.();
    const observedL = this._lastObservedL;
    this._lastObservedL = 0;
    this._seekIssuedAt = 0;

    // While paused the player position is frozen, but our expected
    // position calc (`serverPosition + wall-clock elapsed`) keeps
    // advancing — producing a sawtooth that ramps ever more
    // negative until the server fires a (pointless) sync seek to
    // "fix" it, which only resets the sawtooth and starts the cycle
    // over. Pin reported drift to 0 while paused so neither the
    // server's SyncDecision nor the panel sees fake drift.
    const isPaused =
      this.expectedPlayState === "paused" || state === "paused";

    // Always recompute drift from the current player position. The
    // reconcile loop's `lastDriftMs` only refreshes every 100 ms, so
    // an out-of-cadence post-seek report could otherwise ship the
    // PRE-seek value and trigger a spurious SyncDecision cascade.
    const driftMs = isPaused
      ? 0
      : (this.reconcile.measureDriftMs?.() ?? this.reconcile.lastDriftMs ?? 0);

    // Tell the server when this tab is sitting on a press-to-play
    // overlay — peers' user-list rows show a pause glyph for users
    // who haven't unlocked autoplay yet, so they know not to wait.
    const gestureBlocked = !!(
      this.el.querySelector(".byob-join-ready") ||
      this.el.querySelector(".byob-click-to-play")
    );
    this.pushEvent(LV_EVT.EV_VIDEO_DRIFT_REPORT, {
      drift_ms: Math.round(driftMs),
      offset_ms: 0, // legacy passthrough (extension still computes one)
      rtt_ms: Math.round(this.clockSync.getMedianRttMs?.() || 0),
      noise_floor_ms: Math.round(this.reconcile.noiseFloorEmaMs || 0),
      observed_l_ms: Math.round(observedL),
      gesture_blocked: gestureBlocked,
      playing: state === "playing",
    });
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
