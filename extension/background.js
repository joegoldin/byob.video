// WatchParty service worker — holds content script ports + Phoenix Channel connection
import { Socket } from "./lib/phoenix.mjs";

const ports = []; // all connected ports
let socket = null;
let channel = null;
let currentRoomId = null;
let currentServerUrl = null;
let initialRoomState = null;

// Listen for port connections from content scripts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "watchparty") return;

  ports.push(port);

  port.onMessage.addListener((msg) => handleContentMessage(msg, port));

  port.onDisconnect.addListener(() => {
    const idx = ports.indexOf(port);
    if (idx > -1) ports.splice(idx, 1);
    if (ports.length === 0 && channel) {
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
      if (channel) channel.push("video:state", { hooked: true, position: 0, duration: msg.duration || 0, playing: false });
      // Sync newly hooked video to current room state
      if (initialRoomState) {
        const state = initialRoomState;
        setTimeout(() => {
          if (state.play_state === "playing") {
            port.postMessage({ type: "command:play", position: state.current_time });
          } else {
            // Paused: seek to position but don't play
            port.postMessage({ type: "command:seek", position: state.current_time });
            port.postMessage({ type: "command:pause", position: state.current_time });
          }
        }, 500); // Small delay for video to be ready
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

    case "video:state":
      if (channel) channel.push("video:state", { hooked: true, position: msg.position, duration: msg.duration, playing: msg.playing });
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
  const wsUrl = serverUrl.replace(/^http/, "ws") + "/extension";
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

  socket.onOpen(() => console.log("[byob] WebSocket connected to", wsUrl));
  socket.onError((err) => console.error("[byob] WebSocket error:", err));
  socket.onClose(() => console.log("[byob] WebSocket closed"));

  channel
    .join()
    .receive("ok", (resp) => {
      console.log("[byob] Joined room", roomId, resp);
      // Send initial sync state so late joiners sync immediately
      // Store initial state — content scripts will request it after hooking video
      initialRoomState = resp;
      broadcastToContentScripts({ type: "byob:channel-ready" });
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
  for (const port of ports) {
    try {
      port.postMessage(msg);
    } catch (e) {
      // Port may have disconnected
    }
  }
}
