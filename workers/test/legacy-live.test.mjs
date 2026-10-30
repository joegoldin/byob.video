import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyLive } from '../src/legacy-live.mjs';

const env = { LEGACY_SECRET_KEY_BASE: 'fixture-only-legacy-secret-at-least-32-characters', LEGACY_AUTH_UNTIL: '2000' };
const request = headers => new Request('https://byob.video/live/websocket', { headers });

test('legacy page reload bridge is temporary and rejects cross-origin sockets', () => {
  assert.equal(legacyLive(request({ Upgrade: 'websocket' }), {}, 1000).status, 404);
  assert.equal(legacyLive(request({ Upgrade: 'websocket' }), env, 2000).status, 404);
  assert.equal(legacyLive(request({ Upgrade: 'websocket', Origin: 'https://attacker.test' }), env, 1000).status, 403);
  assert.equal(legacyLive(request({}), env, 1000).status, 426);
});
