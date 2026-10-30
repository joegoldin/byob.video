import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyLive } from '../src/legacy-live.mjs';

const env = { TOKEN_SECRET: 'fixture-only-native-key-at-least-32-characters', LEGACY_SECRET_KEY_BASE: 'fixture-only-legacy-key-at-least-32-characters', LEGACY_AUTH_UNTIL: '90000', JOIN_LIMITER: { limit: async () => ({ success: true }) } };
const request = (token = 'null', options = {}) => new Request(`https://byob.test/live/longpoll?token=${token}`, options);
async function session() { return (await (await legacyLive(request(), env, 1000)).json()).token; }
const frame = JSON.stringify(['1', '2', 'lv:fixture', 'phx_join', { session: 'must-not-be-copied' }]);

test('legacy long-poll carries only signed stale-join replies to the matching connection', async () => {
  const token = await session();
  const posted = await legacyLive(request(token, { method: 'POST', body: frame }), env, 1001);
  assert.equal(posted.status, 200);
  const cookie = posted.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Secure/);
  const polled = await legacyLive(request(token, { headers: { Cookie: cookie } }), env, 1002);
  const result = await polled.json();
  assert.equal(result.status, 200);
  assert.deepEqual(result.messages.map(JSON.parse), [['1', '2', 'lv:fixture', 'phx_reply', { status: 'error', response: { reason: 'stale' } }]]);
  assert.equal(JSON.stringify(result).includes('must-not-be-copied'), false);
  assert.match(polled.headers.get('Set-Cookie'), /Max-Age=0/);
  const other = await session();
  assert.equal((await (await legacyLive(request(other, { headers: { Cookie: cookie } }), env, 1002)).json()).status, 204);
  assert.equal((await (await legacyLive(request(token, { headers: { Cookie: cookie } }), env, 31000)).json()).status, 410);
});

test('legacy long-poll bounds frames, rejects foreign origins and ends at the compatibility cutoff', async () => {
  const token = await session();
  assert.equal((await legacyLive(request(token, { method: 'POST', body: 'x'.repeat(65537) }), env, 1001)).status, 413);
  assert.equal((await legacyLive(request(token, { method: 'POST', body: 'invalid' }), env, 1001)).status, 400);
  assert.equal((await legacyLive(request(token, { method: 'POST', headers: { Origin: 'https://attacker.test' }, body: frame }), env, 1001)).status, 403);
  assert.equal((await legacyLive(request(token), env, 90000)).status, 404);
});
