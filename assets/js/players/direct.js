/**
 * Create an HTML5 <video> element player.
 *
 * @param {HTMLElement} el - Container element
 * @param {object} callbacks - Hook callbacks
 * @param {object} opts - { url }
 * @returns {object} player interface
 */
export function create(el, callbacks, opts) {
  const { url } = opts;

  el.innerHTML = "";
  const video = document.createElement("video");
  video.src = url;
  video.controls = true;
  video.style.width = "100%";
  video.style.height = "100%";
  video.style.backgroundColor = "#000";
  video.preload = "auto";
  video.crossOrigin = "anonymous";

  el.appendChild(video);

  video.addEventListener("loadedmetadata", () => {
    callbacks.onReady();
  });

  video.addEventListener("play", () => {
    callbacks.onStateChange("playing");
  });

  video.addEventListener("pause", () => {
    callbacks.onStateChange("paused");
  });

  let programmaticSeekStartedAt = null;
  video.addEventListener("seeked", () => {
    // An older completion can arrive after another seek has started. Keep
    // ownership until the current seek finishes, rather than echoing it.
    if (video.seeking) return;
    if (programmaticSeekStartedAt !== null) {
      const elapsed = performance.now() - programmaticSeekStartedAt;
      programmaticSeekStartedAt = null;
      callbacks.onProgrammaticSeeked?.(elapsed);
      return;
    }
    callbacks.onSeeked(video.currentTime);
  });

  video.addEventListener("ended", () => {
    callbacks.onStateChange("ended");
  });

  return _wrap(video, () => { programmaticSeekStartedAt = performance.now(); });
}

function _wrap(video, markSeek) {
  return {
    raw: video,

    play() {
      video.play().catch(() => {});
    },
    pause() {
      video.pause();
    },
    seek(seconds) {
      // Match the actual seek completion instead of suppressing unrelated
      // native controls for a time window after play or pause.
      markSeek();
      video.currentTime = seconds;
    },
    destroy() {
      video.pause();
      video.removeAttribute("src");
      video.load();
    },
    getCurrentTime() {
      return video.currentTime || 0;
    },
    getDuration() {
      return video.duration || 0;
    },
    setPlaybackRate(rate) {
      video.playbackRate = rate;
    },
    getState() {
      if (video.ended) return "ended";
      return video.paused ? "paused" : "playing";
    },
  };
}
