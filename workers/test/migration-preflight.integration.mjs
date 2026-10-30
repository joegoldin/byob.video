import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Production preflight is local-only. Never print records or attach the private
// SQLite files/export to CI; the temporary directory is private and removed.
const file = process.argv[2];
assert.ok(file, 'Pass a private legacy export file');
assert.equal((await stat(file)).mode & 0o777, 0o600);
const bytes = await readFile(file);
const source = JSON.parse(bytes);
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'byob-private-preflight-'));
const token = randomBytes(32).toString('base64url');
let mf;
try {
  const config = JSON.parse(await readFile(join(root, 'wrangler.production.jsonc'), 'utf8'));
  await Promise.all([
    build({ entryPoints: [join(root, 'src/index.mjs')], outfile: join(temp, 'native.mjs'), bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] }),
    build({ entryPoints: [join(root, 'scripts/migration-worker.mjs')], outfile: join(temp, 'importer.mjs'), bundle: true, format: 'esm', platform: 'neutral' }),
  ]);
  mf = new Miniflare({ ...convertV4MiniflareOptions({ cf: false, durableObjectsPersist: join(temp, 'sqlite'), workers: [
    { name: 'importer', modules: true, modulesRoot: temp, scriptPath: join(temp, 'importer.mjs'), compatibilityDate: config.compatibility_date,
      bindings: { MIGRATION_TOKEN: token }, durableObjects: { ROOMS: { className: 'Room', scriptName: 'native' }, POOL: { className: 'VideoPool', scriptName: 'native' } } },
    { name: 'native', routes: ['byob.test/*'], modules: true, modulesRoot: temp, scriptPath: join(temp, 'native.mjs'), compatibilityDate: config.compatibility_date,
      bindings: { TOKEN_SECRET: randomBytes(32).toString('base64url') },
      durableObjects: { ROOMS: { className: 'Room', useSQLite: true }, POOL: { className: 'VideoPool', useSQLite: true } },
      ratelimits: Object.fromEntries(config.ratelimits.map(({ name, ...binding }) => [name, binding])) },
  ] }), telemetry: { enabled: false }, unsafeInspectDurableObjects: true });
  const address = await mf.ready;
  const args = [join(root, 'scripts/import-legacy.mjs'), resolve(file), address.origin, createHash('sha256').update(bytes).digest('hex')];
  const options = { env: { ...process.env, MIGRATION_TOKEN: token }, maxBuffer: 1024 * 1024 };
  const imported = JSON.parse((await promisify(execFile)(process.execPath, args, options)).stdout);
  assert.equal(imported.rooms_imported, source.rooms.length);
  assert.equal(imported.pool_imported, source.pool.length);
  for (const record of source.rooms) {
    const storage = await mf.unsafeGetDurableObjectStorage('native', 'Room', { name: record.room_id });
    const state = JSON.parse((await storage.exec('SELECT state_json FROM room_state'))[0].state_json);
    for (const field of ['room_id', 'api_key', 'queue', 'history', 'play_state', 'current_time']) {
      assert.ok(JSON.stringify(state[field]) === JSON.stringify(record.state[field]), `Preserved room field mismatch: ${field}`);
    }
    assert.equal(Object.keys(state.users).length, 0);
    assert.equal(state.ready_deadline, null);
    await mf.unsafeEvictDurableObject('native', 'Room', { name: record.room_id });
    const response = await mf.dispatchFetch(`https://byob.test/api/rooms/${record.room_id}`, { headers: { Authorization: `Bearer ${record.state.api_key}` } });
    assert.equal(response.status, 200, 'Original API key must work after eviction');
  }
  const storage = await mf.unsafeGetDurableObjectStorage('native', 'VideoPool', { name: 'global' });
  const rows = await storage.exec('SELECT source_type, source_detail, external_id, first_seen_at, last_seen_at, last_picked_at FROM video_pool');
  assert.equal(rows.length, source.pool.length);
  const identity = row => JSON.stringify([row.source_type, row.source_detail, row.external_id]);
  const expected = new Map(source.pool.map(row => [identity(row), row]));
  for (const row of rows) {
    const old = expected.get(identity(row));
    assert.ok(old, 'Pool identity must be preserved');
    for (const field of ['first_seen_at', 'last_seen_at', 'last_picked_at']) assert.ok(row[field] === old[field], `Pool timestamp mismatch: ${field}`);
  }
  const retry = JSON.parse((await promisify(execFile)(process.execPath, args, options)).stdout);
  assert.equal(retry.rooms_imported, 0);
  assert.equal(retry.pool_imported, 0);
  console.log(`PASS: local-only real-data migration of ${source.rooms.length} rooms/${source.pool.length} pool rows; preserved identities, keys, queue/history/playback, exact pool timestamps, eviction authentication and idempotent retry`);
} finally {
  await mf?.dispose();
  await rm(temp, { recursive: true, force: true });
}
