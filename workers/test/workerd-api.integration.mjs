import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomChannel } from '../web/channel.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const persist = await mkdtemp(join(tmpdir(), 'byob-workerd-'));
const origin = 'http://127.0.0.1:18789';
const secretFile = join(persist, '.env');
await writeFile(secretFile, `TOKEN_SECRET=${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
let server, browser, logs = '';

async function start() {
  logs = '';
  server = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', '18789', '--persist-to', persist, '--env-file', secretFile], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Worker startup timeout\n${logs}`)), 30000);
    const receive = chunk => {
      logs = (logs + chunk.toString()).slice(-16000);
      if (logs.includes('Ready on http://127.0.0.1:18789')) { clearTimeout(timeout); resolve(); }
    };
    server.stdout.on('data', receive);
    server.stderr.on('data', receive);
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Worker exited ${code}\n${logs}`)); });
  });
}

async function stop(signal = 'SIGTERM') {
  if (!server || server.exitCode !== null) return;
  const child = server;
  await new Promise(resolve => {
    const timeout = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    process.kill(-child.pid, signal);
  });
  server = null;
}

async function request(path, { key, method = 'GET', body, headers: suppliedHeaders = {} } = {}) {
  const headers = { ...suppliedHeaders };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('Set-Cookie') };
}

try {
  await start();
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/__test/pool-alarm')).status, 404, 'test probes must not exist in the deployable Worker');
  const created = await request('/api/rooms', { method: 'POST' });
  assert.equal(created.status, 201);
  const { room_id: id, api_key: key } = created.body.data;
  assert.match(id, /^[a-z0-9]{8}$/);
  assert.equal(created.body.data.url, `${origin}/room/${id}`);
  const path = `/api/rooms/${id}`;
  const ticket = await request(`/session/${id}`, { method: 'POST', body: { tab_id: 'first-tab' }, headers: { Origin: origin } });
  assert.equal(ticket.status, 200);
  assert.equal(ticket.body.room_id, id);
  assert.match(ticket.cookie, /HttpOnly/);
  const sameTab = await request(`/session/${id}`, { method: 'POST', body: { tab_id: 'first-tab' }, headers: { Origin: origin, Cookie: ticket.cookie.split(';')[0] } });
  assert.equal(sameTab.body.user_id, ticket.body.user_id);
  assert.equal((await request(`/session/${id}`, { method: 'POST', body: { tab_id: 'first-tab' }, headers: { Origin: 'https://attacker.test' } })).status, 403);
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, { key: 'wrong' })).status, 401);
  assert.equal((await request(`${path}/__create?id=forged`, { method: 'POST', key })).status, 404);
  const second = await request('/api/rooms', { method: 'POST' });
  assert.equal((await request(path, { key: second.body.data.api_key })).status, 401);
  assert.equal((await request(`${path}?api_key=${encodeURIComponent(key)}`)).status, 200);
  assert.equal((await request(`${path}/queue`, { method: 'POST', key, body: { url: 'javascript:alert(1)' } })).status, 422);
  assert.equal((await request(`${path}/queue`, { method: 'POST', key, body: { url: `${origin}/room/${id}` } })).status, 422);
  assert.equal((await request(`${path}/queue`, { method: 'POST', key, body: { url: 'x'.repeat(20000) } })).status, 413);
  // Provider metadata is exercised with deterministic upstream fixtures in the socket suite.
  const added = await request(`${path}/queue`, { method: 'POST', key, body: { url: 'https://example.com/movie.mp4' } });
  assert.deepEqual(added, { status: 200, body: { ok: true, data: { message: 'Added to queue.' } }, cookie: null });
  assert.equal((await request(path, { key })).body.data.play_state, 'paused');
  const deadline = Date.now() + 5000;
  let playing = false;
  while (Date.now() < deadline) {
    if ((await request(path, { key })).body.data.play_state === 'playing') { playing = true; break; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(playing, 'the Durable Object alarm starts playback after the readiness deadline');
  assert.equal((await request(`${path}/pause`, { method: 'POST', key, body: { position: 42 } })).status, 200);
  const queueBefore = (await request(`${path}/queue`, { key })).body;
  browser = new RoomChannel({ origin, roomId: id, tabId: 'first-tab', username: () => 'Restart viewer',
    // Node fetch has no browser cookie jar; reuse the cookie already issued above.
    fetch: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Cookie: ticket.cookie.split(';')[0], Origin: origin } }),
  });
  await browser.start();
  assert.equal(browser.joined, true);
  assert.equal((await browser.request('sync:request_state')).user_id, ticket.body.user_id);
  assert.ok((await request(`${path}/users`, { key })).body.data.users.find(user => user.id === ticket.body.user_id)?.connected);
  await stop('SIGKILL');
  browser.stop();
  await start();
  const restored = await request(path, { key });
  assert.equal(restored.status, 200, 'API key survives a real runtime restart');
  assert.equal(restored.body.data.current_time, 42);
  assert.equal(restored.body.data.play_state, 'paused');
  assert.deepEqual((await request(`${path}/queue`, { key })).body, queueBefore);
  let disconnected = false;
  for (let attempt = 0; attempt < 14; attempt++) {
    const users = (await request(`${path}/users`, { key })).body.data.users;
    if (users.find(user => user.id === ticket.body.user_id)?.connected === false) { disconnected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(disconnected, 'a hard runtime crash must not leave a phantom connected viewer');
  await browser.start();
  const reconnectTrace = [];
  browser.on('connection:error', error => reconnectTrace.push(error.message));
  const reconnected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`Native browser reconnect timeout: ${JSON.stringify({ trace: reconnectTrace, readyState: browser.socket.readyState, joined: browser.joined })}`)); }, 5000);
    const off = browser.on('status', status => {
      reconnectTrace.push(status.state);
      if (status.state === 'connected' && status.reconnected) { clearTimeout(timer); off(); resolve(); }
    });
  });
  browser.socket.close();
  await reconnected;
  const snapshot = await browser.request('sync:request_state');
  assert.equal(snapshot.user_id, ticket.body.user_id);
  assert.equal(snapshot.play_state, 'paused');
  assert.equal(snapshot.current_time, 42);
  let rateAnchor;
  browser.on('sync:rate', data => { rateAnchor = data; });
  await browser.request('video:rate', { rate: 2 });
  assert.equal(rateAnchor.current_time, 42);
  assert.equal(rateAnchor.rate, 2);
  assert.equal(typeof rateAnchor.server_time, 'number');
  let limited = false;
  for (let i = 0; i < 65; i++) {
    if ((await request(path, { key })).status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'authenticated reads enforce the configured rate limit');
  console.log('PASS: workerd signed session/bootstrap, API auth/isolation, bounded bodies, queue responses, real alarm, SQLite restart and rate limiting');
} finally {
  browser?.stop();
  await stop();
  await rm(persist, { recursive: true, force: true });
}
