import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../extension/background.js", import.meta.url), "utf8")
  .replace('import { Socket } from "./lib/phoenix.mjs";', "");

function background() {
  let now = 10000;
  let nextTimer = 0;
  const timers = new Map();
  const sockets = [];
  const event = () => ({ addListener(callback) { this.callback = callback; } });
  const storage = { async get() { return {}; }, async set() {}, async remove() {} };
  class Socket {
    constructor() {
      sockets.push(this);
      this.disconnected = false;
    }
    connect() {}
    disconnect() { this.disconnected = true; }
    onOpen() {}
    onError() {}
    onClose(callback) { this.close = callback; }
    channel() {
      const replies = {};
      const push = { receive(status, callback) { replies[status] = callback; return this; } };
      this.room = {
        on() {}, leave() {}, push() { return push; }, join() { return push; },
        joined: false, isJoined() { return this.joined; },
      };
      this.join = () => { this.room.joined = true; replies.ok({}); };
      return this.room;
    }
  }
  const context = vm.createContext({
    Socket, URL, console: { log() {}, error() {} },
    Date: { now: () => now },
    setTimeout(callback, delay) {
      timers.set(++nextTimer, { callback, at: now + delay });
      return nextTimer;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return 1; }, clearInterval() {},
    chrome: {
      storage: { local: storage, session: storage },
      runtime: { onConnect: event(), onMessage: event(), sendMessage() {} },
      tabs: { onRemoved: event() },
      alarms: { onAlarm: event(), create() {}, clear() {} },
    },
  });
  vm.runInContext(source, context);
  return {
    sockets,
    connect: () => context.connectToRoom("room", "https://byob.example", "test-token"),
    run: code => vm.runInContext(code, context),
    advance(ms) {
      const end = now + ms;
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, timer] = entry;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = end;
    },
  };
}

test("retries a popup connection after the cooldown expires", () => {
  const bg = background();
  bg.connect();
  bg.sockets[0].close();
  bg.advance(1000);
  bg.connect();
  bg.connect();
  bg.advance(1999);
  assert.equal(bg.sockets.length, 1);
  bg.advance(1);
  assert.equal(bg.sockets.length, 2);
});

test("stops the closed socket's built-in reconnect loop", () => {
  const bg = background();
  bg.connect();
  bg.sockets[0].close();
  assert.equal(bg.sockets[0].disconnected, true);
});

test("a stale socket close cannot tear down the replacement", () => {
  const bg = background();
  bg.connect();
  bg.sockets[0].close();
  bg.advance(3000);
  bg.connect();
  bg.sockets[0].close();
  bg.advance(3000);
  bg.connect();
  assert.equal(bg.sockets.length, 2);
});

test("a popup waits for the channel join before receiving channel-ready", () => {
  const bg = background();
  bg.connect();
  assert.equal(bg.run(`
    const messages = [];
    handleContentMessage({type: EVT.CONNECT, room_id: "room"},
      {postMessage(message) { messages.push(message); }}, 1);
    messages.some(message => message.type === EVT.BYOB_CHANNEL_READY)
  `), false);
});


test("a successful join broadcasts readiness to the waiting popup", () => {
  const bg = background();
  bg.run(`
    const messages = [];
    ports.push({tabId: 1, port: {postMessage(message) { messages.push(message); }}});
  `);
  bg.connect();
  bg.sockets[0].join();
  assert.equal(bg.run("messages.some(message => message.type === EVT.BYOB_CHANNEL_READY)"), true);
});

test("closing the last popup cancels its pending reconnect", () => {
  const bg = background();
  bg.connect();
  bg.sockets[0].close();
  bg.advance(1000);
  bg.run(`
    let disconnect;
    chrome.runtime.onConnect.callback({
      name: EVT.PORT_NAME, sender: {tab: {id: 1}},
      onMessage: {addListener() {}},
      onDisconnect: {addListener(callback) { disconnect = callback; }},
    });
  `);
  bg.connect();
  bg.run("disconnect()");
  bg.advance(3000);
  assert.equal(bg.sockets.length, 1);
});
