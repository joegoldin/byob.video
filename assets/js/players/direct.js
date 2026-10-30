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

  let programmaticSeekStartedAt = null;
  const pendingStates = [];
  const markState = state => {
    const marker = { state };
    pendingStates.push(marker);
    return () => { const index = pendingStates.indexOf(marker); if (index !== -1) pendingStates.splice(index, 1); };
  };
  const reportState = state => {
    const index = pendingStates.findIndex(marker => marker.state === state);
    const programmatic = index !== -1;
    if (index !== -1) pendingStates.splice(index, 1);
    callbacks.onStateChange(state, programmatic);
  };
  video.addEventListener("play", () => reportState("playing"));
  video.addEventListener("pause", () => reportState("paused"));

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

  video.addEventListener("ratechange", () => {
    callbacks.onPlaybackRateChange?.(video.playbackRate);
  });

  video.addEventListener("ended", () => {
    callbacks.onStateChange("ended");
  });

  return _wrap(video, () => { programmaticSeekStartedAt = performance.now(); }, markState);
}

function _wrap(video, markSeek, markState) {
  return {
    raw: video,

    play() {
      const cancel = video.paused ? markState("playing") : null;
      video.play().catch(() => cancel?.());
    },
    pause() {
      if (!video.paused) markState("paused");
      video.pause();
    },
    seek(seconds) {
      // Match the actual seek completion instead of suppressing unrelated
      // native controls for a time window after play or pause.
      markSeek();
      video.currentTime = seconds;
    },
    destroy() {
      if (!video.paused) markState("paused");
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
