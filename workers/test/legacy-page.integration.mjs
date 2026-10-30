import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium, firefox } from 'playwright-core';
import '../scripts/build-web.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'byob-legacy-page-'));
let mf, browser;
try {
  const fixture = JSON.parse(execFileSync('mix', ['run', '--no-start', 'workers/scripts/legacy-auth-fixtures.exs'], { cwd: root, env: { ...process.env, MIX_ENV: 'test' }, encoding: 'utf8' }).trim().split('\n').at(-1));
  const config = JSON.parse(await readFile(join(root, 'workers/wrangler.jsonc'), 'utf8'));
  const workerPath = JSON.stringify(join(root, 'workers/src/index.mjs'));
  // Emulate Wrangler's asset-first dispatch using the deployed configuration.
  const ingress = `import router, {Room, VideoPool} from ${workerPath}; export {Room, VideoPool};
    const routes = ${JSON.stringify(config.assets.run_worker_first)};
    export default {fetch(request, env) {const path = new URL(request.url).pathname;
      return routes.some(route => route.endsWith('*') ? path.startsWith(route.slice(0, -1)) : path === route)
        ? router.fetch(request, env) : env.ASSETS.fetch(request);}};`;
  await build({ stdin: { contents: ingress, resolveDir: root }, outfile: join(temp, 'worker.mjs'), bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });
  let documents = 0;
  mf = new Miniflare({ ...convertV4MiniflareOptions({ name: 'legacy-page', modules: true, modulesRoot: temp, scriptPath: join(temp, 'worker.mjs'), compatibilityDate: config.compatibility_date, cf: false,
    bindings: { TOKEN_SECRET: randomBytes(32).toString('base64url'), LEGACY_SECRET_KEY_BASE: fixture.secret, LEGACY_AUTH_UNTIL: String(Date.now() + 86400000) },
    durableObjects: { ROOMS: { className: 'Room', useSQLite: true }, POOL: { className: 'VideoPool', useSQLite: true } },
    ratelimits: Object.fromEntries(config.ratelimits.map(({ name, ...binding }) => [name, binding])),
    serviceBindings: { ASSETS: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/room/oldroom1' && ++documents === 1) return new Response('<!doctype html><html><body><div id="phx-legacy" data-phx-main data-phx-session="fixture" data-phx-static="">Old Phoenix page</div><script src="/legacy-phoenix.js"></script><script src="/legacy-live.js"></script><script src="/legacy-boot.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
      const assets = { '/assets/app.js': ['assets/app.js', 'text/javascript'], '/assets/app.css': ['assets/app.css', 'text/css'], '/images/logo.svg': ['images/logo.svg', 'image/svg+xml'] };
      const [file, type] = assets[path] ?? ['index.html', 'text/html'];
      return new Response(await readFile(join(root, 'workers/dist', file)), { headers: { 'Content-Type': type } });
    } },
  }), telemetry: { enabled: false } });
  const origin = (await mf.ready).origin;
  const engine = process.env.BYOB_BROWSER || 'chromium';
  assert.ok(['chromium', 'firefox'].includes(engine));
  browser = await (engine === 'firefox' ? firefox : chromium).launch({ executablePath: engine === 'firefox' ? process.env.FIREFOX_PATH : process.env.CHROMIUM_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), headless: true });
  console.log(`Legacy cutover browser: ${engine} ${browser.version()}`);
  const context = await browser.newContext();
  const longpoll = process.env.BYOB_LEGACY_LONGPOLL === '1';
  if (longpoll) await context.addInitScript(() => {
    window.WebSocket = class { constructor() { throw new DOMException('WebSockets blocked for long-poll acceptance', 'SecurityError'); } };
  });
  await context.addCookies([{ name: '_byob_key', value: fixture.cookie, url: origin }]);
  const page = await context.newPage();
  const failures = [], transportErrors = [];
  page.on('console', message => { if (message.type() === 'error') transportErrors.push(message.text()); });
  page.on('pageerror', error => failures.push(error.message));
  await page.route('**/legacy-phoenix.js', route => route.fulfill({ path: join(root, 'deps/phoenix/priv/static/phoenix.js'), contentType: 'text/javascript' }));
  await page.route('**/legacy-live.js', route => route.fulfill({ path: join(root, 'deps/phoenix_live_view/priv/static/phoenix_live_view.js'), contentType: 'text/javascript' }));
  await page.route('**/legacy-boot.js', route => route.fulfill({ contentType: 'text/javascript', body: `sessionStorage.setItem('byob_tab_id', 'tab1'); window.liveSocket = new LiveView.LiveSocket('/live', Phoenix.Socket, {reloadJitterMin: 1, reloadJitterMax: 5, ${longpoll ? 'transport: Phoenix.LongPoll,' : ''}}); liveSocket.socket.onClose(event => window.closeCode = event.code); liveSocket.connect();` }));
  await page.goto(`${origin}/room/oldroom1`);
  try {
    await page.waitForFunction(owner => document.getElementById('player')?.dataset.userId === `${owner}:tab1`, fixture.owner, { timeout: 15000 });
  } catch (error) {
    console.error({ documents, failures, transportErrors, page: await page.evaluate(() => ({ closeCode: window.closeCode, main: window.liveSocket?.main?.id, connected: window.liveSocket?.main?.isConnected(), legacy: !!document.getElementById('phx-legacy'), player: !!document.getElementById('player'), notice: document.getElementById('notice')?.textContent })) });
    throw error;
  }
  assert.equal(documents, 2, 'the old LiveView must reload exactly once into the native frontend');
  assert.deepEqual(failures, []);
  console.log(`PASS: actual Phoenix LiveView ${longpoll ? 'long-poll' : 'WebSocket'} client reloads into native frontend, retaining room URL, cookie identity and tab ID`);
} finally {
  await browser?.close();
  await mf?.dispose();
  await rm(temp, { recursive: true, force: true });
}
