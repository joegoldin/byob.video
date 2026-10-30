import test from 'node:test';
import assert from 'node:assert/strict';
import { roomTicket } from '../src/session.mjs';
import { verifyToken } from '../src/auth.mjs';

const secret = 'test-only-session-signing-key-not-production';
const request = cookie => new Request('https://byob.video/session/abc123', { headers: { Origin: 'https://byob.video', ...(cookie ? { Cookie: cookie } : {}) } });

test('same browser/tab retains signed identity; other tabs remain independently identifiable', async () => {
  const first = await roomTicket(secret, request(), 'abc123', 'tab1', 1000);
  const repeated = await roomTicket(secret, request(first.cookie), 'abc123', 'tab1', 2000);
  const other = await roomTicket(secret, request(first.cookie), 'abc123', 'tab2', 2000);
  assert.equal(first.user_id, repeated.user_id);
  assert.notEqual(first.user_id, other.user_id);
  assert.equal(first.user_id.split(':')[0], other.user_id.split(':')[0]);
  const claims = await verifyToken(secret, first.token, 'room', 1001);
  assert.equal(claims.room, 'abc123');
  assert.equal(claims.owner, first.user_id);
  assert.match(first.cookie, /Secure; HttpOnly; SameSite=Lax/);
  assert.equal(await verifyToken(secret, first.token, 'session', 1001), null);
});

test('cross-origin bootstrap and malformed room/tab identifiers cannot mint tickets', async () => {
  const crossOrigin = new Request('https://byob.video/session/abc123', { headers: { Origin: 'https://attacker.test' } });
  await assert.rejects(roomTicket(secret, crossOrigin, 'abc123', 'tab1', 1000), /invalid_origin/);
  await assert.rejects(roomTicket(secret, request(), '../room', 'tab1', 1000), /invalid_room/);
  await assert.rejects(roomTicket(secret, request(), 'abc123', 'owner:tab', 1000), /invalid_tab/);
  const tampered = await roomTicket(secret, request('__Host-byob_session=forged'), 'abc123', 'tab1', 1000);
  assert.match(tampered.user_id, /^[0-9a-f-]+:tab1$/);
});
