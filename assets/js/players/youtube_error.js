/**
 * YouTube embed error handler — builds fallback UI when a video can't be embedded
 * (age-restricted, embedding disabled by uploader, etc.).
 *
 * Error codes: 100 = not found, 101/150 = embedding restricted.
 */
import { LV_EVT } from "../sync/event_names";

const YT_ERR_NOT_FOUND = 100;
const YT_ERR_EMBED_DISABLED_1 = 101;
const YT_ERR_EMBED_DISABLED_2 = 150;
const EXT_POLL_INTERVAL_MS = 2000;

/**
 * Handle a YouTube IFrame API error event.
 *
 * @param {object} ctx - Hook context with: sourceId, _lastTitle, _lastThumb,
 *                        player, el, _extPollInterval, _embedBlocked, pushEvent
 * @param {object} event - YT error event ({ data: errorCode })
 */
export function handleYTError(ctx, event) {
  const code = event.data;
  if (code !== YT_ERR_NOT_FOUND && code !== YT_ERR_EMBED_DISABLED_1 && code !== YT_ERR_EMBED_DISABLED_2) return;

  ctx._embedBlocked = true;
  const videoId = ctx.sourceId;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const title = ctx._lastTitle || url;
  const thumb = ctx._lastThumb;

  // Destroy the broken player
  if (ctx.player && ctx.player.destroy) {
    try { ctx.player.destroy(); } catch (_) {}
  }
  ctx.player = null;

  // Detect extension from page attribute (set by extension content script)
  const hasExtension = document.documentElement.hasAttribute("data-byob-extension");

  const container = _buildFallbackUI(title, thumb, url, hasExtension);

  ctx.el.innerHTML = "";
  ctx.el.appendChild(container);

  // Poll for extension install — update UI when detected
  if (!hasExtension) {
    ctx._extPollInterval = setInterval(() => {
      if (document.documentElement.hasAttribute("data-byob-extension")) {
        clearInterval(ctx._extPollInterval);
        ctx._extPollInterval = null;
        handleYTError(ctx, { data: code });
      }
    }, EXT_POLL_INTERVAL_MS);
  }

  ctx.pushEvent(LV_EVT.EV_VIDEO_EMBED_BLOCKED, { video_id: videoId, url });
}

function _buildFallbackUI(title, thumb, url, hasExtension) {
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
    const extBtn = document.createElement("a");
    extBtn.className = "btn btn-sm btn-primary gap-1";
    extBtn.style.cursor = "pointer";
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

  return container;
}
