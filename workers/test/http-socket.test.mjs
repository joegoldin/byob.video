import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { HttpSocket } from '../web/http-socket.mjs';

function fixture(post = async () => new Response('{}')) {
  let controller, cancelled = false;
  const calls = [];
  const stream = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  const socket = new HttpSocket('wss://byob.test/socket/websocket?token=fixture-ticket', { fetch: async (url, options) => {
    calls.push({ url, options });
    return options.method === 'POST' ? post(url, options) : new Response(stream);
  } });
  return { socket, calls, push: value => controller.enqueue(new TextEncoder().encode(value)), cancelled: () => cancelled };
}

test('HTTP socket handles fragmented frames, orders POSTs and cancels its reader on close', async () => {
  const pending = [];
  let posts = 0, startedSecond;
  const secondPost = new Promise(resolve => { startedSecond = resolve; });
  const f = fixture(() => new Promise(resolve => {
    pending.push(resolve);
    if (++posts === 2) startedSecond();
  }));
  await once(f.socket, 'open');
  const message = once(f.socket, 'message');
  f.push('\n["fra');
  f.push('me"]\n');
  assert.equal((await message)[0].data, '["frame"]');
  f.socket.send('first');
  f.socket.send('second');
  await Promise.resolve();
  assert.equal(pending.length, 1);
  pending.shift()(new Response('{}'));
  await secondPost;
  pending.shift()(new Response('{}'));
  await f.socket.posts;
  assert.deepEqual(f.calls.slice(1).map(call => JSON.parse(call.options.body).frame), ['first', 'second']);
  assert.ok(f.calls.every(call => new URL(call.url).protocol === 'https:'));
  assert.equal(new Set(f.calls.map(call => new URL(call.url).searchParams.get('connection'))).size, 1);
  f.socket.close();
  assert.equal(f.cancelled(), true);
});

test('an ambiguous failed POST closes the transport and never sends queued mutations', async () => {
  const f = fixture(async () => { throw new Error('Connection lost after commit'); });
  await once(f.socket, 'open');
  const closed = once(f.socket, 'close');
  f.socket.send('possibly committed');
  f.socket.send('must not replay');
  await closed;
  await f.socket.posts;
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(f.socket.readyState, 3);
  assert.throws(() => f.socket.send('late'), /not open/);
});
