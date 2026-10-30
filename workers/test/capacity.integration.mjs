import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'byob-capacity-'));
const config = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
let mf;
try {
  await build({ entryPoints: [join(root, 'test/runtime-entry.mjs')], outfile: join(temp, 'worker.mjs'), bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });
  const options = { ...convertV4MiniflareOptions({ name: 'capacity-test', modules: true, modulesRoot: temp, scriptPath: join(temp, 'worker.mjs'), compatibilityDate: config.compatibility_date,
    durableObjects: { ROOMS: { className: 'Room', useSQLite: true }, POOL: { className: 'VideoPool', useSQLite: true } }, durableObjectsPersist: join(temp, 'storage'),
    bindings: { TOKEN_SECRET: randomBytes(32).toString('base64url') },
    // Isolate global/socket gates from independently tested per-IP limits.
    ratelimits: Object.fromEntries(config.ratelimits.map(({ name, ...binding }) => [name, ['CREATE_LIMITER', 'JOIN_LIMITER'].includes(name) ? { ...binding, simple: { limit: 1000, period: 60 } } : binding])), cf: false,
  }), resourcePersistencePath: join(temp, 'storage') };
  mf = new Miniflare({ ...options, telemetry: { enabled: false } });
  const create = () => mf.dispatchFetch('https://byob.test/api/rooms', { method: 'POST' });
  const responses = await Promise.all(Array.from({ length: 120 }, create));
  assert.equal(responses.filter(response => response.status === 201).length, 100);
  assert.equal(responses.filter(response => response.status === 429).length, 20);
  for (const response of responses.filter(response => response.status === 429)) assert.match((await response.json()).error, /100-room capacity/);
  const named = await mf.dispatchFetch('https://byob.test/session/namedcap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tab_id: 'named' }) });
  assert.equal(named.status, 429, 'named room bootstrap cannot bypass the global cap');
  assert.match((await named.json()).error, /100-room capacity/);
  const rooms = await Promise.all(responses.filter(response => response.status === 201).map(async response => (await response.json()).data));
  const get = (room, key = room.api_key) => mf.dispatchFetch(`https://byob.test/api/rooms/${room.room_id}`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal((await get(rooms[0])).status, 200);
  await mf.dispose();
  mf = new Miniflare({ ...options, telemetry: { enabled: false } });
  assert.equal((await create()).status, 429, 'cold restart must retain the global count');
  assert.equal((await get(rooms[0])).status, 200, 'existing admitted rooms remain usable at capacity');
  const sockets = [];
  for (let index = 0; index < 33; index++) {
    const session = await mf.dispatchFetch(`https://byob.test/session/${rooms[0].room_id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tab_id: `tab${index}` }) });
    assert.equal(session.status, 200);
    const { token } = await session.json();
    const response = await mf.dispatchFetch(`https://byob.test/socket/websocket?token=${encodeURIComponent(token)}`, { headers: { Upgrade: 'websocket' } });
    assert.equal(response.status, index < 32 ? 101 : 429, 'room sockets must be capped at32');
    if (response.status === 101) { response.webSocket.accept(); sockets.push(response.webSocket); }
  }
  const flooded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message flood was not disconnected')), 5000);
    sockets[0].addEventListener('close', event => { clearTimeout(timer); resolve(event.code); }, { once: true });
  });
  for (let index = 0; index < 61; index++) sockets[0].send(JSON.stringify([null, String(index), 'phoenix', 'heartbeat', {}]));
  assert.equal(await flooded, 1008);
  for (const socket of sockets.slice(1)) socket.close(1000, 'Test complete');
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await (await mf.dispatchFetch(`https://byob.test/__test/idle/${rooms[0].room_id}`)).json();
    if (!state.connections) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  async function retire(room) {
    const url = `https://byob.test/__test/idle/${room.room_id}`;
    assert.equal((await mf.dispatchFetch(url, { method: 'POST' })).status, 200);
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await (await mf.dispatchFetch(url)).json();
      if (state.expired_at && state.alarm === null) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('One-shot idle retirement did not finish');
  }
  await retire(rooms[0]);
  assert.equal((await get(rooms[0], 'wrong-key')).status, 401, 'invalid credentials must not consume the free capacity slot');
  assert.equal((await create()).status, 201, 'retirement must free exactly one slot');
  assert.equal((await get(rooms[0])).status, 429, 'saved-room reactivation cannot bypass the global cap');
  const fullSession = await mf.dispatchFetch(`https://byob.test/session/${rooms[0].room_id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tab_id: 'reopen' }) });
  assert.equal(fullSession.status, 429);
  assert.match((await fullSession.json()).error, /100-room capacity/, 'browser bootstrap must explain capacity refusal');
  await retire(rooms[1]);
  const restored = await get(rooms[0]);
  assert.equal(restored.status, 200, 'retired rooms retain their original API keys');
  assert.equal((await restored.json()).data.room_id, rooms[0].room_id);
  assert.equal((await create()).status, 429, 'reactivation consumes the released slot');
  const reactivated = await (await mf.dispatchFetch(`https://byob.test/__test/idle/${rooms[0].room_id}`)).json();
  assert.ok(reactivated.deadline > Date.now() + 23 * 3600000 && reactivated.deadline <= Date.now() + 24 * 3600000);
  console.log('PASS: concurrent global100-room cap, cold restart, authenticated reactivation, one-shot24h slot retirement and original-key preservation,32-connection ceiling and message-flood disconnection');
} finally {
  await mf?.dispose();
  await rm(temp, { recursive: true, force: true });
}
