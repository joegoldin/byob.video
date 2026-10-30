import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomChannel } from '../web/channel.mjs';
import { mountHook } from '../web/hooks.mjs';

function fixture() {
  const sockets = [], requests = [];
  class Socket extends EventTarget {
    constructor(url) {
      super(); this.url = url; this.readyState = 0; this.sent = []; sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    send(message) {
      const frame = JSON.parse(message);
      this.sent.push(frame);
      if (frame[3] === 'phx_join') queueMicrotask(() => this.reply(frame, { user_id: 'alice', queue: [], ready_count: null, sb_settings: {}, sponsor_segments: [] }));
    }
    reply(frame, response, status = 'ok') { this.receive([frame[0], frame[1], frame[2], 'phx_reply', { status, response }]); }
    receive(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const channel = new RoomChannel({ origin: 'https://byob.test', roomId: 'abc123', tabId: 'tab-one', username: () => 'Alice', WebSocket: Socket,
    fetch: async function (url, options) { assert.equal(this, globalThis, 'browser fetch must retain its Window receiver'); requests.push({ url, options }); return { ok: true, json: async () => ({ token: 'fixture-token', user_id: 'alice', room_id: 'abc123' }) }; },
  });
  return { channel, sockets, requests };
}

test('browser channel bootstraps a cookie-bound tab and routes signed-owner state and acknowledged commands', async () => {
  const { channel, sockets, requests } = fixture();
  const snapshots = [], tokens = [];
  channel.on('sync:state', state => snapshots.push(state));
  channel.on('ext:token', token => tokens.push(token));
  try {
    await channel.start();
    assert.equal(channel.joined, true);
    assert.equal(requests[0].options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(requests[0].options.body), { tab_id: 'tab-one' });
    assert.equal(new URL(sockets[0].url).protocol, 'wss:');
    assert.equal(snapshots[0].user_id, 'alice');
    assert.deepEqual(tokens, [{ token: 'fixture-token', user_id: 'alice' }]);
    const request = channel.request('queue:skip');
    const frame = sockets[0].sent.at(-1);
    sockets[0].reply(['stale-join', ...frame.slice(1)], { invalid: true });
    assert.equal(channel.pending.size, 1, 'stale channel replies cannot acknowledge a current action');
    sockets[0].reply(frame, { accepted: true });
    assert.deepEqual(await request, { accepted: true });
    const rejected = channel.request('queue:skip');
    sockets[0].reply(sockets[0].sent.at(-1), { reason: 'rate_limited' }, 'error');
    await assert.rejects(rejected, /rate_limited/);
  } finally { channel.stop(); }
});

test('disconnect rejects ambiguous actions and never queues stale playback controls for replay', async () => {
  const { channel, sockets } = fixture();
  try {
    await channel.start();
    const pending = channel.request('video:seek', { position: 123 });
    sockets[0].close();
    await assert.rejects(pending, /Connection interrupted/);
    assert.equal(channel.joined, false);
    assert.equal(channel.pending.size, 0);
    await assert.rejects(channel.request('video:play'), /disconnected/);
    assert.ok(channel.retryTimer);
  } finally { channel.stop(); }
  assert.equal(channel.retryTimer, null);
});

test('hook bridge owns subscriptions and dispatches reconnect lifecycle without remounting players', async () => {
  const { channel } = fixture();
  const calls = [];
  const mounted = mountHook({
    mounted() { this.handleEvent('test:event', value => calls.push(value)); },
    reconnected() { calls.push('reconnected'); },
    destroyed() { calls.push('destroyed'); },
  }, {}, channel);
  assert.equal(mounted.hook.serverAuthoritativeReconnect, true);
  channel.emit('test:event', 'first');
  channel.emit('status', { state: 'connected', reconnected: false });
  channel.emit('status', { state: 'connected', reconnected: true });
  mounted.destroy();
  channel.emit('test:event', 'ignored');
  assert.deepEqual(calls, ['first', 'reconnected', 'destroyed']);
});

test('browser policy blocking WebSocket construction selects HTTP fallback', async () => {
  const { channel } = fixture();
  channel.WebSocket = class { constructor() { throw new DOMException('Blocked by browser policy', 'SecurityError'); } };
  try {
    await channel.start();
    assert.equal(channel.useHttp, true);
    assert.ok(channel.retryTimer);
  } finally { channel.stop(); }
});

test('service failures preserve their actual error instead of reporting a rejected room action', async () => {
  const { channel, sockets } = fixture();
  try {
    await channel.start();
    const request = channel.request('comments:load');
    sockets[0].reply(sockets[0].sent.at(-1), { error: 'comments_disabled' }, 'error');
    await assert.rejects(request, /comments_disabled/);
  } finally { channel.stop(); }
});

test('capacity refusal displays its explicit message and backs off instead of retrying rapidly', async () => {
  const { channel } = fixture();
  const errors = [];
  channel.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: 'Server is at its 100-room capacity. Try again later.' }) });
  channel.on('connection:error', error => errors.push(error.message));
  try {
    await channel.start();
    assert.match(errors[0], /100-room capacity/);
    assert.ok(channel.attempt >= 5, 'capacity refusal should use the maximum retry backoff immediately');
    assert.ok(channel.retryTimer);
  } finally { channel.stop(); }
});
