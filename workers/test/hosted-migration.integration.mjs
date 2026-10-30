import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = process.env.BYOB_BASE_URL;
const gateway = process.env.BYOB_MIGRATION_URL;
assert.ok(origin && /^https:\/\/byob-video-preview\.[\w-]+\.workers\.dev$/.test(origin), 'synthetic migration must target the isolated preview');
assert.ok(gateway && /^https:\/\/byob-migration-preview\.[\w-]+\.workers\.dev$/.test(gateway), 'synthetic migration must use the preview-only gateway');
const temp = await mkdtemp(join(tmpdir(), 'byob-hosted-migration-'));
const token = randomBytes(48).toString('base64url');
const roomId = `m${randomBytes(6).toString('hex')}`;
const key = randomBytes(32).toString('base64url');
try {
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'MIGRATION_TOKEN', '--config', 'wrangler.migration.jsonc'], {
    cwd: root, input: `${token}\n`, stdio: ['pipe', 'pipe', 'pipe'],
  });
  execFileSync('mix', ['run', '--no-start', 'workers/test/legacy-fixture.exs', temp], {
    cwd: join(root, '..'), stdio: 'pipe', env: { ...process.env, MIX_ENV: 'test', BYOB_FIXTURE_ROOM_ID: roomId, BYOB_FIXTURE_API_KEY: key },
  });
  const file = join(temp, 'export.json');
  const bytes = await readFile(file);
  const source = JSON.parse(bytes);
  const record = source.rooms[0];
  const hash = createHash('sha256').update(bytes).digest('hex');
  const args = ['scripts/import-legacy.mjs', file, gateway, hash];
  const options = { cwd: root, encoding: 'utf8', env: { ...process.env, MIGRATION_TOKEN: token } };
  const send = (body, headers) => fetch(`${gateway}/rooms`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await send(record, {})).status, 401);
  assert.equal((await send(record, { Authorization: `Bearer ${token}`, Origin: origin })).status, 403);
  const first = JSON.parse(execFileSync(process.execPath, args, options));
  assert.equal(first.rooms_imported, 1);
  const retry = JSON.parse(execFileSync(process.execPath, args, options));
  assert.equal(retry.rooms_imported, 0);
  assert.equal((await send({ ...record, updated_at: record.updated_at + 1 }, { Authorization: `Bearer ${token}` })).status, 409);
  const endpoint = `${origin}/api/rooms/${roomId}`;
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200, 'original legacy API key must authenticate on hosted Worker');
  const state = (await response.json()).data;
  assert.equal(state.current_time, 42);
  assert.equal(state.play_state, 'paused');
  assert.equal(state.user_count, 0, 'import must not resurrect stale presence');
  const queueResponse = await fetch(`${endpoint}/queue`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(queueResponse.status, 200);
  const queue = (await queueResponse.json()).data.queue;
  assert.equal(queue[0].id, record.state.queue[0].id);
  assert.equal(queue[0].title, record.state.queue[0].title);
  assert.equal(queue[0].url, record.state.queue[0].url);
  console.log('PASS: hosted preview legacy SQLite/ETF export→CLI→cross-Worker DO import, original key and paused position/queue preservation, retry idempotency, conflict refusal and Origin/auth boundaries; synthetic data only');
} finally {
  await rm(temp, { recursive: true, force: true });
}
