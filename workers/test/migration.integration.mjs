import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { once } from 'node:events';
import { HttpSocket } from '../web/http-socket.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'byob-migration-'));
const token = randomBytes(32).toString('base64url');
let mf;
const connections = [];
try {
  const legacy = JSON.parse(execFileSync('mix', ['run', '--no-start', 'workers/scripts/legacy-auth-fixtures.exs', String(Math.floor(Date.now() / 1000))], { cwd: join(root, '..'), env: { ...process.env, MIX_ENV: 'test' }, encoding: 'utf8' }).trim().split('\n').at(-1));
  execFileSync('mix', ['run', '--no-start', 'workers/test/legacy-fixture.exs', temp], { cwd: join(root, '..'), env: { ...process.env, MIX_ENV: 'test' }, stdio: 'pipe' });
  const exportLog = execFileSync('mix', ['run', '--no-start', 'workers/scripts/export-legacy.exs', join(temp, 'legacy.db'), join(temp, 'cli-export.json')], { cwd: join(root, '..'), env: { ...process.env, MIX_ENV: 'test' }, encoding: 'utf8' });
  assert.match(exportLog, /Exported 1 rooms and 1 pool rows; SHA256 [a-f0-9]{64}/);
  assert.equal(exportLog.includes('fixture-migration-room-key'), false);
  const bytes = await readFile(join(temp, 'cli-export.json'));
  const exported = JSON.parse(bytes.toString('utf8'));
  assert.equal(exported.format, 'byob-legacy-export-v1');
  const [record] = exported.rooms;
  const config = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
  await Promise.all([
    build({ entryPoints: [join(root, 'test/runtime-entry.mjs')], outfile: join(temp, 'native.mjs'), bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] }),
    build({ entryPoints: [join(root, 'scripts/migration-worker.mjs')], outfile: join(temp, 'importer.mjs'), bundle: true, format: 'esm', platform: 'neutral' }),
  ]);
  mf = new Miniflare({ ...convertV4MiniflareOptions({ cf: false, workers: [
    { name: 'importer', modules: true, modulesRoot: temp, scriptPath: join(temp, 'importer.mjs'), compatibilityDate: config.compatibility_date,
      bindings: { MIGRATION_TOKEN: token }, durableObjects: { ROOMS: { className: 'Room', scriptName: 'native' }, POOL: { className: 'VideoPool', scriptName: 'native' } } },
    { name: 'native', routes: ['byob.test/*'], modules: true, modulesRoot: temp, scriptPath: join(temp, 'native.mjs'), compatibilityDate: config.compatibility_date,
      bindings: { TOKEN_SECRET: randomBytes(32).toString('base64url'), LEGACY_SECRET_KEY_BASE: legacy.secret, LEGACY_AUTH_UNTIL: String(Date.now() + 86400000) },
      durableObjects: { ROOMS: { className: 'Room', useSQLite: true }, POOL: { className: 'VideoPool', useSQLite: true } },
      ratelimits: Object.fromEntries(config.ratelimits.map(({ name, ...binding }) => [name, binding])) },
  ] }), telemetry: { enabled: false }, unsafeInspectDurableObjects: true });
  await mf.ready;
  // dispatchFetch exercises ingress; getWorker's Node RPC proxy rejects Origin
  // headers before the application sees them.
  const native = { fetch: (...args) => mf.dispatchFetch(...args) };
  const send = (path, body, headers = { Authorization: `Bearer ${token}` }) => mf.dispatchFetch(`https://migration.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await send('/rooms', record, {})).status, 401);
  assert.equal((await send('/rooms', record, { Authorization: `Bearer ${token}`, Origin: 'https://migration.test' })).status, 403);
  assert.equal((await native.fetch('https://byob.test/rooms', { method: 'POST', body: JSON.stringify(record) })).status, 404);
  const args = [join(root, 'scripts/import-legacy.mjs'), join(temp, 'cli-export.json'), (await mf.ready).origin, createHash('sha256').update(bytes).digest('hex')];
  const options = { env: { ...process.env, MIGRATION_TOKEN: token } };
  await assert.rejects(promisify(execFile)(process.execPath, [...args.slice(0, -1), '0'.repeat(64)], options), error => error.stderr.includes('checksum mismatch'));
  const imported = await promisify(execFile)(process.execPath, args, options);
  assert.equal(JSON.parse(imported.stdout).rooms_imported, 1);
  assert.equal(JSON.parse(imported.stdout).pool_imported, 1);
  assert.equal(imported.stdout.includes(record.state.api_key), false);
  let response = await send('/rooms', record);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported: false });
  assert.equal((await send('/rooms', { ...record, updated_at: record.updated_at + 1 })).status, 409);
  response = await send('/pool', { entries: exported.pool });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported: 0, skipped: 1 });
  assert.deepEqual(await (await send('/pool', { entries: exported.pool })).json(), { imported: 0, skipped: 1 });
  const poolStorage = await mf.unsafeGetDurableObjectStorage('native', 'VideoPool', { name: 'global' });
  const [pool] = await poolStorage.exec('SELECT first_seen_at, last_seen_at, last_picked_at FROM video_pool');
  assert.deepEqual(pool, { first_seen_at: 1001, last_seen_at: 2002, last_picked_at: 3003 });
  const api = `/api/rooms/${record.room_id}`;
  const stateResponse = await native.fetch(`https://byob.test${api}`, { headers: { Authorization: `Bearer ${record.state.api_key}` } });
  assert.equal(stateResponse.status, 200, 'the original API key must authenticate');
  const state = await stateResponse.json();
  assert.equal(state.data.current_time, 42);
  assert.equal(state.data.play_state, 'paused');
  assert.equal(state.data.user_count, 0);
  const roomStorage = await mf.unsafeGetDurableObjectStorage('native', 'Room', { name: record.room_id });
  const persisted = JSON.parse((await roomStorage.exec('SELECT state_json FROM room_state'))[0].state_json);
  assert.deepEqual(persisted.history, record.state.history);
  assert.deepEqual(persisted.queue, record.state.queue);
  assert.equal(persisted.playback_rate, 1.5);
  assert.equal((await (await native.fetch(`https://byob.test/__test/idle/${record.room_id}`)).json()).alarm, null);
  assert.equal((await (await native.fetch('https://byob.test/__test/pool-alarm')).json()).alarm, null);
  await mf.unsafeEvictDurableObject('native', 'Room', { name: record.room_id });
  assert.equal((await native.fetch(`https://byob.test${api}`, { headers: { Authorization: `Bearer ${record.state.api_key}` } })).status, 200);
  const bootstrap = await native.fetch('https://byob.test/session/oldroom1', { method: 'POST', headers: { Cookie: `_byob_key=${legacy.cookie}`, Origin: 'https://byob.test' }, body: JSON.stringify({ tab_id: 'tab1' }) });
  assert.equal(bootstrap.status, 200);
  const browserTicket = await bootstrap.json();
  assert.equal(browserTicket.user_id, `${legacy.owner}:tab1`);
  assert.match(bootstrap.headers.get('Set-Cookie'), /^__Host-byob_session=/);
  assert.equal((await native.fetch(`https://byob.test/socket/websocket?token=${legacy.extension}`, { headers: { Upgrade: 'websocket' } })).status, 401, 'legacy extension tickets must not authorize browser sockets');
  const upgrade = await native.fetch(`https://byob.test/extension/websocket?token=${legacy.extension}`, { headers: { Upgrade: 'websocket' } });
  assert.equal(upgrade.status, 101);
  const socket = upgrade.webSocket;
  connections.push(socket);
  socket.accept();
  const joined = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Legacy extension join timed out')), 5000);
    socket.addEventListener('message', event => {
      const frame = JSON.parse(event.data);
      if (frame[1] === '1' && frame[3] === 'phx_reply') { clearTimeout(timeout); resolve(frame[4]); }
    });
  });
  socket.send(JSON.stringify(['1', '1', 'extension:oldroom1', 'phx_join', {}]));
  assert.equal((await joined).status, 'ok');
  const peers = await (await native.fetch(`https://byob.test${api}/users`, { headers: { Authorization: `Bearer ${record.state.api_key}` } })).json();
  assert.ok(peers.data.users.some(peer => peer.id === `ext:${legacy.owner}:tab1`));
  const http = new HttpSocket(`wss://byob.test/socket/websocket?token=${browserTicket.token}`, { fetch: native.fetch });
  connections.push(http);
  await once(http, 'open');
  const httpJoin = once(http, 'message');
  http.send(JSON.stringify(['1', '1', 'room:oldroom1', 'phx_join', { username: 'HTTP viewer' }]));
  assert.equal(JSON.parse((await httpJoin)[0].data)[4].status, 'ok');
  const otherTicket = await (await native.fetch('https://byob.test/session/oldroom1', { method: 'POST', body: JSON.stringify({ tab_id: 'other' }) })).json();
  const stolen = new URL(http.endpoint('/socket/message'));
  stolen.searchParams.set('token', otherTicket.token);
  const mutation = JSON.stringify({ frame: JSON.stringify(['1', '2', 'room:oldroom1', 'video:seek', { position: 99 }]) });
  assert.equal((await native.fetch(stolen, { method: 'POST', body: mutation })).status, 409, 'another signed owner cannot send through this connection');
  assert.equal((await native.fetch(http.endpoint('/socket/message'), { method: 'POST', headers: { Origin: 'https://attacker.test' }, body: mutation })).status, 403);
  assert.equal((await native.fetch(http.endpoint('/socket/stream'))).status, 409, 'duplicate stream identifiers cannot steal an existing connection');
  http.close();
  console.log('PASS: HTTP stream joins through the existing room protocol; cross-owner sends, cross-origin mutations and duplicate stream takeover are rejected');
  console.log('PASS: real Plug cookie bootstrap and Phoenix extension reconnect preserve the migrated owner; extension credentials cannot open browser sockets');
  console.log('PASS: legacy SQLite/ETF export → authenticated cross-worker RPC import → SQLite eviction/reload, preserved keys/history/pool timestamps, idempotency and dormant alarms');
} finally {
  for (const socket of connections) socket.close(1000);
  await mf?.dispose();
  await rm(temp, { recursive: true, force: true });
}
