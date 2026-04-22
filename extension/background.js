// WatchParty service worker — holds content script ports + Phoenix Channel connection
import { Socket } from "./lib/phoenix.mjs";

const ports = []; // all connected ports — each entry is { port, tabId }
let socket = null;
let channel = null;
let currentRoomId = null;
let lastReadyCount = null;
let currentServerUrl = null;
let initialRoomState = null;

// Listen for port connections from content scripts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "watchparty") return;

  const tabId = port.sender?.tab?.id;
  const entry = { port, tabId };
  ports.push(entry);

  port.onMessage.addListener((msg) => handleContentMessage(msg, port, tabId));

  port.onDisconnect.addListener(() => {
    // Clear lastError to suppress "port moved into bfcache" noise
    void chrome.runtime.lastError;
    const idx = ports.indexOf(entry);
    if (idx > -1) ports.splice(idx, 1);
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
      // Request current room state and send it to the content script.
      // The content script will show an autoplay overlay — the user's click
      // provides the gesture needed to unlock video.play().
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
            port.postMessage({ type: "command:play", position: resp.current_time });
          } else {
            port.postMessage({ type: "command:seek", position: resp.current_time });
            port.postMessage({ type: "command:pause", position: resp.current_time });
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
      if (channel) channel.push("video:state", { hooked: true, position: msg.position, duration: msg.duration, playing: msg.playing });
      break;

    case "video:ready":
      if (channel) channel.push("video:ready", { tab_id: tabId != null ? String(tabId) : null });
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
  }));

  channel.on("sync:pause", (data) => broadcastToContentScripts({
    type: "command:pause",
    position: data.time,
  }));

  channel.on("sync:seek", (data) => broadcastToContentScripts({
    type: "command:seek",
    position: data.time,
  }));

  channel.on("sync:correction", (data) => {
    // Could implement drift correction in extension too
    // For v0, just relay seek if drift is large
  });

  channel.on("autoplay:countdown", (data) => broadcastToContentScripts({
    type: "autoplay:countdown",
    duration_ms: data.duration_ms,
  }));

  channel.on("autoplay:cancelled", () => broadcastToContentScripts({
    type: "autoplay:cancelled",
  }));

  channel.on("ready:count", (data) => {
    lastReadyCount = { type: "byob:ready-count", ready: data.ready, total: data.total };
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
    // Disconnect all ports — content scripts will reconnect with backoff
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
        lastReadyCount = { type: "byob:ready-count", ready: resp.ready_count.ready, total: resp.ready_count.total };
      }
      broadcastToContentScripts({ type: "byob:channel-ready" });
      if (lastReadyCount) broadcastToContentScripts(lastReadyCount);
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
