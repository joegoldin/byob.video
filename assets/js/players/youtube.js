import { loadYouTubeAPI } from "../lib/youtube_loader";

// YouTube player state constants
const YT_UNSTARTED = -1;
const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;
const YT_CUED = 5;

export { YT_UNSTARTED, YT_ENDED, YT_PLAYING, YT_PAUSED, YT_BUFFERING, YT_CUED };

/**
 * Create a YouTube IFrame API player.
 *
 * @param {HTMLElement} el - Container element
 * @param {object} callbacks - Hook callbacks
 * @param {object} opts - { videoId, shouldPlay, startSeconds, reuse (existing YT player or null) }
 * @returns {Promise<object>} player interface
 */
export async function create(el, callbacks, opts) {
  const { videoId, shouldPlay, startSeconds, reuse } = opts;
  const YT = await loadYouTubeAPI();

  // Reuse existing player if possible — preserves user gesture context for autoplay
  if (reuse && reuse.loadVideoById) {
    callbacks.onLoadStart();
    const start = startSeconds && startSeconds > 0 ? { startSeconds } : {};
    if (shouldPlay) {
      reuse.loadVideoById({ videoId, ...start });
    } else {
      reuse.cueVideoById({ videoId, ...start });
    }
    const wrapped = _wrap(reuse);
    callbacks.onReady();
    return wrapped;
  }

  // First time — create player from scratch
  return new Promise((resolve) => {
    el.innerHTML = "";
    const container = document.createElement("div");
    container.id = "yt-player";
    el.appendChild(container);

    // `start` in playerVars accepts integer seconds. Drop fractional tail —
    // the drift reconcile loop tightens up to sub-second precision after load.
    const startInt =
      startSeconds && startSeconds > 0 ? Math.floor(startSeconds) : undefined;

    const rawPlayer = new YT.Player("yt-player", {
      videoId: videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: shouldPlay ? 1 : 0,
        controls: 1,
        modestbranding: 1,
        rel: 0,
        ...(startInt ? { start: startInt } : {}),
      },
      events: {
        onReady: () => {
          const iframe = el.querySelector("iframe");
          if (iframe) {
            iframe.style.width = "100%";
            iframe.style.height = "100%";
            iframe.allow = "autoplay; encrypted-media; picture-in-picture";
          }
          const wrapped = _wrap(rawPlayer);
          callbacks.onReady();
          resolve(wrapped);
        },
        onStateChange: (event) => _onStateChange(event, callbacks),
        onError: (event) => callbacks.onError(event),
      },
    });
  });
}

function _wrap(rawPlayer) {
  return {
    // Expose raw player for YT-specific operations (cueVideoById, getPlayerState, etc.)
    raw: rawPlayer,

    play() {
      if (rawPlayer.playVideo) rawPlayer.playVideo();
    },
    pause() {
      if (rawPlayer.pauseVideo) rawPlayer.pauseVideo();
    },
    seek(seconds) {
      if (rawPlayer.seekTo) rawPlayer.seekTo(seconds, true);
    },
    destroy() {
      if (rawPlayer.destroy) rawPlayer.destroy();
    },
    getCurrentTime() {
      return rawPlayer.getCurrentTime ? rawPlayer.getCurrentTime() : 0;
    },
    getDuration() {
      return rawPlayer.getDuration ? rawPlayer.getDuration() : 0;
    },
    setPlaybackRate(rate) {
      if (rawPlayer.setPlaybackRate) rawPlayer.setPlaybackRate(rate);
    },
    getState() {
      if (!rawPlayer.getPlayerState) return null;
      const s = rawPlayer.getPlayerState();
      if (s === YT_PLAYING) return "playing";
      if (s === YT_PAUSED) return "paused";
      if (s === YT_BUFFERING) return "buffering";
      if (s === YT_ENDED) return "ended";
      return null;
    },
    getPlayerState() {
      return rawPlayer.getPlayerState ? rawPlayer.getPlayerState() : null;
    },
    cueVideoById(opts) {
      if (rawPlayer.cueVideoById) rawPlayer.cueVideoById(opts);
    },
    loadVideoById(id) {
      if (rawPlayer.loadVideoById) rawPlayer.loadVideoById(id);
    },
  };
}

function _onStateChange(event, callbacks) {
  const state = event.data;

  // Map YT state to our state names for suppression
  let stateName = null;
  if (state === YT_PLAYING) stateName = "playing";
  else if (state === YT_PAUSED) stateName = "paused";
  else if (state === YT_ENDED) stateName = "ended";

  // Buffering means a seek or rebuffer is happening — pause reconcile
  // so it doesn't fight the position change before PLAYING fires
  if (state === YT_BUFFERING) {
    callbacks.onBuffering();
    return;
  }

  if (stateName) {
    callbacks.onStateChange(stateName);
  }
}
