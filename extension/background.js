// WatchParty service worker — holds content script ports + Phoenix Channel connection
import { Socket } from "./lib/phoenix.mjs";

const ports = []; // all connected ports — each entry is { port, tabId }
let socket = null;
let channel = null;
let currentRoomId = null;
let lastReadyCount = null;
let currentServerUrl = null;
let initialRoomState = null;
let lastConnectAt = 0;
let autoplayCountdownActive = false;

// NTP-style clock sync state.
// serverMonotonicMs ≈ Date.now() + clockOffset
let clockOffset = 0;
let clockRtt = 0;
let clockSyncTimer = null;

// Listen for port connections from content scripts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "watchparty") return;

  const tabId = port.sender?.tab?.id;
  const entry = { port, tabId };
  ports.push(entry);

  // If channel already connected, report this tab as open immediately
  if (tabId != null && channel) {
    channel.push("video:tab_opened", { tab_id: String(tabId) });
  }

  port.onMessage.addListener((msg) => handleContentMessage(msg, port, tabId));

  port.onDisconnect.addListener(() => {
    // Clear lastError to suppress "port moved into bfcache" noise
    void chrome.runtime.lastError;
    const idx = ports.indexOf(entry);
    if (idx > -1) ports.splice(idx, 1);
    // If no other port from this tab, mark tab as closed + unready
    if (tabId != null && channel) {
      const tabStillConnected = ports.some(e => e.tabId === tabId);
      if (!tabStillConnected) {
        channel.push("video:tab_closed", { tab_id: String(tabId) });
        channel.push("video:unready", { tab_id: String(tabId) });
      }
    }
    if (ports.length === 0 && channel) {
      // All external player windows closed — pause so next joiner doesn't autoplay
      channel.push("video:all_closed", {});
      channel.leave();
      channel = null;
      if (socket) {
        socket.disconnect();
        socket = null;
      }
      currentRoomId = null;
    }
  });
});

function handleContentMessage(msg, port, tabId) {
  switch (msg.type) {
    case "connect":
      if (currentRoomId === msg.room_id && channel) {
        // Already connected — just notify this port it's ready
        port.postMessage({ type: "byob:channel-ready" });
        if (lastReadyCount) port.postMessage(lastReadyCount);
        // Share the current clock offset so the reconcile loop has a
        // baseline before the next 30s maintenance tick fires.
        port.postMessage({ type: "byob:clock-sync", offset: clockOffset, rtt: clockRtt });
      } else {
        connectToRoom(msg.room_id, msg.server_url, msg.token, msg.username);
      }
      break;

    case "video:hooked":
      // Send page metadata to server for display on byob.video
      if (channel && (msg.title || msg.thumbnail_url)) {
        channel.push("video:media_info", {
          title: msg.title || null,
          thumbnail_url: msg.thumbnail_url || null,
        });
      }
      // Request current room state and send it to the content script.
      if (channel) {
        channel.push("sync:request_state", {}).receive("ok", (resp) => {
          console.log("[byob] Got current state for sync:", resp);
          port.postMessage({
            type: "command:initial-state",
            play_state: resp.play_state,
            current_time: resp.current_time,
            server_time: resp.server_time,
          });
        });
      }
      break;

    case "video:request-sync":
      // User interacted — request fresh state and apply it.
      if (channel) {
        channel.push("sync:request_state", {}).receive("ok", (resp) => {
          console.log("[byob] Fresh state for sync:", resp);
          // Broadcast command:synced directly — the content script will
          // seek + play/pause itself based on the play_state/current_time.
          // (Stage-2 simplification: no preceding CMD:play/pause dance.)
          const synced = {
            type: "command:synced",
            play_state: resp.play_state,
            current_time: resp.current_time,
            server_time: resp.server_time,
          };
          if (tabId != null) broadcastToTab(tabId, synced);
          else broadcastToContentScripts(synced);
        });
      }
      break;

    case "video:play":
      if (channel) channel.push("video:play", { position: msg.position });
      break;

    case "video:pause":
      if (channel) channel.push("video:pause", { position: msg.position });
      break;

    case "video:seek":
      if (channel) channel.push("video:seek", { position: msg.position });
      break;

    case "video:ended":
      if (channel) channel.push("video:ended", {});
      break;

    case "video:state":
      if (channel) channel.push("video:state", { hooked: true, position: msg.position, duration: msg.duration, playing: msg.playing, tab_id: String(tabId) });
      break;

    case "video:ready":
      if (channel && tabId != null) {
        channel.push("video:ready", { tab_id: String(tabId) });
      }
      break;

    case "video:drift":
      if (channel) channel.push("video:drift", { drift_ms: msg.drift, tab_id: String(tabId) });
      break;

    case "byob:bar-update":
      // Relay bar updates to all ports (so top frame can update its sync bar)
      broadcastToContentScripts(msg);
      break;

    case "debug:log":
      if (channel) channel.push("debug:log", { message: msg.message, tab_id: String(tabId) });
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

// NTP-style clock sync — burst of 5 pings, take median-RTT offset as the
// current clock offset. Runs on channel join + every 30s while connected.
function doClockSync() {
  if (!channel) return;
  const samples = [];
  let remaining = 5;
  const sendPing = () => {
    if (!channel) return;
    const t1 = Date.now();
    channel.push("sync:ping", { t1 }).receive("ok", (resp) => {
      const t4 = Date.now();
      const { t2, t3 } = resp;
      const rtt = (t4 - t1) - (t3 - t2);
      const offset = ((t2 - t1) + (t3 - t4)) / 2;
      samples.push({ rtt, offset });
      remaining--;
      if (remaining > 0) {
        setTimeout(sendPing, 100);
      } else {
        samples.sort((a, b) => a.rtt - b.rtt);
        const median = samples[Math.floor(samples.length / 2)];
        clockOffset = median.offset;
        clockRtt = median.rtt;
        console.log(`[byob] clock sync: offset=${clockOffset}ms rtt=${clockRtt}ms`);
        broadcastToContentScripts({ type: "byob:clock-sync", offset: clockOffset, rtt: clockRtt });
      }
    });
  };
  sendPing();
}

function startClockSyncMaintenance() {
  if (clockSyncTimer) clearInterval(clockSyncTimer);
  clockSyncTimer = setInterval(doClockSync, 30000);
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
  if (now - lastConnectAt < 3000) {
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
    heartbeatIntervalMs: 20000,
    params: token ? { token } : {},
    reconnectAfterMs: () => null, // disable auto-reconnect
  });

  socket.connect();

  channel = socket.channel(`extension:${roomId}`, {
    username: username || "ExtensionUser",
    is_extension: true,
  });

  channel.on("sync:play", (data) => broadcastToContentScripts({
    type: "command:play",
    position: data.time,
    server_time: data.server_time,
  }));

  channel.on("sync:pause", (data) => broadcastToContentScripts({
    type: "command:pause",
    position: data.time,
    server_time: data.server_time,
  }));

  channel.on("sync:seek", (data) => broadcastToContentScripts({
    type: "command:seek",
    position: data.time,
    server_time: data.server_time,
  }));

  channel.on("sync:correction", (data) => {
    broadcastToContentScripts({
      type: "sync:correction",
      expected_time: data.expected_time,
      server_time: data.server_time,
    });
  });

  channel.on("autoplay:countdown", (data) => {
    autoplayCountdownActive = true;
    broadcastToContentScripts({
      type: "autoplay:countdown",
      duration_ms: data.duration_ms,
    });
  });

  channel.on("autoplay:cancelled", () => {
    autoplayCountdownActive = false;
    broadcastToContentScripts({
      type: "autoplay:cancelled",
    });
  });

  channel.on("ready:count", (data) => {
    lastReadyCount = { type: "byob:ready-count", ready: data.ready, has_tab: data.has_tab, total: data.total };
    broadcastToContentScripts(lastReadyCount);
  });

  channel.on("video:change", (data) => {
    // If an autoplay countdown was active, the queue just advanced —
    // close all extension tabs so users navigate to the new video.
    if (autoplayCountdownActive) {
      closeExtensionTabs();
      autoplayCountdownActive = false;
    }
  });

  channel.on("queue:ended", () => {
    closeExtensionTabs();
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
            channel.push("video:tab_closed", { tab_id: String(entry.tabId) });
            channel.push("video:unready", { tab_id: String(entry.tabId) });
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
        lastReadyCount = { type: "byob:ready-count", ready: resp.ready_count.ready, has_tab: resp.ready_count.has_tab, total: resp.ready_count.total };
      }
      broadcastToContentScripts({ type: "byob:channel-ready" });
      if (lastReadyCount) broadcastToContentScripts(lastReadyCount);
      // Kick off NTP clock sync and schedule maintenance.
      doClockSync();
      startClockSyncMaintenance();
      // Report all currently connected tabs as open.
      const seenTabs = new Set();
      for (const entry of ports) {
        if (entry.tabId != null && !seenTabs.has(entry.tabId)) {
          seenTabs.add(entry.tabId);
          channel.push("video:tab_opened", { tab_id: String(entry.tabId) });
        }
      }
    })
    .receive("error", (resp) => {
      console.error("[byob] Failed to join room", roomId, resp);
    });
}

// Listen for messages from content scripts (cross-origin safe)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "byob:video-hooked") {
    broadcastToContentScripts({ type: "byob:video-hooked" });
  }
  if (msg.type === "byob:bar-update") {
    broadcastToContentScripts(msg);
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
