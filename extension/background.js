// WatchParty service worker — holds content script ports + Phoenix Channel connection
import { Socket } from "./lib/phoenix.mjs";

const ports = new Map(); // tabId -> port
let socket = null;
let channel = null;
let currentRoomId = null;
let currentServerUrl = null;

// Listen for port connections from content scripts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "watchparty") return;

  const tabId = port.sender?.tab?.id;
  if (tabId) {
    ports.set(tabId, port);
  }

  port.onMessage.addListener((msg) => handleContentMessage(msg, port, tabId));

  port.onDisconnect.addListener(() => {
    if (tabId) ports.delete(tabId);
    // If no more ports and no channel, SW can die naturally
    if (ports.size === 0 && channel) {
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
      connectToRoom(msg.room_id, msg.server_url);
      break;

    case "video:hooked":
      // Content script found a <video> element
      if (channel) {
        // Notify the room that extension player is connected
        // (no specific channel event needed — the room knows via join)
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

    case "video:timeupdate":
      // Periodic position report — could be used for drift detection
      break;
  }
}

function connectToRoom(roomId, serverUrl) {
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

  // Connect Phoenix Socket
  const wsUrl = serverUrl.replace(/^http/, "ws") + "/extension/websocket";
  socket = new Socket(wsUrl, {
    heartbeatIntervalMs: 20000, // Shorter heartbeat to keep SW alive
  });

  socket.connect();

  channel = socket.channel(`extension:${roomId}`, {
    username: "ExtensionUser",
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

  channel.on("video:change", (data) => {
    // New video selected — content script doesn't need to do anything
    // since the user navigates to the video themselves
  });

  channel
    .join()
    .receive("ok", (resp) => {
      console.log("[WatchParty] Joined room", roomId, resp);
    })
    .receive("error", (resp) => {
      console.error("[WatchParty] Failed to join room", roomId, resp);
    });
}

function broadcastToContentScripts(msg) {
  for (const [_tabId, port] of ports) {
    try {
      port.postMessage(msg);
    } catch (e) {
      // Port may have disconnected
    }
  }
}
