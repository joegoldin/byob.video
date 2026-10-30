import test from 'node:test';
import assert from 'node:assert/strict';
import { httpChannel } from '../src/http-channel.mjs';
import { signToken } from '../src/auth.mjs';

async function fixture() {
  const secret = 'fixture-only-native-http-secret-at-least32';
  const token = await signToken(secret, { purpose: 'room', room: 'oldroom1', owner: 'owner:tab1', exp: Date.now() + 60000 });
  const socket = new EventTarget();
  socket.accept = () => {};
  socket.closed = [];
  socket.close = code => { socket.closed.push(code); socket.dispatchEvent(new Event('close')); };
  const env = { TOKEN_SECRET: secret, JOIN_LIMITER: { limit: async () => ({ success: true }) }, ROOMS: { getByName: () => ({ fetch: async () => ({ status: 101, webSocket: socket }) }) } };
  const url = `https://byob.test/socket/stream?token=${token}&connection=${crypto.randomUUID()}`;
  return { socket, response: await httpChannel(new Request(url), env) };
}

test('cancelling the HTTP reader closes the internal room socket', async () => {
  const { socket, response } = await fixture();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store, no-transform');
  await response.body.cancel();
  assert.deepEqual(socket.closed, [1000]);
});

test('a stalled HTTP reader closes rather than accumulating an unbounded event queue', async () => {
  const { socket, response } = await fixture();
  socket.dispatchEvent(new MessageEvent('message', { data: 'x'.repeat(1024 * 1024) }));
  socket.dispatchEvent(new MessageEvent('message', { data: 'next' }));
  assert.deepEqual(socket.closed, [1008]);
  await response.body.cancel();
});
