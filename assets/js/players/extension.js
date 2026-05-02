/**
 * Create an extension placeholder player.
 *
 * This player has no real media element — it shows a placeholder UI and
 * the extension handles actual playback in an external window. Play/pause/seek
 * are no-ops since the extension manages state via its own channel.
 *
 * The placeholder also renders the "Open / Focus Player Window" button
 * inside the black box itself so it's always visible regardless of how
 * the surrounding sidebar / banner reflows. The button reads its auth
 * context (room_id, token, username, server URL) from the parent
 * `#player` element's data-* attributes (set in room_live.ex), and the
 * "Open / Focus" label is driven by the same server `ready_count`
 * payload the LV's ExtOpenBtn used to consume — passed in via
 * `opts.hook` so the button stays in sync with the popup state.
 *
 * If the extension isn't installed (no `data-byob-extension` on
 * <html>), we render a "Get Extension" CTA instead — same pattern as
 * the YouTube embed-blocked fallback in players/youtube_error.js. A
 * 2 s poll flips the UI to the open-window state as soon as the
 * content script attaches the attribute.
 *
 * @param {HTMLElement} el - Container element (the player div)
 * @param {object} callbacks - Hook callbacks
 * @param {object} opts - { title, thumbnailUrl, url, hook }
 * @returns {object} player interface
 */
import { LV_EVT } from "../sync/event_names";

const EXT_POLL_INTERVAL_MS = 2000;
const STORE_URL_FIREFOX =
  "https://addons.mozilla.org/en-US/firefox/addon/byob-bring-your-own-binge/";
const STORE_URL_CHROME =
  "https://chromewebstore.google.com/detail/jlpogmjckejgpbbfhafgjgkbnocjfbmb";

function hasExtension() {
  return document.documentElement.hasAttribute("data-byob-extension");
}

function storeUrl() {
  return /Firefox/.test(navigator.userAgent) ? STORE_URL_FIREFOX : STORE_URL_CHROME;
}

export function create(el, callbacks, opts) {
  const { title, thumbnailUrl, url, hook } = opts;

  const thumbHtml = thumbnailUrl
    ? `<img src="${thumbnailUrl}" class="w-32 h-20 object-cover rounded opacity-80" />`
    : `<svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
        <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>`;

  function render() {
    const installed = hasExtension();

    const ctaHtml = installed
      ? `
        <button
          type="button"
          id="ext-open-btn-inline"
          class="btn btn-primary btn-sm gap-1 flex-shrink-0"
        >
          <span data-byob-ext-btn-label>Open Player Window</span>
        </button>
        <p class="text-xs text-base-content/60 leading-snug flex-1 text-left">
          Extension required for this site.<br/>
          Click play on the video for the extension to hook it.
        </p>
      `
      : `
        <a
          id="ext-install-btn-inline"
          href="${storeUrl()}"
          target="_blank"
          rel="noopener"
          class="btn btn-primary btn-sm gap-1 flex-shrink-0"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/>
          </svg>
          Get Extension
        </a>
        <p class="text-xs text-base-content/60 leading-snug flex-1 text-left">
          This site needs the byob extension to sync.<br/>
          Install it, then refresh this tab.
        </p>
      `;

    el.innerHTML = `
      <div class="absolute inset-0 flex flex-col items-center text-base-content/60 px-4 py-6" id="ext-placeholder">
        <div class="flex-1 flex flex-col items-center justify-center gap-3 min-h-0">
          ${thumbHtml}
          <p class="text-sm font-medium text-base-content/70 max-w-md text-center line-clamp-2" title="${title}">${title}</p>
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
        <div class="alert mt-6 w-full max-w-md px-5 py-3 flex flex-row items-center gap-4">
          ${ctaHtml}
        </div>
      </div>
    `;

    if (installed) wireOpenBtn();
  }

  // Wire the inline button to the same popup flow ExtOpenBtn uses. Auth
  // context comes from the player div's data-* (rendered server-side in
  // room_live.ex). Label "Open" vs "Focus" derives from the room's
  // ready_count payload so it survives YT's COOP-broken
  // `_byobPlayerWindow.closed` lie.
  function wireOpenBtn() {
    const btn = el.querySelector("#ext-open-btn-inline");
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (userHasPopup()) {
        window.postMessage({ type: LV_EVT.PW_FOCUS_EXTERNAL }, "*");
      } else {
        // username deliberately omitted — server resolves from the
        // signed token's owner_user_id.
        window.postMessage({
          type: LV_EVT.PW_OPEN_EXTERNAL,
          url,
          room_id: el.dataset.roomId,
          server_url: window.location.origin,
          token: el.dataset.token,
        }, "*");
        window._byobPlayerWindow = window.open(
          url, "byob_player",
          "width=1280,height=800,menubar=no,toolbar=no,location=yes,status=no"
        );
      }
      setTimeout(refreshLabel, 100);
    });
  }

  // Server-pushed boolean. Computed in pubsub.ex's handle_ready_count
  // via `@user_id in users_with_open_tabs`, where open_tabs is keyed
  // by the owner LV peer's user_id (see room_server.ex). No usernames
  // anywhere in the comparison path — immune to rename and the
  // phx-update="ignore" stale-dataset trap.
  function userHasPopup() {
    return hook?._lastReadyCount?.i_have_popup === true;
  }

  function refreshLabel() {
    const label = el.querySelector("[data-byob-ext-btn-label]");
    if (!label) return;
    label.textContent = userHasPopup() ? "Focus Player Window" : "Open Player Window";
  }

  render();
  refreshLabel();

  // Belt-and-braces: tell the BG to push a fresh tabs_resync to the
  // server so the placeholder's "Open / Focus" label reflects the
  // BG's actual hookedTabs (not whatever the server has cached).
  // Carry the room/server/token config so the BG can RE-ESTABLISH
  // the channel if it died (Chrome MV3 SW suspension): without
  // config the BG would receive the request, find `channel` null,
  // and silently no-op — leaving the user's stale-Focus button
  // permanent until they re-open a popup.
  try {
    window.postMessage({
      type: LV_EVT.PW_REQUEST_TAB_RESYNC,
      room_id: el.dataset.roomId,
      server_url: window.location.origin,
      token: el.dataset.token,
      // Deliberately NOT passing data-username — see content.js for why.
    }, "*");
  } catch (_) {}

  // Poll for extension install — when the content script attaches
  // `data-byob-extension` we re-render to swap the install CTA for the
  // open-window button.
  let installPollInterval = null;
  if (!hasExtension()) {
    installPollInterval = setInterval(() => {
      if (hasExtension()) {
        clearInterval(installPollInterval);
        installPollInterval = null;
        render();
        refreshLabel();
      }
    }, EXT_POLL_INTERVAL_MS);
  }

  // Hook calls back into ours from _onReadyCount when ready_count lands.
  if (hook) hook._extPlaceholderRefreshLabel = refreshLabel;

  // Defer onReady so the caller's `this.player = create(...)` assignment
  // completes BEFORE _applyPendingState runs and checks isPlaceholder.
  // Without this defer, the loading pill's `this.player?.isPlaceholder`
  // guard reads `null` (player not yet assigned) and the pill flashes
  // up over our placeholder UI.
  queueMicrotask(() => callbacks.onReady());

  return {
    // Marker for the VideoPlayer hook: this is the inert "Open
    // Player Window" placeholder, not a real player. The hook skips
    // drift reports for placeholder peers so a fixed `getCurrentTime
    // = 0` doesn't get reported as a multi-second drift against the
    // server's advancing clock — which would otherwise trigger
    // SyncDecision to cascade seeks at a no-op shell forever.
    isPlaceholder: true,
    raw: null,

    play() { /* no-op — extension manages playback */ },
    pause() { /* no-op */ },
    seek(_seconds) { /* no-op */ },
    destroy() {
      if (installPollInterval) {
        clearInterval(installPollInterval);
        installPollInterval = null;
      }
      if (hook && hook._extPlaceholderRefreshLabel === refreshLabel) {
        hook._extPlaceholderRefreshLabel = null;
      }
    },
    getCurrentTime() { return 0; },
    getDuration() { return 0; },
    setPlaybackRate(_rate) { /* no-op */ },
    getState() { return null; },
  };
}
