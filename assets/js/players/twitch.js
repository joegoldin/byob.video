/**
 * Twitch player module — mirrors the YouTube/Vimeo player interface.
 *
 * Uses Twitch's official embed JS SDK (`Twitch.Player`) loaded via
 * script tag. Handles BOTH live channels (`{ channel: name }`) and
 * VODs (`{ video: id }`); the video_player.js hook decides which by
 * reading `mediaItem.is_live` and passing `kind` accordingly.
 *
 * Twitch's iframe requires a `parent` option whose hostname matches
 * the embedding host. We set it from `window.location.hostname` so
 * the same code works on byob.video, localhost, and any LAN dev IP.
 */

let sdkPromise = null;

function loadTwitchSDK() {
  if (sdkPromise) return sdkPromise;
  if (window.Twitch?.Player) return Promise.resolve(window.Twitch.Player);

  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://player.twitch.tv/js/embed/v1.js";
    script.onload = () => {
      if (window.Twitch?.Player) resolve(window.Twitch.Player);
      else reject(new Error("Twitch SDK loaded but Twitch.Player not found"));
    };
    script.onerror = () => reject(new Error("Failed to load Twitch SDK"));
    document.head.appendChild(script);
  });
  return sdkPromise;
}

/**
 * Create a Twitch player.
 *
 * @param {HTMLElement} el - Container element
 * @param {object} callbacks - { onReady(player), onStateChange(name) }
 * @param {object} opts - { sourceId, isLive, shouldPlay, startSeconds }
 *   - isLive=true: sourceId is a channel name (`shroud`)
 *   - isLive=false: sourceId is a VOD id (`12345...` — bare digits, no "v")
 * @returns {Promise<object>} player interface
 */
export async function create(el, callbacks, opts) {
  const { sourceId, isLive, shouldPlay, startSeconds } = opts;
  const TwitchPlayer = await loadTwitchSDK();

  el.innerHTML = "";
  const container = document.createElement("div");
  container.id = "twitch-player";
  container.style.width = "100%";
  container.style.height = "100%";
  el.appendChild(container);

  // Embedding host — Twitch's iframe rejects unless `parent` matches
  // the page's hostname. Using window.location.hostname dynamically
  // means the same code works on byob.video, localhost, and any IP
  // a LAN-access user lands on.
  const parents = [window.location.hostname].filter(Boolean);

  const playerOpts = {
    width: "100%",
    height: "100%",
    parent: parents,
    autoplay: !!shouldPlay,
    muted: false,
  };

  if (isLive) {
    playerOpts.channel = sourceId;
  } else {
    playerOpts.video = sourceId;
    if (startSeconds && startSeconds > 0) {
      // Twitch accepts time as either a number of seconds or "1h2m3s" form.
      playerOpts.time = `${Math.floor(startSeconds)}s`;
    }
  }

  const player = new TwitchPlayer(container, playerOpts);

  let currentState = "paused";
  let lastKnownTime = startSeconds || 0;

  player.addEventListener(TwitchPlayer.READY, () => {
    // Twitch loads in HD by default; force the iframe to fill the container
    // since the SDK occasionally renders with fixed pixel dimensions.
    const iframe = container.querySelector("iframe");
    if (iframe) {
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.border = "none";
    }
    callbacks.onReady(wrapped);
  });

  player.addEventListener(TwitchPlayer.PLAY, () => {
    currentState = "playing";
    callbacks.onStateChange("playing");
  });

  player.addEventListener(TwitchPlayer.PAUSE, () => {
    currentState = "paused";
    callbacks.onStateChange("paused");
  });

  player.addEventListener(TwitchPlayer.ENDED, () => {
    currentState = "ended";
    callbacks.onStateChange("ended");
  });

  // Twitch fires PLAYBACK_BLOCKED in regions where streams aren't available
  // (DMCA, geographic). Treat as ended so the queue advances rather than
  // hanging on a black frame forever.
  if (TwitchPlayer.PLAYBACK_BLOCKED) {
    player.addEventListener(TwitchPlayer.PLAYBACK_BLOCKED, () => {
      currentState = "ended";
      callbacks.onStateChange("ended");
    });
  }

  const wrapped = {
    raw: player,

    play() {
      try { player.play(); } catch (_) {}
    },

    pause() {
      try { player.pause(); } catch (_) {}
    },

    seek(seconds) {
      // Twitch.Player.seek is for VODs only; on a live channel it
      // silently no-ops (which is what we want — there's no shared
      // timeline to seek to).
      if (isLive) return;
      try { player.seek(seconds); } catch (_) {}
    },

    destroy() {
      // Twitch's SDK doesn't expose an explicit destroy(); blowing
      // away the container removes the iframe and the listeners
      // garbage-collect with the DOM nodes.
      try { container.remove(); } catch (_) {}
    },

    getCurrentTime() {
      try {
        const t = player.getCurrentTime();
        if (typeof t === "number" && !isNaN(t)) {
          lastKnownTime = t;
          return t;
        }
      } catch (_) {}
      return lastKnownTime;
    },

    getDuration() {
      try {
        const d = player.getDuration();
        if (typeof d === "number" && d > 0 && isFinite(d)) return d;
      } catch (_) {}
      return 0;
    },

    setPlaybackRate(_rate) {
      // Twitch's SDK doesn't expose rate control. The reconcile loop
      // will fall back to hard-seek corrections on drift.
    },

    getState() {
      // Twitch doesn't surface a synchronous "is playing/paused/buffering"
      // getter; use the locally tracked currentState that we update on
      // PLAY / PAUSE / ENDED events.
      return currentState;
    },

    isPlaceholder: false,
  };

  return wrapped;
}
