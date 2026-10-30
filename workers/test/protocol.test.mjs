import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../src/auth.mjs';
import { parseFrame, reply, push } from '../src/protocol.mjs';

const secret = 'test-only-signing-secret-not-for-production';
test('signed tickets bind purpose, room and owner, and expire', async () => {
  const claims = { purpose: 'room', room: 'abc123', owner: 'session:tab', exp: 2000 };
  const token = await signToken(secret, claims);
  assert.deepEqual(await verifyToken(secret, token, 'room', 1000), claims);
  assert.equal(await verifyToken(secret, token, 'session', 1000), null);
  assert.equal(await verifyToken(secret, token, 'room', 2000), null);
  assert.equal(await verifyToken(secret + 'different', token, 'room', 1000), null);
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...claims, room: 'other' })).toString('base64url');
  assert.equal(await verifyToken(secret, parts.join('.'), 'room', 1000), null);
  for (const bad of ['', 'v1.!.!', 'x'.repeat(10000), null]) assert.equal(await verifyToken(secret, bad, 'room', 1000), null);
  await assert.rejects(signToken('', claims), /signing secret/);
});

test('Phoenix v2 framing preserves refs and extension topics', () => {
  const frame = parseFrame('["1","2","extension:abc123","phx_join",{}]');
  assert.deepEqual(JSON.parse(reply(frame, 'ok', { users: [] })), ['1', '2', 'extension:abc123', 'phx_reply', { status: 'ok', response: { users: [] } }]);
  assert.deepEqual(JSON.parse(push('extension:abc123', '1', 'sync:play', { position: 3 })), ['1', null, 'extension:abc123', 'sync:play', { position: 3 }]);
  const heartbeat = parseFrame('[null,"3","phoenix","heartbeat",{}]');
  assert.deepEqual(JSON.parse(reply(heartbeat, 'ok', {})), [null, '3', 'phoenix', 'phx_reply', { status: 'ok', response: {} }]);
});

test('malformed or oversized WebSocket frames are rejected before dispatch', () => {
  for (const frame of ['not json', '{}', '[1,2,3,4,5]', '[null,null,"x","y",null]', '[null,null,"x","y",[]]', ' '.repeat(65537)]) {
    assert.throws(() => parseFrame(frame), /invalid_frame/);
  }
});
