/**
 * Create an extension placeholder player.
 *
 * This player has no real media element — it shows a placeholder UI and
 * the extension handles actual playback in an external window. Play/pause/seek
 * are no-ops since the extension manages state via its own channel.
 *
 * @param {HTMLElement} el - Container element
 * @param {object} callbacks - Hook callbacks
 * @param {object} opts - { title, thumbnailUrl }
 * @returns {object} player interface
 */
export function create(el, callbacks, opts) {
  const { title, thumbnailUrl } = opts;

  const thumbHtml = thumbnailUrl
    ? `<img src="${thumbnailUrl}" class="w-32 h-20 object-cover rounded opacity-80" />`
    : `<svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
        <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>`;

  el.innerHTML = `
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-base-content/60" id="ext-placeholder">
      ${thumbHtml}
      <p class="text-sm font-medium text-base-content/70 max-w-md text-center px-4 line-clamp-2" title="${title}">${title}</p>
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
  `;

  callbacks.onReady();

  return {
    raw: null,

    play() { /* no-op — extension manages playback */ },
    pause() { /* no-op */ },
    seek(_seconds) { /* no-op */ },
    destroy() {
      // Nothing to destroy — just UI
    },
    getCurrentTime() { return 0; },
    getDuration() { return 0; },
    setPlaybackRate(_rate) { /* no-op */ },
    getState() { return null; },
  };
}
