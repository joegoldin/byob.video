import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import '../scripts/build-web.mjs';

assert.ok(process.env.BYOB_EXTENSION_PATH, 'BYOB_EXTENSION_PATH must name the actual packaged unpacked extension');
const extension = resolve(process.env.BYOB_EXTENSION_PATH);
await access(join(extension, 'manifest.json'));
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'byob-extension-'));
const origin = 'http://localhost:18793';
let worker, context, media;
let logs = '';
try {
  await writeFile(join(temp, '.env'), `TOKEN_SECRET=${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '60', '-c:v', 'libvpx', '-g', '10', '-b:v', '40k', '-c:a', 'libopus', join(temp, 'fixture.webm')]);
  const video = await readFile(join(temp, 'fixture.webm'));
  media = createServer((request, response) => {
    if (request.url === '/watch') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>Extension acceptance fixture</title><h1>External video</h1><video controls muted src="/fixture.webm"></video>');
      return;
    }
    const headers = { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
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
  worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', '18793', '--persist-to', join(temp, 'storage'), '--env-file', join(temp, '.env')], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Extension Worker startup timeout\n${logs}`)), 30000);
    const receive = chunk => {
      logs = (logs + chunk).slice(-12000);
      if (logs.includes('Ready on http://127.0.0.1:18793')) { clearTimeout(timeout); resolve(); }
    };
    worker.stdout.on('data', receive); worker.stderr.on('data', receive);
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', code => { clearTimeout(timeout); reject(new Error(`Extension Worker exited ${code}\n${logs}`)); });
  });
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    executablePath: process.env.CHROMIUM_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const background = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const manifest = await background.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.name, 'byob - Bring Your Own Binge');
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => document.documentElement.dataset.byobExtension === 'true');
  await page.locator('[data-action="create-room"]').click();
  await page.waitForURL(/\/room\/[a-z0-9]{8}$/);
  await page.waitForFunction(() => document.getElementById('connection-status')?.textContent === '');
  await page.locator('#url-input').fill(`http://127.0.0.1:${media.address().port}/watch`);
  await page.locator('#url-form button[value="queue"]').click();
  const popupPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open Player Window', exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await popup.locator('video').waitFor();
  // Give the external page a genuine browser user gesture, not a mocked ready event.
  await popup.locator('h1').click();
  await page.locator('[data-action="play"]').click();
  await popup.waitForFunction(() => { const video = document.querySelector('video'); return video && !video.paused && video.currentTime > 0.2; }, null, { timeout: 20000 });
  await page.locator('[data-action="pause"]').click();
  await popup.waitForFunction(() => document.querySelector('video').paused);
  await page.locator('#playback-rate').selectOption('1.5');
  await page.locator('[data-action="play"]').click();
  await popup.waitForFunction(() => { const video = document.querySelector('video'); return !video.paused && video.playbackRate === 1.5; });
  await page.locator('[data-action="pause"]').click();
  await popup.waitForFunction(() => document.querySelector('video').paused);
  await popup.locator('video').evaluate(video => { video.currentTime = 20; });
  await page.locator('[data-action="settings"]').click();
  await page.waitForFunction(() => document.getElementById('room-api-key')?.value.length > 20);
  const key = await page.locator('#room-api-key').inputValue();
  const endpoint = page.url().replace('/room/', '/api/rooms/');
  await page.waitForFunction(async ({ endpoint, key }) => {
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${key}` } });
    const { data } = await response.json();
    return data.play_state === 'paused' && Math.abs(data.current_time - 20) < 0.1;
  }, { endpoint, key });
  console.log(`PASS: actual Chromium extension ${manifest.version} injection, service worker, managed popup, native Worker authentication, play/pause/rate and paused seek back to room`);
} finally {
  await context?.close();
  if (worker && worker.exitCode === null && worker.signalCode === null) await new Promise(resolve => {
    const timer = setTimeout(() => { try { process.kill(-worker.pid, 'SIGKILL'); } catch {} }, 5000);
    worker.once('exit', () => { clearTimeout(timer); resolve(); });
    process.kill(-worker.pid, 'SIGTERM');
  });
  if (media) await new Promise(resolve => media.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
