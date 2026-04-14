/**
 * SponsorBlock — segment caching, filtering, skip detection, and bar rendering.
 *
 * All functions receive the state they need explicitly so this module stays
 * stateless and easy to test.
 */

const CATEGORY_DEFAULTS = {
  sponsor: "auto_skip",
  selfpromo: "show_bar",
  interaction: "show_bar",
  intro: "show_bar",
  outro: "show_bar",
  preview: "show_bar",
  music_offtopic: "disabled",
  filler: "show_bar",
};

function getSetting(sbSettings, category) {
  if (sbSettings && sbSettings[category]) return sbSettings[category];
  return CATEGORY_DEFAULTS[category] || "disabled";
}

/**
 * Process incoming sponsor segment data and return computed state.
 *
 * @param {Object}  data        – payload from `sponsor:segments` event
 * @param {Object}  sbSettings  – per-category user settings
 * @param {Function} getDuration – () => number, returns player duration (0 if unknown)
 * @returns {{ sponsorSegments, barSegments, duration }}
 */
export function applySponsorSettings(data, sbSettings, getDuration) {
  if (!data) return { sponsorSegments: [], barSegments: [], duration: 0 };

  const allSegments = data.segments || [];

  const sponsorSegments = allSegments.filter(
    (s) => getSetting(sbSettings, s.category) === "auto_skip"
  );
  const barSegments = allSegments.filter(
    (s) => getSetting(sbSettings, s.category) !== "disabled"
  );

  const playerDur = getDuration();
  const apiDur = data.duration || 0;
  const segDur = allSegments.reduce(
    (max, s) => Math.max(max, s.segment?.[1] || 0),
    0
  );
  const duration =
    playerDur > 0 ? playerDur : apiDur > 0 ? apiDur : segDur;

  return { sponsorSegments, barSegments, duration };
}

/**
 * Post segment data to a YouTube embed iframe via postMessage.
 *
 * @param {HTMLElement} el        – hook root element containing the iframe
 * @param {Array}       segments  – bar segments
 * @param {number}      duration  – video duration
 */
export function sendSegmentsToEmbed(el, segments, duration) {
  if (!segments || !duration) return;
  const iframe = el.querySelector("iframe");
  if (iframe) {
    iframe.contentWindow.postMessage(
      {
        type: "byob:sponsor-segments",
        segments,
        duration,
      },
      "*"
    );
  }
}

/**
 * Retry sending sponsor bar data until the player reports a positive duration.
 *
 * @param {Object} ctx – object with: player, _lastSponsorData, sbSettings,
 *                        _sponsorBarSegments, _sponsorBarDuration,
 *                        el, and the applySponsorSettingsFull callback
 * @param {number} attempt – current attempt (0-based)
 */
export function retrySponsorBar(ctx, attempt = 0) {
  if (!ctx._lastSponsorData || attempt > 4) return;
  const dur = ctx.player?.getDuration?.() || 0;
  if (dur > 0) {
    ctx._applySponsorSettingsFull();
  } else {
    setTimeout(() => retrySponsorBar(ctx, attempt + 1), 250);
  }
}

/**
 * Check current position against skip-list segments and skip if inside one.
 * Intended to run on a 250ms interval.
 *
 * @param {number} pos               – current playback position
 * @param {Array}  sponsorSegments   – segments with auto_skip setting
 * @param {string|null} lastSkippedUUID – UUID of the last segment we skipped
 * @param {Function} seekTo          – (seconds) => void
 * @param {Function} showSkipToast   – (category) => void
 * @returns {string|null} updated lastSkippedUUID
 */
export function checkSponsorSkip(
  pos,
  sponsorSegments,
  lastSkippedUUID,
  seekTo,
  showSkipToast
) {
  if (!sponsorSegments || sponsorSegments.length === 0) return lastSkippedUUID;
  for (const seg of sponsorSegments) {
    if (pos >= seg.segment[0] && pos < seg.segment[1] - 0.5) {
      if (lastSkippedUUID !== seg.uuid) {
        seekTo(seg.segment[1]);
        showSkipToast(seg.category);
        return seg.uuid;
      }
      break;
    }
  }
  return lastSkippedUUID;
}
