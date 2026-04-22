/**
 * Vimeo player module — mirrors the YouTube player interface.
 *
 * Uses the Vimeo Player SDK (@vimeo/player) loaded via script tag.
 * All methods return the same interface as youtube.js's _wrap().
 */

let sdkPromise = null;

function loadVimeoSDK() {
  if (sdkPromise) return sdkPromise;
  if (window.Vimeo?.Player) return Promise.resolve(window.Vimeo.Player);

  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://player.vimeo.com/api/player.js";
    script.onload = () => {
      if (window.Vimeo?.Player) resolve(window.Vimeo.Player);
      else reject(new Error("Vimeo SDK loaded but Vimeo.Player not found"));
    };
    script.onerror = () => reject(new Error("Failed to load Vimeo SDK"));
    document.head.appendChild(script);
  });
  return sdkPromise;
}

/**
 * Create a Vimeo player.
 *
 * @param {HTMLElement} el - Container element
 * @param {object} callbacks - { onReady(player), onStateChange(name), onLoadStart() }
 * @param {object} opts - { videoId, shouldPlay, startSeconds }
 * @returns {Promise<object>} player interface
 */
export async function create(el, callbacks, opts) {
  const { videoId, shouldPlay, startSeconds } = opts;
  const VimeoPlayer = await loadVimeoSDK();

  el.innerHTML = "";
  const container = document.createElement("div");
  container.id = "vimeo-player";
  container.style.width = "100%";
  container.style.height = "100%";
  el.appendChild(container);

  const player = new VimeoPlayer(container, {
    id: videoId,
    width: "100%",
    autoplay: shouldPlay,
    muted: false,
  });

  // Internal state tracking (Vimeo SDK is promise-based, not sync)
  let currentState = "paused";
  let currentTime = 0;
  let duration = 0;

  player.on("play", () => {
    currentState = "playing";
    callbacks.onStateChange("playing");
  });

  player.on("pause", () => {
    currentState = "paused";
    callbacks.onStateChange("paused");
  });

  player.on("ended", () => {
    currentState = "ended";
    callbacks.onStateChange("ended");
  });

  player.on("bufferstart", () => {
    currentState = "buffering";
  });

  player.on("bufferend", () => {
    // Don't fire state change — let play/pause handle it
  });

  player.on("timeupdate", (data) => {
    currentTime = data.seconds;
    duration = data.duration;
  });

  // Seek to start position if specified
  if (startSeconds && startSeconds > 0) {
    try { await player.setCurrentTime(startSeconds); } catch (_) {}
  }

  const wrapped = {
    raw: player,

    play() {
      player.play().catch(() => {});
    },

    pause() {
      player.pause().catch(() => {});
    },

    seek(seconds) {
      player.setCurrentTime(seconds).catch(() => {});
    },

    destroy() {
      player.destroy().catch(() => {});
    },

    getCurrentTime() {
      return currentTime;
    },

    getDuration() {
      return duration;
    },

    setPlaybackRate(rate) {
      player.setPlaybackRate(rate).catch(() => {});
    },

    getState() {
      return currentState;
    },
  };

  // Wait for player to be ready
  await player.ready();

  // Get initial duration
  try { duration = await player.getDuration(); } catch (_) {}

  callbacks.onReady(wrapped);
  return wrapped;
}
