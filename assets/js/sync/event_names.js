// Named event strings used between the browser (LiveView hooks) and the
// server (push_event / handle_event). Single source of truth for values
// that must match Byob.Events on the Elixir side.
//
// The extension (extension/content.js + extension/background.js) has its
// own duplicated EVT table because MV3 content scripts can't use ES
// modules. When you change a name here, also update the extension tables.

export const LV_EVT = Object.freeze({
  // Server → browser (push_event in LV, handleEvent in hook)
  SYNC_STATE: "sync:state",
  SYNC_PLAY: "sync:play",
  SYNC_PAUSE: "sync:pause",
  SYNC_SEEK: "sync:seek",
  SYNC_PONG: "sync:pong",
  SYNC_CORRECTION: "sync:correction",
  SYNC_HEARTBEAT: "sync:heartbeat",
  SYNC_AUTOPLAY_COUNTDOWN: "sync:autoplay_countdown",
  SYNC_AUTOPLAY_CANCELLED: "sync:autoplay_cancelled",
  SPONSOR_SEGMENTS: "sponsor:segments",
  EXT_PLAYER_STATE: "ext:player-state",
  EXT_MEDIA_INFO: "ext:media-info",
  SB_SETTINGS: "sb:settings",
  VIDEO_CHANGE: "video:change",
  QUEUE_ENDED: "queue:ended",
  MEDIA_METADATA: "media:metadata",
  TOAST: "toast",
  READY_COUNT: "ready:count",
  LIVE_STATUS: "live:status",

  // Browser → server (pushEvent in hook, handle_event in LV)
  EV_VIDEO_PLAY: "video:play",
  EV_VIDEO_PAUSE: "video:pause",
  EV_VIDEO_SEEK: "video:seek",
  EV_VIDEO_ENDED: "video:ended",
  EV_VIDEO_EMBED_BLOCKED: "video:embed_blocked",
  EV_VIDEO_DRIFT_REPORT: "video:drift_report",
  EV_VIDEO_LIVE_STATUS: "video:live_status",
  EV_SYNC_PING: "sync:ping",

  // Page-world postMessage types (contract with extension/content.js)
  PW_EMBED_READY: "byob:embed-ready",
  PW_CLEAR_EXTERNAL: "byob:clear-external",
  PW_OPEN_EXTERNAL: "byob:open-external",
  PW_FOCUS_EXTERNAL: "byob:focus-external",
  PW_SPONSOR_SEGMENTS: "byob:sponsor-segments",
});
