// WatchParty service worker — holds content script ports + Phoenix Channel connection
import { Socket } from "./lib/phoenix.mjs";

const ports = []; // all connected ports — each entry is { port, tabId }
let socket = null;
let channel = null;
let currentRoomId = null;
let lastReadyCount = null;
let currentServerUrl = null;
let initialRoomState = null;
let clockOffset = 0; // ms offset: serverMonotonic ≈ Date.now() + clockOffset
let clockRtt = 0; // last measured RTT in ms
let clockSyncTimer = null;
let lastConnectAt = 0; // cooldown to prevent reconnection storms

// Echo prevention: track which port originated the last play/pause/seek
// so we can skip relaying the server's echo back to that port.
let lastEventPort = null;
let lastEventType = null;
let lastEventTimer = null;

function markOrigin(port, type) {
  lastEventPort = port;
  lastEventType = type;
  if (lastEventTimer) clearTimeout(lastEventTimer);
  // Clear after 2s — if the echo hasn't arrived by then, it never will
  lastEventTimer = setTimeout(() => { lastEventPort = null; lastEventType = null; }, 2000);
}

function clearOrigin() {
  lastEventPort = null;
  lastEventType = null;
  if (lastEventTimer) { clearTimeout(lastEventTimer); lastEventTimer = null; }
}

// Broadcast to all ports EXCEPT the origin of the current echo
function broadcastExceptOrigin(msg, echoType) {
  const skipPort = (lastEventType === echoType) ? lastEventPort : null;
  if (skipPort) clearOrigin(); // consumed
  for (const entry of ports) {
    if (entry.port === skipPort) continue;
    try { entry.port.postMessage(msg); } catch (_) {}
  }
}

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
          });
        });
      }
      break;

    case "video:request-sync":
      // User interacted — request fresh state and apply it.
      // Delay synced flag so the seek/play commands land before the
      // content script starts sending its own events to the server.
      if (channel) {
        channel.push("sync:request_state", {}).receive("ok", (resp) => {
          console.log("[byob] Fresh state for sync:", resp);
          if (resp.play_state === "playing") {
            port.postMessage({ type: "command:play", position: resp.current_time, server_time: resp.server_time });
          } else {
            port.postMessage({ type: "command:seek", position: resp.current_time, server_time: resp.server_time });
            port.postMessage({ type: "command:pause", position: resp.current_time, server_time: resp.server_time });
          }
          // Wait for seek to settle before enabling bidirectional sync.
          // Broadcast to same-tab ports only (top frame + iframe) so the
          // top frame can hide the toast without affecting other tabs.
          setTimeout(() => {
            if (tabId != null) {
              broadcastToTab(tabId, { type: "command:synced" });
            } else {
              broadcastToContentScripts({ type: "command:synced" });
            }
          }, 500);
        });
      }
      break;

    case "video:play":
      markOrigin(port, "play");
      if (channel) channel.push("video:play", { position: msg.position });
      break;

    case "video:pause":
      markOrigin(port, "pause");
      if (channel) channel.push("video:pause", { position: msg.position });
      break;

    case "video:seek":
      markOrigin(port, "seek");
      if (channel) channel.push("video:seek", { position: msg.position });
      break;

    case "video:ended":
      if (channel) channel.push("video:ended", {});
      break;

    case "video:state":
      if (channel) channel.push("video:state", { hooked: true, position: msg.position, duration: msg.duration, playing: msg.playing, buffering: msg.buffering || false });
      // Relay local buffering state to top frame so it can show/hide overlay
      // without waiting for server round-trip
      if (msg.buffering != null) {
        broadcastToContentScripts({ type: "byob:local-buffering", buffering: !!msg.buffering });
      }
      break;

    case "video:ready":
      if (channel && tabId != null) {
        channel.push("video:ready", { tab_id: String(tabId) });
      }
      break;

    case "byob:bar-update":
      // Relay bar updates to all ports (so top frame can update its sync bar)
      broadcastToContentScripts(msg);
      break;
  }
}

function connectToRoom(roomId, serverUrl, token, username) {
  // Don't reconnect if already connected to this room
  if (currentRoomId === roomId && channel) return;

  // Cooldown — prevent reconnection storms from cascading failures
  const now = Date.now();
  if (now - lastConnectAt < 3000) {
    console.log("[byob] Connection cooldown, skipping reconnect");
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

  channel.on("sync:play", (data) => broadcastExceptOrigin({
    type: "command:play",
    position: data.time,
    server_time: data.server_time,
  }, "play"));

  channel.on("sync:pause", (data) => broadcastExceptOrigin({
    type: "command:pause",
    position: data.time,
    server_time: data.server_time,
  }, "pause"));

  channel.on("sync:seek", (data) => broadcastExceptOrigin({
    type: "command:seek",
    position: data.time,
    server_time: data.server_time,
  }, "seek"));

  channel.on("sync:correction", (data) => {
    broadcastToContentScripts({
      type: "sync:correction",
      expected_time: data.expected_time,
      server_time: data.server_time,
    });
  });

  channel.on("sync:buffering", (data) => broadcastToContentScripts({
    type: "byob:peer-buffering",
    user_id: data.user_id,
    buffering: data.buffering,
  }));

  channel.on("sync:tolerance", (data) => {
    broadcastToContentScripts({ type: "byob:sync-tolerance", tolerance_ms: data.tolerance_ms, client_rtts: data.client_rtts });
  });

  channel.on("autoplay:countdown", (data) => broadcastToContentScripts({
    type: "autoplay:countdown",
    duration_ms: data.duration_ms,
  }));

  channel.on("autoplay:cancelled", () => broadcastToContentScripts({
    type: "autoplay:cancelled",
  }));

  channel.on("ready:count", (data) => {
    lastReadyCount = { type: "byob:ready-count", ready: data.ready, has_tab: data.has_tab, total: data.total };
    broadcastToContentScripts(lastReadyCount);
  });

  channel.on("video:change", (data) => {
    // New video selected — content script doesn't need to do anything
    // since the user navigates to the video themselves
  });

  socket.onOpen(() => console.log("[byob] WebSocket connected to", wsUrl));
  socket.onError(() => {}); // suppress — onClose handles cleanup
  socket.onClose(() => {
    console.log("[byob] WebSocket closed, cleaning up");
    channel = null;
    socket = null;
    currentRoomId = null;
    lastReadyCount = null;
    stopClockSyncMaintenance();
    // Disconnect all ports — content scripts will reconnect with backoff.
    // The 3s connection cooldown prevents reconnection storms.
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
      // Report all currently connected tabs as open
      const seenTabs = new Set();
      for (const entry of ports) {
        if (entry.tabId != null && !seenTabs.has(entry.tabId)) {
          seenTabs.add(entry.tabId);
          channel.push("video:tab_opened", { tab_id: String(entry.tabId) });
        }
      }
      // Start NTP clock sync after connection stabilizes
      setTimeout(() => {
        doClockSync();
        startClockSyncMaintenance();
      }, 2000);
    })
    .receive("error", (resp) => {
      console.error("[byob] Failed to join room", roomId, resp);
    });
}

// NTP-style clock sync — burst of 5 pings, take median offset
function doClockSync() {
  if (!channel) return;
  const samples = [];
  let remaining = 5;

  function sendPing() {
    if (!channel) return; // channel may have closed during burst
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
        // Sort by RTT, take median for stability
        samples.sort((a, b) => a.rtt - b.rtt);
        const median = samples[Math.floor(samples.length / 2)];
        clockOffset = median.offset;
        clockRtt = median.rtt;
        console.log(`[byob] Clock sync: offset=${clockOffset}ms, rtt=${clockRtt}ms`);

        // Send to all content scripts
        broadcastToContentScripts({ type: "byob:clock-sync", offset: clockOffset, rtt: clockRtt });
        // Report RTT to server for room-wide tolerance computation
        if (channel) channel.push("sync:rtt_report", { rtt: clockRtt });
      }
    });
  }

  sendPing();
}

function startClockSyncMaintenance() {
  if (clockSyncTimer) clearInterval(clockSyncTimer);
  // Re-sync every 30s for drift maintenance
  clockSyncTimer = setInterval(() => doClockSync(), 30000);
}

function stopClockSyncMaintenance() {
  if (clockSyncTimer) { clearInterval(clockSyncTimer); clockSyncTimer = null; }
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
