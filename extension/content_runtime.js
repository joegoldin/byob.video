(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.ByobContentRuntime = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createDrmCommandSequencer(options = {}) {
    const isDrmSite = !!options.isDrmSite;
    const settleDelayMs = options.settleDelayMs ?? 120;
    const queueWindowMs = options.queueWindowMs ?? 250;
    const releaseTimeoutMs = options.releaseTimeoutMs ?? 5000;
    const releasePollMs = options.releasePollMs ?? 100;
    const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    const log = options.log ?? (() => {});
    const shouldReleasePlay = options.shouldReleasePlay ?? defaultShouldReleasePlay;

    let queuedPlay = null;
    let queuedPlayTimer = null;
    let queuedReleaseTimer = null;
    let queuedReleaseDeadlineTimer = null;

    function clearQueuedPlay() {
      if (queuedPlayTimer != null) {
        clearTimeoutFn(queuedPlayTimer);
        queuedPlayTimer = null;
      }
      if (queuedReleaseTimer != null) {
        clearTimeoutFn(queuedReleaseTimer);
        queuedReleaseTimer = null;
      }
      if (queuedReleaseDeadlineTimer != null) {
        clearTimeoutFn(queuedReleaseDeadlineTimer);
        queuedReleaseDeadlineTimer = null;
      }
      queuedPlay = null;
    }

    function releaseQueuedPlay(reason) {
      const pending = queuedPlay;
      clearQueuedPlay();
      if (!pending) return false;
      log("DRM queued play release", reason, "target=", pending.position);
      pending.onPlay(reason);
      return true;
    }

    function armReadyRelease(video, position, pending = queuedPlay) {
      queuedReleaseDeadlineTimer = setTimeoutFn(() => {
        queuedReleaseDeadlineTimer = null;
        releaseQueuedPlay("ready-timeout");
      }, releaseTimeoutMs);
      queuedReleaseTimer = setTimeoutFn(function waitForReady() {
        queuedReleaseTimer = null;
        if (!queuedPlay || queuedPlay !== pending) return;
        if (shouldReleasePlay(video, position)) {
          releaseQueuedPlay("ready");
          return;
        }
        queuedReleaseTimer = setTimeoutFn(waitForReady, releasePollMs);
      }, settleDelayMs);
    }

    function queuePlayIfNeeded(video, position, onPlay = () => video.play(), options = {}) {
      const force = !!options.force;
      if (!isDrmSite || !video || !video.paused || position == null) return false;
      if (!force && Math.abs(video.currentTime - position) <= 0.5) return false;

      clearQueuedPlay();
      queuedPlay = { position, onPlay, video };
      queuedPlayTimer = setTimeoutFn(() => releaseQueuedPlay("timeout"), queueWindowMs);
      log("DRM queued play waiting for seek", "from=", video.currentTime, "to=", position);
      return true;
    }

    function queuePlayUntilReady(video, position, onPlay = () => video.play()) {
      if (!isDrmSite || !video || !video.paused || position == null) return false;

      clearQueuedPlay();
      queuedPlay = { position, onPlay, video };
      log("DRM queued play waiting for readiness", "target=", position);
      armReadyRelease(video, position, queuedPlay);
      return true;
    }

    function consumeMatchingSeek(video, position, onSeek = () => {
      video.currentTime = position;
    }) {
      if (!queuedPlay || !video || queuedPlay.video !== video) return false;
      if (Math.abs(position - queuedPlay.position) > 0.5) return false;

      if (queuedPlayTimer != null) {
        clearTimeoutFn(queuedPlayTimer);
        queuedPlayTimer = null;
      }

      const pending = queuedPlay;
      log("DRM queued play matched seek", "target=", position);
      onSeek();
      armReadyRelease(video, position, pending);
      return true;
    }

    return {
      queuePlayIfNeeded,
      queuePlayUntilReady,
      consumeMatchingSeek,
      clearQueuedPlay
    };
  }

  function createOutboundPlayCoordinator(options = {}) {
    const isDrmSite = !!options.isDrmSite;
    const delayMs = options.delayMs ?? 200;
    const seekDelayMs = options.seekDelayMs ?? 2500;
    const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    const log = options.log ?? (() => {});

    let queuedPlay = null;
    let queuedTimer = null;

    function cancel() {
      if (queuedTimer != null) {
        clearTimeoutFn(queuedTimer);
        queuedTimer = null;
      }
      queuedPlay = null;
    }

    function flush(reason, positionOverride = null) {
      const pending = queuedPlay;
      cancel();
      if (!pending) return false;
      const position = positionOverride ?? pending.position;
      log("Deferred outbound play release", reason, "pos=", position);
      pending.onSend(position);
      return true;
    }

    function queue(position, onSend) {
      if (!isDrmSite) return false;
      cancel();
      queuedPlay = { position, onSend, waitingForSeek: false };
      queuedTimer = setTimeoutFn(() => flush("timeout"), delayMs);
      return true;
    }

    function noteSeeking(position = null) {
      if (!queuedPlay) return false;
      if (queuedTimer != null) {
        clearTimeoutFn(queuedTimer);
      }
      queuedPlay.waitingForSeek = true;
      queuedTimer = setTimeoutFn(() => flush("seek-timeout", position), seekDelayMs);
      log("Deferred outbound play waiting for seeked", "pos=", position ?? queuedPlay.position);
      return true;
    }

    return { queue, flush, cancel, noteSeeking };
  }

  function applyPauseAtPosition(video, position, options = {}) {
    if (!video) return false;

    const pause = options.pause ?? (() => {
      if (!video.paused && typeof video.pause === "function") video.pause();
    });
    const applySeek = options.applySeek ?? ((target) => {
      if (target != null) video.currentTime = target;
    });

    const wasPaused = !!video.paused;

    if (position != null && Math.abs(video.currentTime - position) >= 0.1) {
      applySeek(position);
    }

    if (!wasPaused) {
      pause();
    }

    return true;
  }

  function defaultShouldReleasePlay(video, position) {
    if (!video) return true;
    if (video.seeking) return false;
    if ((video.readyState ?? 0) < 3) return false;

    const target = position ?? video.currentTime;
    const buffered = video.buffered;
    if (!buffered || typeof buffered.length !== "number") return true;

    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= target && buffered.end(i) >= target + 0.05) {
        return true;
      }
    }

    return false;
  }

  return { createDrmCommandSequencer, createOutboundPlayCoordinator, applyPauseAtPosition };
});
