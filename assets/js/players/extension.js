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
 * @param {HTMLElement} el - Container element (the player div)
 * @param {object} callbacks - Hook callbacks
 * @param {object} opts - { title, thumbnailUrl, url, hook }
 * @returns {object} player interface
 */
import { LV_EVT } from "../sync/event_names";

export function create(el, callbacks, opts) {
  const { title, thumbnailUrl, url, hook } = opts;

  const thumbHtml = thumbnailUrl
    ? `<img src="${thumbnailUrl}" class="w-32 h-20 object-cover rounded opacity-80" />`
    : `<svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
        <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>`;

  el.innerHTML = `
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-base-content/60 px-4" id="ext-placeholder">
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
      <div class="alert mt-1 w-auto max-w-md py-2 px-4 flex flex-col items-center gap-2 text-center">
        <button
          type="button"
          id="ext-open-btn-inline"
          class="btn btn-primary btn-sm gap-1"
        >
          <span data-byob-ext-btn-label>Open Player Window</span>
        </button>
        <p class="text-xs text-base-content/60 leading-snug">
          Extension required for this site.<br/>
          Click play on the video for the extension to hook it.
        </p>
      </div>
    </div>
  `;

  // Wire the inline button to the same popup flow ExtOpenBtn uses. Auth
  // context comes from the player div's data-* (rendered server-side in
  // room_live.ex). Label "Open" vs "Focus" derives from the room's
  // ready_count payload so it survives YT's COOP-broken
  // `_byobPlayerWindow.closed` lie.
  const btn = el.querySelector("#ext-open-btn-inline");
  const label = el.querySelector("[data-byob-ext-btn-label]");

  function userHasPopup() {
    if (!hook) return false;
    const username = el.dataset.username;
    const rc = hook._lastReadyCount;
    if (!username || !rc) return false;
    const needsOpen = Array.isArray(rc.needs_open) ? rc.needs_open : [];
    return !needsOpen.includes(username);
  }

  function refreshLabel() {
    if (!label) return;
    label.textContent = userHasPopup() ? "Focus Player Window" : "Open Player Window";
  }

  if (btn) {
    btn.addEventListener("click", () => {
      if (userHasPopup()) {
        window.postMessage({ type: LV_EVT.PW_FOCUS_EXTERNAL }, "*");
      } else {
        // Use window.location.origin so LAN-access sessions don't end up
        // with server_url=http://localhost:4000.
        window.postMessage({
          type: LV_EVT.PW_OPEN_EXTERNAL,
          url,
          room_id: el.dataset.roomId,
          server_url: window.location.origin,
          token: el.dataset.token,
          username: el.dataset.username,
        }, "*");
        window._byobPlayerWindow = window.open(
          url, "byob_player",
          "width=1280,height=800,menubar=no,toolbar=no,location=yes,status=no"
        );
      }
      setTimeout(refreshLabel, 100);
    });
  }

  refreshLabel();
  // Hook calls back into ours from _onReadyCount when ready_count lands.
  if (hook) hook._extPlaceholderRefreshLabel = refreshLabel;

  callbacks.onReady();

  return {
    raw: null,

    play() { /* no-op — extension manages playback */ },
    pause() { /* no-op */ },
    seek(_seconds) { /* no-op */ },
    destroy() {
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
