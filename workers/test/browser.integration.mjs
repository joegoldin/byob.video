import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright-core';
import { build } from 'esbuild';
import { landingSlice } from '../src/round.mjs';
import { alignSample } from './browser-timing.mjs';
import '../scripts/build-web.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'byob-browser-'));
const origin = 'http://127.0.0.1:18791';
const engine = process.env.BYOB_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox'].includes(engine), 'BYOB_BROWSER must be chromium or firefox');
let worker, browser, media;
let logs = '';
try {
  await writeFile(join(temp, '.env'), `TOKEN_SECRET=${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '60', '-c:v', 'libvpx', '-g', '10', '-b:v', '40k', '-c:a', 'libopus', join(temp, 'fixture.webm')]);
  const video = await readFile(join(temp, 'fixture.webm'));
  media = createServer((request, response) => {
    const headers = { 'Content-Type': 'video/webm', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' };
    // Chromium otherwise treats corrective seeks as unseekable and jumps to
    // zero, falsely making the synchronization loop look increasingly late.
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
    if ((request.headers.range && !range) || start > end) {
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${video.length}` }); response.end(); return;
    }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${video.length}`;
    response.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 });
    response.end(request.method === 'HEAD' ? undefined : video.subarray(start, end + 1));
  });
  await new Promise(resolve => media.listen(0, '127.0.0.1', resolve));
  worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', '18791', '--persist-to', join(temp, 'storage'), '--env-file', join(temp, '.env')], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Browser Worker startup timeout\n${logs}`)), 30000);
    const receive = chunk => { logs = (logs + chunk).slice(-12000); if (logs.includes('Ready on http://127.0.0.1:18791')) { clearTimeout(timeout); resolve(); } };
    worker.stdout.on('data', receive); worker.stderr.on('data', receive);
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', code => { clearTimeout(timeout); reject(new Error(`Browser Worker exited ${code}\n${logs}`)); });
  });
  browser = await (engine === 'firefox' ? firefox : chromium).launch({
    executablePath: engine === 'firefox' ? process.env.FIREFOX_PATH : process.env.CHROMIUM_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
    headless: true,
  });
  console.log(`Browser: ${engine} ${browser.version()}`);
  const errors = [];
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 1280, height: 800 } }), browser.newContext({ viewport: { width: 390, height: 844 } })]);
  for (const context of contexts) await context.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    const trace = window.__mediaTrace = [];
    const record = (video, event, target) => {
      if (!video.closest('#player')) return;
      trace.push({ event, target, position: video.currentTime, at: Date.now(), seeking: video.seeking, paused: video.paused, rate: video.playbackRate });
      if (trace.length > 60) trace.shift();
    };
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { ...descriptor, set(value) { record(this, 'set', value); descriptor.set.call(this, value); } });
    for (const event of ['seeking', 'seeked', 'loadedmetadata']) document.addEventListener(event, e => { if (e.target instanceof HTMLMediaElement) record(e.target, event); }, true);
  });
  if (process.env.BYOB_NETWORK_PROFILE === 'delayed') {
    assert.notEqual(process.env.BYOB_HTTP_ONLY, '1', 'the delayed WebSocket profile must not silently test HTTP instead');
    for (const context of contexts) await context.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          this.outboundDue = this.inboundDue = 0;
          this.outboundCount = this.inboundCount = 0;
        }
        send(data) {
          // Preserve ordered transport while varying latency deterministically.
          const now = performance.now();
          const delay = 100 + [0, 35, 10, 45, 20][this.outboundCount++ % 5];
          this.outboundDue = Math.max(now + delay, this.outboundDue + 1);
          setTimeout(() => { if (this.readyState === NativeSocket.OPEN) super.send(data); }, this.outboundDue - now);
        }
        addEventListener(type, listener, options) {
          if (type !== 'message') return super.addEventListener(type, listener, options);
          return super.addEventListener(type, event => {
            const now = performance.now();
            const delay = 150 + [45, 10, 20, 0, 35][this.inboundCount++ % 5];
            this.inboundDue = Math.max(now + delay, this.inboundDue + 1);
            setTimeout(() => {
              if (this.readyState === NativeSocket.OPEN) listener.call(this, event);
            }, this.inboundDue - now);
          }, options);
        }
      };
    });
    console.log('Acceptance impairment: ordered WebSocket sends +100–145ms, message callbacks +150–195ms');
  }
  if (process.env.BYOB_HTTP_ONLY === '1') {
    for (const context of contexts) await context.addInitScript(() => {
      window.WebSocket = class { constructor() { throw new DOMException('WebSockets blocked for HTTP acceptance', 'SecurityError'); } };
      const dispatch = EventTarget.prototype.dispatchEvent;
      EventTarget.prototype.dispatchEvent = function (event) {
        if (event.type === 'message' && this.url instanceof URL && this.url.pathname === '/socket/websocket') void window.__httpFrame?.(event.data);
        return dispatch.call(this, event);
      };
    });
    console.log('Acceptance transport: HTTP only; browser WebSocket construction blocked');
  }
  for (const context of contexts) await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const mediaCheck = await contexts[0].newPage();
  await mediaCheck.setContent(`<video muted autoplay src="http://127.0.0.1:${media.address().port}/fixture.webm"></video>`);
  await mediaCheck.waitForFunction(() => document.querySelector('video').readyState >= 2);
  const seekPosition = await mediaCheck.evaluate(() => new Promise(resolve => {
    const video = document.querySelector('video');
    video.addEventListener('seeked', () => resolve(video.currentTime), { once: true });
    video.currentTime = 20;
  }));
  assert.ok(Math.abs(seekPosition - 20) < 0.1, `Media fixture cannot seek: ${seekPosition}`);
  const directFixture = await build({ entryPoints: [fileURLToPath(new URL('../../assets/js/players/direct.js', import.meta.url))], bundle: true, format: 'iife', globalName: 'DirectFixture', write: false });
  await mediaCheck.addScriptTag({ content: directFixture.outputFiles[0].text });
  const seekReports = await mediaCheck.evaluate(async url => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const reports = [];
    let ready;
    const loaded = new Promise(resolve => { ready = resolve; });
    const player = DirectFixture.create(container, { onReady: ready, onStateChange() {}, onSeeked: position => reports.push(position) }, { url });
    await loaded;
    // Start another seek before the older completion reaches the adapter.
    // This deterministically exposes stale completion ownership in a real player.
    player.raw.addEventListener('seeked', () => player.seek(12), { capture: true, once: true });
    await new Promise(resolve => {
      const completed = () => {
        if (player.raw.seeking || Math.abs(player.raw.currentTime - 12) > 0.1) return;
        player.raw.removeEventListener('seeked', completed);
        resolve();
      };
      player.raw.addEventListener('seeked', completed);
      player.seek(10);
    });
    const programmatic = [...reports];
    await new Promise(resolve => {
      player.raw.addEventListener('seeked', resolve, { once: true });
      player.raw.currentTime = 14;
    });
    player.destroy();
    return { programmatic, all: reports };
  }, `http://127.0.0.1:${media.address().port}/fixture.webm`);
  assert.deepEqual(seekReports.programmatic, [], 'a stale completion must not turn the newer programmatic seek into a user command');
  assert.equal(seekReports.all.length, 1, 'a subsequent native seek must still reach the room');
  assert.ok(Math.abs(seekReports.all[0] - 14) < 0.1);
  console.log('PASS: overlapping direct seeks retain ownership without swallowing subsequent native seeks');
  await mediaCheck.close();
  const [alice, bob] = await Promise.all(contexts.map(context => context.newPage()));
  const traces = new Map(), references = new Map();
  for (const page of [alice, bob]) {
    page.on('pageerror', error => errors.push(error.message));
    const trace = [], anchors = []; traces.set(page, trace); references.set(page, anchors);
    const recordFrame = (direction, message) => {
        const [, , , event, payload] = JSON.parse(String(message));
        if (direction === 'framereceived' && ['sync:play', 'sync:rate', 'sync:correction', 'sync:heartbeat'].includes(event)) {
          const position = payload.current_time ?? payload.expected_time ?? payload.time;
          if (Number.isFinite(position) && Number.isFinite(payload.server_time)) {
            anchors.push({ position, at: payload.server_time });
            if (anchors.length > 20) anchors.shift();
          }
        }
        if (!['video:seek', 'sync:seek', 'sync:seek_command', 'video:pause', 'sync:pause', 'video:play', 'sync:play', 'sync:rate'].includes(event)) return;
        trace.push({ direction, event, position: payload.position, time: payload.time, rate: payload.rate, current_time: payload.current_time, server_time: payload.server_time });
        if (trace.length > 30) trace.shift();
    };
    await page.exposeFunction('__httpFrame', message => recordFrame('framereceived', message));
    page.on('websocket', socket => {
      for (const direction of ['framesent', 'framereceived']) socket.on(direction, frame => recordFrame(direction, frame.payload));
    });
  }
  const screenshots = await mkdtemp(join(tmpdir(), 'byob-browser-review-'));
  console.log(`Screenshots: ${screenshots}`);
  for (const page of [alice, bob]) {
    await page.goto(origin);
    await page.locator('[data-action="create-room"]').waitFor();
    const homeGap = await page.evaluate(() => document.querySelector('section').getBoundingClientRect().top - document.querySelector('nav').getBoundingClientRect().bottom);
    assert.ok(homeGap >= 24, 'Home information card must be padded below the navigation on desktop and mobile');
    await page.screenshot({ path: join(screenshots, page === alice ? 'home.png' : 'home-mobile.png'), fullPage: true });
  }
  await alice.locator('[data-action="create-room"]').click();
  await alice.waitForURL(/\/room\/[a-z0-9]{8}$/);
  const roomUrl = alice.url();
  await bob.goto(roomUrl);
  for (const page of [alice, bob]) {
    try { await page.waitForFunction(() => document.getElementById('connection-status')?.textContent === ''); }
    catch (error) { throw new Error(`${error.message}; ${JSON.stringify({ errors, page: await page.locator('body').innerText() })}`); }
    assert.ok((await page.locator('#url-input').boundingBox()).width >= 160, 'URL input must remain usable on mobile');
    assert.equal(await page.locator('[data-action="pause"]').count(), 0, 'No duplicate controls below the player');
    assert.ok(await page.locator('#users-panel .bg-success').count(), 'Connected users have a green status dot');
    await page.screenshot({ path: join(screenshots, page === alice ? 'empty-desktop.png' : 'empty-mobile.png'), fullPage: true });
    if (page === alice) {
      await page.locator('[data-action="settings"]').click();
      await page.waitForFunction(() => document.getElementById('room-api-key')?.value.length > 20);
      assert.ok((await page.locator('#settings-modal .modal-box').boundingBox()).width <= 448);
      await page.screenshot({ path: join(screenshots, 'settings.png'), fullPage: true, animations: 'disabled' });
      await page.locator('[aria-label="Close settings"]').click();
    }
    await page.locator('[data-action="theme"]').click();
  }
  await alice.locator('#url-input').fill('not a video URL');
  await alice.waitForFunction(() => document.getElementById('url-preview').textContent.includes('Preview unavailable:'));
  assert.equal(await alice.locator('#notice').isVisible(), false, 'Optional preview failures must not report a rejected room action');
  assert.ok(await alice.locator('#url-preview button[value="queue"]').isVisible(), 'Metadata failure must not remove queue controls');
  await alice.locator('#url-input').fill(`http://localhost:${media.address().port}/fixture.webm`);
  await alice.locator('#url-preview button[value="queue"]').click();
  for (const page of [alice, bob]) {
    try { await page.waitForFunction(() => { const video = document.querySelector('#player video'); return video && !video.paused && video.currentTime > 0.3; }, null, { timeout: 15000 }); }
    catch (error) { throw new Error(`${error.message}; ${JSON.stringify(await page.evaluate(() => { const video = document.querySelector('#player video'); return { body: document.body.innerText, media: video && { source: video.currentSrc, error: video.error?.message, network: video.networkState, ready: video.readyState, paused: video.paused, time: video.currentTime, duration: video.duration }, activated: navigator.userActivation.hasBeenActive }; }))}`); }
  }
  await alice.locator('#player video').evaluate(video => video.pause());
  for (const page of [alice, bob]) await page.waitForFunction(() => document.querySelector('#player video')?.paused === true);
  await alice.locator('#player video').evaluate(video => { video.playbackRate = 1.5; });
  for (const page of [alice, bob]) await page.waitForFunction(() => document.querySelector('#player video')?.playbackRate === 1.5);
  await alice.locator('#player video').evaluate(video => video.play());
  for (const page of [alice, bob]) await page.waitForFunction(() => document.querySelector('#player video')?.paused === false);
  for (const page of [alice, bob]) await page.waitForFunction(() => {
    const activity = document.getElementById('activity-panel').textContent;
    return activity.includes('paused') && activity.includes('resumed') && activity.includes('changed speed: 1× → 1.5×');
  });
  console.log('PASS: both clients render attributed pause, resume and rate activity');
  bob.once('dialog', dialog => dialog.accept('<img src=x onerror=alert(1)>'));
  await bob.locator('[data-action="rename"]').click();
  await alice.locator('[data-action="settings"]').click();
  await alice.waitForFunction(() => document.getElementById('room-api-key')?.value.length > 20);
  assert.equal(await alice.locator('#room-api-key').getAttribute('type'), 'password');
  await alice.locator('[data-action="autoplay-help"]').click();
  await alice.locator('#byob-autoplay-help-dont-show').check();
  await alice.getByRole('button', { name: 'Got it', exact: true }).click();
  await alice.waitForFunction(() => localStorage.getItem('byob_autoplay_help_dismissed') === '1', null, { timeout: 5000 });
  await alice.locator('[data-action="autoplay-help"]').click();
  assert.equal(await alice.locator('#byob-autoplay-help-dont-show').isChecked(), false);
  assert.equal(await alice.evaluate(() => localStorage.getItem('byob_autoplay_help_dismissed')), null);
  await alice.getByRole('button', { name: 'Got it', exact: true }).click();
  await alice.getByText('Stats for nerds', { exact: true }).click();
  await alice.waitForFunction(() => document.getElementById('byob-local-sync-chart')?.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(await alice.locator('#byob-local-sync-chart img').count(), 0, 'peer names must remain text in the rendered chart');
  const startPosition = await alice.locator('#player video').evaluate(video => video.currentTime);
  await alice.waitForFunction(start => document.querySelector('#player video').currentTime > start + 3, startPosition);
  const key = await alice.locator('#room-api-key').inputValue();
  const roomState = async () => {
    const response = await fetch(roomUrl.replace('/room/', '/api/rooms/'), { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  async function measureDrift(rate) {
    const samples = await Promise.all([alice, bob].map(async page => {
      const sample = await page.locator('#player video').evaluate(video => ({ position: video.currentTime, at: Date.now(), rate: video.playbackRate, paused: video.paused, hidden: document.hidden }));
      const reference = references.get(page).findLast(anchor => anchor.at <= sample.at);
      assert.ok(reference, 'a timestamped room reference must precede the media sample');
      // Workerd and both browsers run on this host's clock. Align their
      // timestamps rather than comparing samples taken a slow HTTP RPC apart.
      return alignSample(sample, reference, rate);
    }));
    for (const sample of samples) assert.ok(Math.abs(sample.drift) < 0.35, `${rate}x player drift exceeded 350ms: ${JSON.stringify({ samples, traces: [...traces.values()], nativeEvents: await Promise.all([alice, bob].map(page => page.evaluate(() => window.__mediaTrace))), stats: await alice.locator('#connection-stats').textContent() })}`);
    console.log(`PASS: ${rate}x canonical drift ${samples.map(sample => Math.round(sample.drift * 1000)).join('/')}ms`);
  }
  if (process.env.BYOB_TRACE_SEEKS === '1') console.log('Initial native seek trace:', JSON.stringify(await Promise.all([alice, bob].map(page => page.evaluate(() => window.__mediaTrace)))));
  await measureDrift(1.5);
  await bob.locator('[data-action="settings"]').click();
  await alice.locator('[data-sponsor-category="sponsor"]').selectOption('show_bar');
  await bob.waitForFunction(() => document.querySelector('[data-sponsor-category="sponsor"]')?.value === 'show_bar', null, { timeout: 5000 });
  await bob.locator('[aria-label="Close settings"]').click();
  await alice.locator('[aria-label="Close settings"]').click();
  await alice.locator('[data-action="history-tab"]').click();
  await alice.locator('[data-action="queue-tab"]').click();
  assert.equal(await alice.locator('[data-queue-idx]').count(), 1);
  for (const page of [alice, bob]) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'room layout must not overflow horizontally');
  assert.deepEqual(errors, []);
  await alice.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true, animations: 'disabled' });
  await bob.screenshot({ path: join(screenshots, 'mobile.png'), fullPage: true, animations: 'disabled' });
  console.log(`Screenshots: ${screenshots}`);
  for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.75, 2]) {
    await alice.locator('#player video').evaluate((video, rate) => { video.playbackRate = rate; }, rate);
    for (const page of [alice, bob]) await page.waitForFunction(rate => document.querySelector('#player video')?.playbackRate === rate, rate);
    const anchor = await alice.locator('#player video').evaluate(video => video.currentTime);
    await alice.waitForFunction(anchor => document.querySelector('#player video').currentTime > anchor + 3, anchor, { timeout: 16000 });
    await measureDrift(rate);
  }
  await alice.locator('#player video').evaluate(video => video.pause());
  for (const page of [alice, bob]) await page.waitForFunction(() => document.querySelector('#player video')?.paused === true);
  await alice.locator('#player video').evaluate(video => { video.currentTime = 20; });
  for (const page of [alice, bob]) {
    try { await page.waitForFunction(() => Math.abs(document.querySelector('#player video').currentTime - 20) < 0.1, null, { timeout: 5000 }); }
    catch (error) {
      const samples = await Promise.all([alice, bob].map(async page => ({ trace: traces.get(page), media: await page.locator('#player video').evaluate(video => ({ position: video.currentTime, paused: video.paused, seeking: video.seeking })) })));
      throw new Error(`Paused seek failed: ${JSON.stringify({ server: await roomState(), samples })}`, { cause: error });
    }
  }
  assert.ok(Math.abs((await roomState()).current_time - 20) < 0.1, 'native video seeking must update the room');
  await bob.reload();
  await bob.waitForFunction(() => {
    const video = document.querySelector('#player video');
    return document.getElementById('connection-status')?.textContent === '' && video?.paused && video.playbackRate === 2 && Math.abs(video.currentTime - 20) < 0.1;
  });
  assert.equal((await roomState()).play_state, 'paused', 'rejoining must not resume a paused room');
  assert.equal((await roomState()).user_count, 2, 'reload must retain the same tab identity');
  await bob.locator('[data-action="theme"]').click();
  await alice.locator('#player video').evaluate(video => { video.playbackRate = 1.5; });
  await alice.locator('#player video').evaluate(video => video.play());
  for (const page of [alice, bob]) await page.waitForFunction(() => { const video = document.querySelector('#player video'); return !video.paused && video.currentTime > 23 && video.playbackRate === 1.5; });
  await measureDrift(1.5);
  console.log('PASS: native paused seek, retained tab identity and paused-room reload/resume');
  const roundPage = await contexts[1].newPage();
  roundPage.on('pageerror', error => errors.push(error.message));
  await roundPage.setContent(`<link rel="stylesheet" href="${origin}/assets/app.css"><div id="round-panel" style="max-width:360px"></div>`);
  const fixture = await build({ entryPoints: [join(root, 'web/rounds.mjs')], bundle: true, format: 'iife', globalName: 'RoundFixture', write: false });
  await roundPage.addScriptTag({ content: fixture.outputFiles[0].text });
  const seed = 123456, winningIndex = landingSlice(seed, 12);
  await roundPage.evaluate(({ seed, winningIndex }) => {
    const listeners = new Map();
    const channel = { on(event, callback) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback); return () => listeners.get(event).delete(callback); }, emit(event, value) { for (const callback of listeners.get(event) || []) callback(value); } };
    const round = { id: 'fixture-round', mode: 'roulette', phase: 'active', started_by: 'alice', expires_at: Date.now() + 6500, server_time: Date.now(), candidates: Array.from({ length: 12 }, (_, index) => ({ external_id: `candidate${index}`, title: `Candidate ${index}` })) };
    window.roundView = RoundFixture.mountRounds(document.getElementById('round-panel'), channel);
    roundView.update(round, 'alice');
    const originalWheel = document.getElementById('roulette-wheel');
    roundView.update({ ...round }, 'alice');
    if (originalWheel !== document.getElementById('roulette-wheel')) throw new Error('A snapshot restarted the roulette animation');
    roundView.update({ ...round, phase: 'revealing', seed, winner_external_id: `candidate${winningIndex}` }, 'alice');
    if (document.getElementById('round-timer-label').textContent) throw new Error('The active countdown remained visible during reveal');
  }, { seed, winningIndex });
  await roundPage.waitForFunction(() => document.getElementById('roulette-status')?.textContent === 'winner!', null, { timeout: 20000 });
  assert.equal(await roundPage.locator(`.slice-winner-outline[data-slice-index="${winningIndex}"]`).evaluate(element => element.style.opacity), '1');
  await roundPage.screenshot({ path: join(screenshots, 'roulette-mobile.png'), fullPage: true, animations: 'disabled' });
  await roundPage.evaluate(() => roundView.update(null, 'alice'));
  assert.equal(await roundPage.locator('#roulette-wheel').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: rendered home/create/join, two real direct-video players, play/pause/rate propagation, private settings and desktop/mobile layout');
} finally {
  await browser?.close();
  if (worker && worker.exitCode === null && worker.signalCode === null) await new Promise(resolve => {
    const timer = setTimeout(() => { try { process.kill(-worker.pid, 'SIGKILL'); } catch {} }, 5000);
    worker.once('exit', () => { clearTimeout(timer); resolve(); });
    process.kill(-worker.pid, 'SIGTERM');
  });
  if (media) await new Promise(resolve => media.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
