import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { legacySession, legacyExtension } from '../src/legacy-auth.mjs';
import { roomTicket } from '../src/session.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(execFileSync('mix', ['run', '--no-start', 'workers/scripts/legacy-auth-fixtures.exs'], { cwd: root, env: { ...process.env, MIX_ENV: 'test' }, encoding: 'utf8' }).trim().split('\n').at(-1));
const now = 1700000000001;
const env = { LEGACY_SECRET_KEY_BASE: fixture.secret, LEGACY_AUTH_UNTIL: String(now + 3 * 86400000) };

test('real Plug cookie and Phoenix extension signatures retain the legacy owner with isolated purposes', async () => {
  assert.deepEqual(await legacySession(env, fixture.cookie, now), { id: fixture.owner });
  assert.equal((await legacyExtension(env, fixture.extension, now)).owner, `${fixture.owner}:tab1`);
  assert.match((await legacyExtension(env, fixture.old_extension, now)).owner, /^legacy:/);
  assert.equal(await legacySession(env, fixture.extension, now), null);
  assert.equal(await legacyExtension(env, fixture.cookie, now), null);
});

test('legacy authentication rejects tampering, expiry, future signatures and disabled compatibility', async () => {
  assert.equal(await legacySession({}, fixture.cookie, now), null);
  assert.equal(await legacySession({ ...env, LEGACY_AUTH_UNTIL: String(now) }, fixture.cookie, now), null);
  assert.equal(await legacySession({ ...env, LEGACY_SECRET_KEY_BASE: 'wrong'.repeat(16) }, fixture.cookie, now), null);
  assert.equal(await legacySession(env, `${fixture.cookie.slice(0, -8)}AAAAAAAA`, now), null);
  assert.equal(await legacyExtension(env, fixture.extension, now + 86400000), null);
  assert.equal(await legacyExtension(env, fixture.extension, now - 120000), null);
  assert.equal(await legacySession(env, 'x'.repeat(8193), now), null);
});

test('bootstrap exchanges a verified legacy identity once, preferring the native cookie thereafter', async () => {
  const secret = 'fixture-native-secret-at-least-32-characters';
  const request = cookie => new Request('https://byob.video/session/oldroom1', { headers: { Cookie: cookie } });
  const migrated = await roomTicket(secret, request(`_byob_key=${fixture.cookie}`), 'oldroom1', 'tab1', now, env);
  assert.equal(migrated.user_id, `${fixture.owner}:tab1`);
  const continued = await roomTicket(secret, request(migrated.cookie), 'oldroom1', 'tab1', now + 1, {});
  assert.equal(continued.user_id, migrated.user_id, 'migration no longer needs the legacy secret');
  const native = await roomTicket(secret, request(''), 'oldroom1', 'tab1', now, env);
  const preferred = await roomTicket(secret, request(`${native.cookie}; _byob_key=${fixture.cookie}`), 'oldroom1', 'tab1', now + 1, env);
  assert.equal(preferred.user_id, native.user_id);
  assert.notEqual((await roomTicket(secret, request(`_byob_key=${fixture.cookie}`), 'oldroom1', 'tab1', now, {})).user_id, migrated.user_id);
});
