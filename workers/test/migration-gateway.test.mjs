import test from 'node:test';
import assert from 'node:assert/strict';
import gateway from '../scripts/migration-worker.mjs';

const token = 'fixture-only-temporary-migration-token';
const request = (path = '/rooms', headers = {}, body = '{}') => new Request(`https://migration.test${path}`, { method: 'POST', headers, body });

test('migration gateway fails closed without a secret and never accepts URL credentials or browser origins', async () => {
  assert.equal((await gateway.fetch(request(), {})).status, 404);
  const env = { MIGRATION_TOKEN: token };
  assert.equal((await gateway.fetch(request(`/?api_key=${token}`), env)).status, 401);
  assert.equal((await gateway.fetch(request('/rooms', { Authorization: 'Bearer wrong' }), env)).status, 401);
  assert.equal((await gateway.fetch(request('/rooms', { Authorization: `Bearer ${token}`, Origin: 'https://migration.test' }), env)).status, 403);
});

test('migration gateway bounds bodies and hides internal errors rather than exposing exported credentials', async () => {
  const headers = { Authorization: `Bearer ${token}` };
  const env = { MIGRATION_TOKEN: token, ROOMS: { getByName() { return { importLegacy() { throw new Error('fixture-sensitive-state'); } }; } } };
  assert.equal((await gateway.fetch(request('/rooms', headers, 'x'.repeat(1024 * 1024 + 1)), env)).status, 413);
  assert.equal((await gateway.fetch(request('/rooms', headers, '{invalid'), env)).status, 400);
  const response = await gateway.fetch(request('/rooms', headers, JSON.stringify({ room_id: 'oldroom1' })), env);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Import failed.' });
});
