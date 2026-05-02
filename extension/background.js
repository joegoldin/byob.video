// WatchParty service worker — holds content script ports + Phoenix Channel connection
import { Socket } from "./lib/phoenix.mjs";

// Named event strings. Mirrors the EVT object in extension/content.js and
// Byob.Events on the server. MV3 content scripts can't import ES modules,
// so this table is duplicated rather than shared.
const EVT = Object.freeze({
  // Port name
  PORT_NAME: "watchparty",

  // content.js → background.js
  CONNECT: "connect",
  DEBUG_LOG: "debug:log",
  VIDEO_HOOKED: "video:hooked",
  VIDEO_STATE: "video:state",
  VIDEO_PLAY: "video:play",
  VIDEO_PAUSE: "video:pause",
  VIDEO_SEEK: "video:seek",
  VIDEO_ENDED: "video:ended",
  VIDEO_READY: "video:ready",
  VIDEO_DRIFT: "video:drift",
  VIDEO_LOADED: "video:loaded",
  VIDEO_LIVE_STATUS: "video:live_status",
  VIDEO_REQUEST_SYNC: "video:request-sync",
  VIDEO_UPDATE_URL: "video:update_url",

  // background.js → content.js
  COMMAND_PLAY: "command:play",
  COMMAND_PAUSE: "command:pause",
  COMMAND_INITIAL_STATE: "command:initial-state",
  COMMAND_SYNCED: "command:synced",
  COMMAND_QUEUE_ENDED: "command:queue-ended",
  COMMAND_VIDEO_CHANGE: "command:video-change",
  COMMAND_LIVE_STATUS: "command:live-status",
  SYNC_CORRECTION: "sync:correction",
  SYNC_SEEK_COMMAND: "sync:seek_command",
  AUTOPLAY_COUNTDOWN: "autoplay:countdown",
  AUTOPLAY_CANCELLED: "autoplay:cancelled",

  // Channel IN (background.js → server)
  CHAN_VIDEO_PLAY: "video:play",
  CHAN_VIDEO_PAUSE: "video:pause",
  CHAN_VIDEO_SEEK: "video:seek",
  CHAN_VIDEO_ENDED: "video:ended",
  CHAN_VIDEO_STATE: "video:state",
  CHAN_VIDEO_MEDIA_INFO: "video:media_info",
  CHAN_VIDEO_READY: "video:ready",
  CHAN_VIDEO_UNREADY: "video:unready",
  CHAN_VIDEO_DRIFT: "video:drift",
  CHAN_VIDEO_LOADED: "video:loaded",
  CHAN_VIDEO_LIVE_STATUS: "video:live_status",
  CHAN_VIDEO_TAB_OPENED: "video:tab_opened",
  CHAN_VIDEO_TAB_CLOSED: "video:tab_closed",
  CHAN_VIDEO_ALL_CLOSED: "video:all_closed",
  CHAN_SYNC_PING: "sync:ping",
  CHAN_SYNC_REQUEST_STATE: "sync:request_state",
  CHAN_DEBUG_LOG: "debug:log",
  CHAN_VIDEO_UPDATE_URL: "video:update_url",

  // Channel OUT (server → background.js subscribers)
  CHAN_SYNC_PLAY: "sync:play",
  CHAN_SYNC_PAUSE: "sync:pause",
  CHAN_SYNC_CORRECTION: "sync:correction",
  CHAN_SYNC_SEEK_COMMAND: "sync:seek_command",
  CHAN_AUTOPLAY_COUNTDOWN: "autoplay:countdown",
  CHAN_AUTOPLAY_CANCELLED: "autoplay:cancelled",
  CHAN_READY_COUNT: "ready:count",
  CHAN_ROOM_PRESENCE: "room:presence",
  CHAN_VIDEO_CHANGE: "video:change",
  CHAN_QUEUE_ENDED: "queue:ended",
  CHAN_QUEUE_UPDATED: "queue:updated",
  CHAN_LIVE_STATUS: "live:status",

  // Extension-internal broadcasts
  BYOB_VIDEO_HOOKED: "byob:video-hooked",
  BYOB_USER_ACTIVE: "byob:user-active",
  BYOB_FOCUS_EXTERNAL: "byob:focus-external",
  BYOB_OPEN_EXTERNAL: "byob:open-external",
  BYOB_CHECK_MANAGED: "byob:check-managed",
  BYOB_CHANNEL_READY: "byob:channel-ready",
  BYOB_CLOCK_SYNC: "byob:clock-sync",
  BYOB_PRESENCE: "byob:presence",
  BYOB_BAR_UPDATE: "byob:bar-update",
  BYOB_READY_COUNT: "byob:ready-count",
});

// Tabs the user opened *from a byob room* are tracked so the content
// script only activates sync there. Without this, any stale chrome
// .storage.local entry let us hook into tabs opened by other tools
// (e.g. another sync extension's external-player popup), which is
// the exact issue Chrome reviewers + users have flagged.
//
// Two-stage tracking handles the unavoidable race between
//   1. byob.video page postMessage("byob:open-external") →
//      content script forwards to BG
//   2. window.open() → new tab created → its content script runs
//
// Either ordering is fine: we record the *opener* tabId on (1), and
// when the new tab's content script later asks BYOB_CHECK_MANAGED
// we resolve via sender.tab.openerTabId. byobManagedTabs is the
// authoritative set; pendingByobOpens is the inbox.
//
// Single popup at a time — when a new BYOB_OPEN_EXTERNAL arrives
// the BG closes any existing managed popup tabs first, then
// stores the new pending entry. Map keyed by openerTabId is fine
// because only one popup ever exists for a given byob tab.
const pendingByobOpens = new Map(); // openerTabId -> {config, expiresAt}
const PENDING_OPEN_TTL_MS = 30000;
const MANAGED_TABS_STORAGE_KEY = "byob_managed_tabs";
let byobManagedTabs = new Map(); // tabId -> config (mirror of session storage)
let managedTabsLoaded = null;

async function loadManagedTabs() {
  if (managedTabsLoaded) return managedTabsLoaded;
  managedTabsLoaded = (async () => {
    try {
      const result = await chrome.storage.session.get(MANAGED_TABS_STORAGE_KEY);
      const obj = result[MANAGED_TABS_STORAGE_KEY] || {};
      byobManagedTabs = new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
    } catch (_) {
      byobManagedTabs = new Map();
    }
  })();
  return managedTabsLoaded;
}

async function persistManagedTabs() {
  const obj = Object.fromEntries(byobManagedTabs);
  try {
    await chrome.storage.session.set({ [MANAGED_TABS_STORAGE_KEY]: obj });
  } catch (_) {}
}

function hostnameOf(url) {
  if (!url || typeof url !== "string") return null;
  try { return new URL(url).hostname; } catch { return null; }
}

function expirePendingOpens() {
  const now = Date.now();
  for (const [k, v] of pendingByobOpens) {
    if (v.expiresAt < now) pendingByobOpens.delete(k);
  }
}

// Eager load so chrome.tabs.onRemoved handlers can read fresh state
// without an await race.
loadManagedTabs();

// Timings (ms)
const CLOCK_SYNC_BURST_SAMPLES = 5;
const CLOCK_SYNC_PING_INTERVAL_MS = 100;
const CLOCK_SYNC_MAINTAIN_MS = 30000;
const SOCKET_HEARTBEAT_MS = 20000;
const CONNECT_COOLDOWN_MS = 3000;
const AUTOPLAY_DEFAULT_COUNTDOWN_MS = 5000;

const ports = []; // all connected ports — each entry is { port, tabId }
let socket = null;
let channel = null;
let currentRoomId = null;
let lastReadyCount = null;
let currentServerUrl = null;
let initialRoomState = null;
let lastConnectAt = 0;
let autoplayCountdownActive = false;
// Canonical URL of the room's current media item. Set on join and updated on
// video:change / queue:updated. Sent to content scripts so they can detect
// when a tab has navigated away (SPA or manual) and show the URL-mismatch
// toast.
let currentSyncedUrl = null;
let currentSourceType = null;
let currentQueueSize = 0;
let currentIsLive = false;
let currentItemId = null;

// NTP-style clock sync state.
// serverMonotonicMs ≈ Date.now() + clockOffset
let clockOffset = 0;
let clockRtt = 0;
let clockSyncTimer = null;

// Tabs that have reported video:hooked. Used to drive video:tab_opened so
// the server's open_tabs tracks "tabs with an actual player" rather than
// "every content-script port". Pages where content.js runs but no video
// is hooked (e.g. a CR browse page, a non-player iframe) never get
// registered as a player tab, so closing them doesn't confuse the
// ready-count tooltip / presence toast logic.
const hookedTabs = new Set();

// chrome.tabs.onRemoved fires reliably from the browser regardless of SW
// suspension state — port.onDisconnect can be missed if the SW was idle
// when the tab closed. This is the belt-and-braces signal that flushes
// hookedTabs and notifies the server, so ready_count flips back to
// "needs to open" and the LV's ExtOpenBtn / YT-fallback labels update.
chrome.tabs.onRemoved.addListener((tabId) => {
  const wasHooked = hookedTabs.has(tabId);
  const wasManaged = byobManagedTabs.has(tabId);
  console.log(
    `[byob/bg] tabs.onRemoved tabId=${tabId} hooked=${wasHooked} managed=${wasManaged} channel=${!!channel}`
  );
  for (let i = ports.length - 1; i >= 0; i--) {
    if (ports[i].tabId === tabId) ports.splice(i, 1);
  }
  if (wasHooked) {
    hookedTabs.delete(tabId);
    if (channel) {
      try {
        channel.push(EVT.CHAN_VIDEO_TAB_CLOSED, { tab_id: String(tabId) });
        channel.push(EVT.CHAN_VIDEO_UNREADY, { tab_id: String(tabId) });
        console.log(`[byob/bg] tabs.onRemoved → pushed tab_closed + unready for tab ${tabId}`);
      } catch (e) {
        console.log(`[byob/bg] tabs.onRemoved push error:`, e);
      }
    }
  }
  // The byob room that opened this tab is gone OR the popup itself
  // closed — either way the marking is no longer relevant. Drop both
  // managed-tab state and any in-flight pending open keyed by this
  // tab as the opener.
  if (wasManaged) {
    byobManagedTabs.delete(tabId);
    persistManagedTabs();
  }
  if (pendingByobOpens.has(tabId)) {
    pendingByobOpens.delete(tabId);
  }
});

// Firefox occasionally doesn't fire tabs.onRemoved for popup windows
// closed via the window's own close button — only windows.onRemoved.
// Listen for both and let the same per-tab cleanup path run from
// either signal. Each window contains its own tab(s); we look up
// which were hooked and notify the server for them.
if (chrome.windows && chrome.windows.onRemoved && chrome.windows.onRemoved.addListener) {
  chrome.windows.onRemoved.addListener((windowId) => {
    console.log(`[byob/bg] windows.onRemoved windowId=${windowId}`);
    // Walk our hookedTabs and check which ones live in this window.
    // We don't keep a windowId index, so query each tab — those that
    // 404 (already gone) are the ones whose window just closed.
    const tabIds = [...hookedTabs];
    for (const tabId of tabIds) {
      try {
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            console.log(`[byob/bg] windows.onRemoved → tab ${tabId} gone, cleaning up`);
            // Replicate tabs.onRemoved cleanup for this orphaned tab.
            for (let i = ports.length - 1; i >= 0; i--) {
              if (ports[i].tabId === tabId) ports.splice(i, 1);
            }
            hookedTabs.delete(tabId);
            if (channel) {
              try {
                channel.push(EVT.CHAN_VIDEO_TAB_CLOSED, { tab_id: String(tabId) });
                channel.push(EVT.CHAN_VIDEO_UNREADY, { tab_id: String(tabId) });
              } catch (_) {}
            }
            if (byobManagedTabs.has(tabId)) {
              byobManagedTabs.delete(tabId);
              persistManagedTabs();
            }
          }
        });
      } catch (_) {}
    }
  });
}

// Listen for port connections from content scripts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== EVT.PORT_NAME) return;

  const tabId = port.sender?.tab?.id;
  const entry = { port, tabId };
  ports.push(entry);

  port.onMessage.addListener((msg) => handleContentMessage(msg, port, tabId));

  port.onDisconnect.addListener(() => {
    // Clear lastError to suppress "port moved into bfcache" noise
    void chrome.runtime.lastError;
    const idx = ports.indexOf(entry);
    if (idx > -1) ports.splice(idx, 1);
    const tabStillConnected = tabId != null && ports.some(e => e.tabId === tabId);
    const wasHooked = tabId != null && hookedTabs.has(tabId);
    console.log(
      `[byob/bg] port.onDisconnect tabId=${tabId} hooked=${wasHooked} ` +
        `tabStillConnected=${tabStillConnected} channel=${!!channel} portsLeft=${ports.length}`
    );
    // If no other port from this tab and the tab had hooked a video,
    // tell the server the player tab closed.
    if (tabId != null && channel) {
      if (!tabStillConnected && wasHooked) {
        channel.push(EVT.CHAN_VIDEO_TAB_CLOSED, { tab_id: String(tabId) });
        channel.push(EVT.CHAN_VIDEO_UNREADY, { tab_id: String(tabId) });
        console.log(`[byob/bg] port.onDisconnect → pushed tab_closed + unready for tab ${tabId}`);
      }
      if (!tabStillConnected) hookedTabs.delete(tabId);
    }
    if (ports.length === 0 && channel) {
      // All external player windows closed — pause so next joiner doesn't autoplay.
      // CRITICAL: defer the channel.leave + socket.disconnect so the
      // tab_closed / unready / all_closed pushes above actually flush
      // over the WebSocket before we tear down the connection. Calling
      // leave() synchronously after push() can cancel queued pushes
      // (the server then never sees tab_closed and the byob.video
      // "Open Player Window" button stays stuck on "Focus").
      console.log(`[byob/bg] all ports gone — pushing all_closed; deferring leave by 500ms`);
      const allClosedPush = channel.push(EVT.CHAN_VIDEO_ALL_CLOSED, {});
      const closingChannel = channel;
      const closingSocket = socket;
      channel = null;
      socket = null;
      currentRoomId = null;
      hookedTabs.clear();
      // Wait for the all_closed push to ack (or 500 ms timeout),
      // THEN actually leave the channel and disconnect the socket.
      const cleanup = () => {
        try {
          closingChannel.leave();
        } catch (_) {}
        try {
          if (closingSocket) closingSocket.disconnect();
        } catch (_) {}
        console.log(`[byob/bg] channel left + socket disconnected`);
      };
      try {
        allClosedPush.receive("ok", cleanup).receive("timeout", cleanup);
      } catch (_) {
        // Older Phoenix.js without receive chain — fall back to a flat timeout.
        setTimeout(cleanup, 500);
      }
    }
  });
});

function handleContentMessage(msg, port, tabId) {
  switch (msg.type) {
    case EVT.CONNECT:
      if (currentRoomId === msg.room_id && channel) {
        // Already connected — just notify this port it's ready
        port.postMessage({ type: EVT.BYOB_CHANNEL_READY });
        if (lastReadyCount) port.postMessage(lastReadyCount);
        // Share the current clock offset so the reconcile loop has a
        // baseline before the next 30s maintenance tick fires.
        port.postMessage({ type: EVT.BYOB_CLOCK_SYNC, offset: clockOffset, rtt: clockRtt });
      } else {
        connectToRoom(msg.room_id, msg.server_url, msg.token, msg.username);
      }
      break;

    case EVT.VIDEO_HOOKED:
      // Register this tab as a player tab (has a hooked video). Fires
      // exactly once per tab — the server's open_tabs entry matches the
      // "tab has an actual player" semantic the tooltip / ext_closed
      // toast rely on.
      if (tabId != null && channel && !hookedTabs.has(tabId)) {
        hookedTabs.add(tabId);
        channel.push(EVT.CHAN_VIDEO_TAB_OPENED, { tab_id: String(tabId) });
      }
      // Send page metadata to server for display on byob.video
      if (channel && (msg.title || msg.thumbnail_url)) {
        channel.push(EVT.CHAN_VIDEO_MEDIA_INFO, {
          title: msg.title || null,
          thumbnail_url: msg.thumbnail_url || null,
        });
      }
      // Request current room state and send it to the content script.
      if (channel) {
        channel.push(EVT.CHAN_SYNC_REQUEST_STATE, {}).receive("ok", (resp) => {
          console.log("[byob] Got current state for sync:", resp);
          if (resp.current_url) currentSyncedUrl = resp.current_url;
          if (resp.current_source_type) currentSourceType = resp.current_source_type;
          if (resp.queue_size != null) currentQueueSize = resp.queue_size;
          if (resp.is_live != null) currentIsLive = !!resp.is_live;
          if (resp.current_item_id != null) currentItemId = resp.current_item_id;
          port.postMessage({
            type: EVT.COMMAND_INITIAL_STATE,
            play_state: resp.play_state,
            current_time: resp.current_time,
            server_time: resp.server_time,
            current_url: resp.current_url,
            current_item_id: resp.current_item_id,
            queue_size: resp.queue_size,
            is_live: !!resp.is_live,
          });
        });
      }
      break;

    case EVT.VIDEO_REQUEST_SYNC:
      // User interacted — request fresh state and apply it.
      if (channel) {
        channel.push(EVT.CHAN_SYNC_REQUEST_STATE, {}).receive("ok", (resp) => {
          console.log("[byob] Fresh state for sync:", resp);
          if (resp.current_url) currentSyncedUrl = resp.current_url;
          if (resp.current_source_type) currentSourceType = resp.current_source_type;
          if (resp.queue_size != null) currentQueueSize = resp.queue_size;
          if (resp.is_live != null) currentIsLive = !!resp.is_live;
          if (resp.current_item_id != null) currentItemId = resp.current_item_id;
          // Broadcast command:synced directly — the content script will
          // seek + play/pause itself based on the play_state/current_time.
          // (Stage-2 simplification: no preceding CMD:play/pause dance.)
          const synced = {
            type: EVT.COMMAND_SYNCED,
            play_state: resp.play_state,
            current_time: resp.current_time,
            server_time: resp.server_time,
            current_url: resp.current_url,
            current_item_id: resp.current_item_id,
            queue_size: resp.queue_size,
            is_live: !!resp.is_live,
          };
          if (tabId != null) broadcastToTab(tabId, synced);
          else broadcastToContentScripts(synced);
        });
      }
      break;

    case EVT.VIDEO_PLAY:
      if (channel) channel.push(EVT.CHAN_VIDEO_PLAY, { position: msg.position });
      break;

    case EVT.VIDEO_PAUSE:
      if (channel) channel.push(EVT.CHAN_VIDEO_PAUSE, { position: msg.position });
      break;

    case EVT.VIDEO_SEEK:
      if (channel) channel.push(EVT.CHAN_VIDEO_SEEK, { position: msg.position });
      break;

    case EVT.VIDEO_ENDED:
      if (channel) {
        const payload = msg.item_id ? { item_id: msg.item_id } : {};
        channel.push(EVT.CHAN_VIDEO_ENDED, payload);
      }
      break;

    case EVT.VIDEO_STATE:
      if (channel) channel.push(EVT.CHAN_VIDEO_STATE, { hooked: true, position: msg.position, duration: msg.duration, playing: msg.playing, tab_id: String(tabId) });
      break;

    case EVT.VIDEO_READY:
      if (channel && tabId != null) {
        channel.push(EVT.CHAN_VIDEO_READY, { tab_id: String(tabId) });
      }
      break;

    case EVT.VIDEO_LOADED:
      if (channel && msg.item_id) {
        channel.push(EVT.CHAN_VIDEO_LOADED, { item_id: msg.item_id });
      }
      break;

    case EVT.VIDEO_DRIFT:
      // Server-authoritative drift report. Include rtt_ms (median from
      // background's own clockSync) and noise_floor_ms (jitter EMA the
      // content script has been tracking) so the server's
      // `Byob.SyncDecision` has everything it needs to compute the
      // effective tolerance and decide whether to issue a seek command.
      if (channel) {
        channel.push(EVT.CHAN_VIDEO_DRIFT, {
          drift_ms: msg.drift,
          noise_floor_ms: msg.noise_floor_ms || 0,
          observed_l_ms: msg.observed_l_ms || 0,
          rtt_ms: clockRtt || 0,
          tab_id: String(tabId),
        });
      }
      break;

    case EVT.VIDEO_LIVE_STATUS:
      if (channel) channel.push(EVT.CHAN_VIDEO_LIVE_STATUS, { is_live: !!msg.is_live });
      break;

    case EVT.VIDEO_UPDATE_URL:
      if (channel && msg.url) channel.push(EVT.CHAN_VIDEO_UPDATE_URL, { url: msg.url });
      break;

    case EVT.BYOB_BAR_UPDATE:
      // Relay bar updates to all ports (so top frame can update its sync bar)
      broadcastToContentScripts(msg);
      break;

    case EVT.DEBUG_LOG:
      if (channel) channel.push(EVT.CHAN_DEBUG_LOG, { message: msg.message, tab_id: String(tabId) });
      break;
  }
}

function closeExtensionTabs() {
  for (const entry of [...ports]) {
    if (entry.tabId != null) {
      try { chrome.tabs.remove(entry.tabId); } catch (_) {}
    }
  }
}

// NTP-style clock sync — burst of N pings, take median-RTT offset as the
// current clock offset. Runs on channel join + every CLOCK_SYNC_MAINTAIN_MS
// while connected.
function doClockSync() {
  if (!channel) return;
  const samples = [];
  let remaining = CLOCK_SYNC_BURST_SAMPLES;
  const sendPing = () => {
    if (!channel) return;
    const t1 = Date.now();
    channel.push(EVT.CHAN_SYNC_PING, { t1 }).receive("ok", (resp) => {
      const t4 = Date.now();
      const { t2, t3 } = resp;
      const rtt = (t4 - t1) - (t3 - t2);
      const offset = ((t2 - t1) + (t3 - t4)) / 2;
      samples.push({ rtt, offset });
      remaining--;
      if (remaining > 0) {
        setTimeout(sendPing, CLOCK_SYNC_PING_INTERVAL_MS);
      } else {
        samples.sort((a, b) => a.rtt - b.rtt);
        const median = samples[Math.floor(samples.length / 2)];
        clockOffset = median.offset;
        clockRtt = median.rtt;
        console.log(`[byob] clock sync: offset=${clockOffset}ms rtt=${clockRtt}ms`);
        broadcastToContentScripts({ type: EVT.BYOB_CLOCK_SYNC, offset: clockOffset, rtt: clockRtt });
      }
    });
  };
  sendPing();
}

function startClockSyncMaintenance() {
  if (clockSyncTimer) clearInterval(clockSyncTimer);
  clockSyncTimer = setInterval(doClockSync, CLOCK_SYNC_MAINTAIN_MS);
}
function stopClockSyncMaintenance() {
  if (clockSyncTimer) { clearInterval(clockSyncTimer); clockSyncTimer = null; }
}

function connectToRoom(roomId, serverUrl, token, username) {
  // Don't reconnect if already connected to this room
  if (currentRoomId === roomId && channel) return;

  // Per-SW cooldown — prevents reconnection storms within one service worker.
  // Different SWs (normal + incognito) each get their own cooldown.
  const now = Date.now();
  if (now - lastConnectAt < CONNECT_COOLDOWN_MS) {
    console.log("[byob] Connection cooldown");
    return;
  }
  lastConnectAt = now;

  // Disconnect existing
  if (channel) {
    channel.leave();
    channel = null;
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  currentRoomId = roomId;
  currentServerUrl = serverUrl;

  // Connect Phoenix Socket with auth token — disable built-in reconnect
  // so we don't spam errors when the server is down. The content script's
  // port reconnect logic handles recovery.
  const wsUrl = serverUrl.replace(/^http/, "ws") + "/extension";
  socket = new Socket(wsUrl, {
    heartbeatIntervalMs: SOCKET_HEARTBEAT_MS,
    params: token ? { token } : {},
    reconnectAfterMs: () => null, // disable auto-reconnect
  });

  socket.connect();

  channel = socket.channel(`extension:${roomId}`, {
    username: username || "ExtensionUser",
    is_extension: true,
  });

  channel.on(EVT.CHAN_SYNC_PLAY, (data) => broadcastToContentScripts({
    type: EVT.COMMAND_PLAY,
    position: data.time,
    server_time: data.server_time,
  }));

  channel.on(EVT.CHAN_SYNC_PAUSE, (data) => broadcastToContentScripts({
    type: EVT.COMMAND_PAUSE,
    position: data.time,
    server_time: data.server_time,
  }));

  channel.on(EVT.CHAN_SYNC_CORRECTION, (data) => {
    broadcastToContentScripts({
      type: EVT.SYNC_CORRECTION,
      expected_time: data.expected_time,
      server_time: data.server_time,
    });
  });

  // Server-driven seek: `Byob.SyncDecision` decided this client needs to
  // seek to a specific position (target already includes learned-L
  // overshoot). Forward to the content script that owns the player.
  channel.on(EVT.CHAN_SYNC_SEEK_COMMAND, (data) => {
    broadcastToContentScripts({
      type: EVT.SYNC_SEEK_COMMAND,
      position: data.position,
      server_time: data.server_time,
    });
  });

  channel.on(EVT.CHAN_AUTOPLAY_COUNTDOWN, (data) => {
    autoplayCountdownActive = true;
    broadcastToContentScripts({
      type: EVT.AUTOPLAY_COUNTDOWN,
      duration_ms: data.duration_ms,
    });
  });

  channel.on(EVT.CHAN_AUTOPLAY_CANCELLED, () => {
    autoplayCountdownActive = false;
    broadcastToContentScripts({
      type: EVT.AUTOPLAY_CANCELLED,
    });
  });

  channel.on(EVT.CHAN_READY_COUNT, (data) => {
    lastReadyCount = {
      type: EVT.BYOB_READY_COUNT,
      ready: data.ready,
      has_tab: data.has_tab,
      total: data.total,
      needs_open: data.needs_open || [],
      needs_play: data.needs_play || [],
    };
    broadcastToContentScripts(lastReadyCount);
  });

  channel.on(EVT.CHAN_ROOM_PRESENCE, (data) => {
    broadcastToContentScripts({
      type: EVT.BYOB_PRESENCE,
      event: data.event,
      username: data.username,
    });
  });

  channel.on(EVT.CHAN_LIVE_STATUS, (data) => {
    currentIsLive = !!data?.is_live;
    broadcastToContentScripts({
      type: EVT.COMMAND_LIVE_STATUS,
      is_live: currentIsLive,
    });
  });

  channel.on(EVT.CHAN_VIDEO_CHANGE, (data) => {
    // Cache the canonical URL so new tabs joining mid-playback know what
    // to compare against. `data.media_item` is the serialized MediaItem.
    const mi = data && data.media_item;
    if (mi && mi.url) {
      currentSyncedUrl = mi.url;
      currentSourceType = mi.source_type;
      currentIsLive = !!mi.is_live;
      currentItemId = mi.id || null;
    }

    autoplayCountdownActive = false;

    // Reuse existing extension tabs whenever the new video is also
    // extension-required — much smoother than close-then-reopen, which
    // forces the user to click "Open in extension" again. The content
    // script updates chrome.storage's target_url, then navigates the tab
    // to the new URL.
    //
    // For non-extension types (YouTube/Vimeo/direct), the main LV player
    // can show the video directly — close the extension tabs so the user
    // returns to byob.video. Applies to every transition off third-party,
    // not just autoplay-advance: queue→Play Now of a YouTube video, "Set
    // room to this page" pointing at a YouTube URL, etc.
    if (mi && mi.source_type === "extension_required") {
      broadcastToContentScripts({
        type: EVT.COMMAND_VIDEO_CHANGE,
        url: mi.url,
        source_type: mi.source_type,
        source_id: mi.source_id,
        title: mi.title,
        is_live: !!mi.is_live,
        item_id: mi.id || null,
        navigate: true,
      });
    } else {
      closeExtensionTabs();
    }
  });

  channel.on(EVT.CHAN_QUEUE_ENDED, () => {
    // Queue finished with nothing next — do NOT close tabs. Let the user
    // keep browsing; content.js flips the sync bar to "Queue ended" and
    // the URL-mismatch toast will prompt them if they navigate away.
    currentQueueSize = 0;
    broadcastToContentScripts({ type: EVT.COMMAND_QUEUE_ENDED });
  });

  // Refresh the cached queue size on every queue update so content scripts
  // can distinguish "there's a next video" from "last video".
  channel.on(EVT.CHAN_QUEUE_UPDATED, (data) => {
    if (data && Array.isArray(data.queue)) currentQueueSize = data.queue.length;
  });

  socket.onOpen(() => console.log("[byob] WebSocket connected to", wsUrl));
  socket.onError(() => {}); // suppress — onClose handles cleanup
  socket.onClose(() => {
    console.log("[byob] WebSocket closed, cleaning up");
    stopClockSyncMaintenance();
    // Send tab_closed/unready for all ports BEFORE clearing channel —
    // otherwise port.onDisconnect finds channel=null and can't send.
    if (channel) {
      const seenTabs = new Set();
      for (const entry of ports) {
        if (entry.tabId != null && !seenTabs.has(entry.tabId)) {
          seenTabs.add(entry.tabId);
          try {
            channel.push(EVT.CHAN_VIDEO_TAB_CLOSED, { tab_id: String(entry.tabId) });
            channel.push(EVT.CHAN_VIDEO_UNREADY, { tab_id: String(entry.tabId) });
          } catch (_) {}
        }
      }
    }
    channel = null;
    socket = null;
    currentRoomId = null;
    lastReadyCount = null;
    for (const entry of [...ports]) {
      try { entry.port.disconnect(); } catch (_) {}
    }
    ports.length = 0;
  });

  channel
    .join()
    .receive("ok", (resp) => {
      console.log("[byob] Joined room", roomId, resp);
      initialRoomState = resp;
      if (resp.ready_count) {
        lastReadyCount = {
          type: EVT.BYOB_READY_COUNT,
          ready: resp.ready_count.ready,
          has_tab: resp.ready_count.has_tab,
          total: resp.ready_count.total,
          needs_open: resp.ready_count.needs_open || [],
          needs_play: resp.ready_count.needs_play || [],
        };
      }
      broadcastToContentScripts({ type: EVT.BYOB_CHANNEL_READY });
      if (lastReadyCount) broadcastToContentScripts(lastReadyCount);
      // Kick off NTP clock sync and schedule maintenance.
      doClockSync();
      startClockSyncMaintenance();
      // Re-announce only tabs that had previously hooked a video —
      // non-player tabs stay out of open_tabs.
      for (const tId of hookedTabs) {
        channel.push(EVT.CHAN_VIDEO_TAB_OPENED, { tab_id: String(tId) });
      }
    })
    .receive("error", (resp) => {
      console.error("[byob] Failed to join room", roomId, resp);
    });
}

// Listen for messages from content scripts (cross-origin safe)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === EVT.BYOB_OPEN_EXTERNAL) {
    // byob.video page asked to open a popup. Single-popup enforcement:
    // close any existing managed popup tabs FIRST so we don't leave
    // an orphaned popup running with stale config. Without this, an
    // earlier popup that got configA could still be active when
    // configB arrives, and the BG would have two popups in
    // byobManagedTabs (configA / configB), each thinking it's the
    // current player tab.
    const openerTabId = sender.tab?.id;
    console.log(`[byob/bg] BYOB_OPEN_EXTERNAL openerTabId=${openerTabId} hasConfig=${!!msg.config} url=${msg.config?.target_url}`);
    if (openerTabId != null && msg.config) {
      // Close any existing managed popups before claiming the new one.
      // This also fires chrome.tabs.onRemoved for those tabs, which
      // pushes their tab_closed events to the server (correctly
      // attributed because byobManagedTabs[tabId] still has each
      // tab's original config until the listener clears it).
      const existing = [...byobManagedTabs.keys()];
      if (existing.length > 0) {
        console.log(`[byob/bg] BYOB_OPEN_EXTERNAL → closing existing managed tabs: ${existing}`);
        for (const t of existing) {
          try { chrome.tabs.remove(t); } catch (_) {}
        }
      }
      expirePendingOpens();
      pendingByobOpens.set(openerTabId, {
        config: msg.config,
        expiresAt: Date.now() + PENDING_OPEN_TTL_MS,
      });
      console.log(`[byob/bg] pendingByobOpens set: ${[...pendingByobOpens.keys()]}`);
    }
    return false;
  }
  if (msg.type === EVT.BYOB_CHECK_MANAGED) {
    const tabId = sender.tab?.id;
    const openerTabId = sender.tab?.openerTabId;
    const tabUrl = sender.tab?.url || sender.url || msg.url;
    if (tabId == null) {
      console.log(`[byob/bg] BYOB_CHECK_MANAGED no sender.tab.id — sender:`, sender);
      sendResponse({ managed: false });
      return false;
    }
    (async () => {
      await loadManagedTabs();
      let cfg = byobManagedTabs.get(tabId);
      let claimedFrom = cfg ? "managed" : null;
      let claimedKey = null;

      // Path 1: openerTabId match (Chrome — `window.open()` from a
      // content script sets sender.tab.openerTabId correctly).
      if (!cfg && openerTabId != null) {
        expirePendingOpens();
        const pending = pendingByobOpens.get(openerTabId);
        if (pending) {
          cfg = pending.config;
          claimedFrom = "opener";
          claimedKey = openerTabId;
        }
      }

      // Path 2: URL match (Firefox — sender.tab.openerTabId is
      // undefined for window.open() popups). With single-popup
      // enforcement we expect only ONE pending entry; if there's
      // somehow more, prefer exact URL > hostname.
      if (!cfg && tabUrl) {
        expirePendingOpens();
        const tabHost = hostnameOf(tabUrl);
        const entries = [...pendingByobOpens.entries()].sort(
          ([, a], [, b]) => b.expiresAt - a.expiresAt
        );
        let matched = entries.find(([, p]) => p.config?.target_url === tabUrl);
        if (!matched && tabHost) {
          matched = entries.find(([, p]) => hostnameOf(p.config?.target_url) === tabHost);
        }
        if (matched) {
          const [openerKey, pending] = matched;
          cfg = pending.config;
          claimedFrom = pending.config?.target_url === tabUrl ? "url-exact" : "url-host";
          claimedKey = openerKey;
        }
      }

      if (cfg && claimedKey != null) {
        pendingByobOpens.delete(claimedKey);
        byobManagedTabs.set(tabId, cfg);
        persistManagedTabs();
      }

      console.log(
        `[byob/bg] BYOB_CHECK_MANAGED tabId=${tabId} openerTabId=${openerTabId} ` +
          `tabUrl=${tabUrl} claimedFrom=${claimedFrom || "none"} ` +
          `pending=[${[...pendingByobOpens.keys()]}] managed=[${[...byobManagedTabs.keys()]}]`
      );
      sendResponse(cfg ? { managed: true, config: cfg } : { managed: false });
    })();
    return true; // async response
  }
  if (msg.type === EVT.BYOB_VIDEO_HOOKED) {
    broadcastToContentScripts({ type: EVT.BYOB_VIDEO_HOOKED });
  }
  if (msg.type === EVT.BYOB_BAR_UPDATE) {
    broadcastToContentScripts(msg);
  }
  if (msg.type === EVT.BYOB_USER_ACTIVE) {
    // Broadcast cross-frame so every content script agrees on "user is
    // interacting right now". Allows the iframe's event handlers to see
    // activations that happened in the top frame (and vice-versa), which
    // navigator.userActivation can't do reliably.
    broadcastToContentScripts({ type: EVT.BYOB_USER_ACTIVE, t: msg.t });
  }
  if (msg.type === EVT.BYOB_FOCUS_EXTERNAL) {
    // The LV main page asked us to focus its popup. window.open()'s
    // named-target reuse is broken across COOP (YouTube), and the parent
    // can't focus() the WindowProxy across it either — but chrome.tabs
    // can. Walk hookedTabs, focus the first one that's still alive, and
    // garbage-collect any that aren't (SW suspension can swallow both
    // port.onDisconnect and chrome.tabs.onRemoved, leaving phantom
    // entries that fool the server's open_tabs / ready_count). Sending
    // video:tab_closed on cleanup makes the LV's "Focus" label flip
    // back to "Open Player Window" so the user can re-open.
    (async () => {
      const tabIds = Array.from(hookedTabs);
      let focused = false;
      for (const tabId of tabIds) {
        try {
          const tab = await chrome.tabs.get(tabId);
          await chrome.tabs.update(tabId, { active: true });
          if (tab && tab.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          focused = true;
          break;
        } catch (_) {
          // Tab is gone — drop the phantom and notify server.
          hookedTabs.delete(tabId);
          if (channel) {
            try {
              channel.push(EVT.CHAN_VIDEO_TAB_CLOSED, { tab_id: String(tabId) });
              channel.push(EVT.CHAN_VIDEO_UNREADY, { tab_id: String(tabId) });
            } catch (_) {}
          }
        }
      }
      void focused;
    })();
  }
});

function broadcastToContentScripts(msg) {
  for (const entry of ports) {
    try {
      entry.port.postMessage(msg);
    } catch (e) {
      // Port may have disconnected
    }
  }
}

function broadcastToTab(tabId, msg) {
  for (const entry of ports) {
    if (entry.tabId === tabId) {
      try {
        entry.port.postMessage(msg);
      } catch (e) {}
    }
  }
}
