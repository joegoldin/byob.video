import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import '../scripts/build-web.mjs';

// This deliberately contacts real public providers. It is separate from the
// deterministic fixture suite and must not turn provider failures into passes.
const providers = [
  { name: 'YouTube', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', host: 'youtube' },
  { name: 'Vimeo', url: 'https://vimeo.com/19231868', host: 'vimeo' },
];
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'byob-providers-'));
let worker, browser;
let logs = '';
try {
  await writeFile(join(temp, '.env'), `TOKEN_SECRET=${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', '18794', '--persist-to', join(temp, 'storage'), '--env-file', join(temp, '.env')], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Provider Worker startup timeout\n${logs}`)), 30000);
    const receive = chunk => {
      logs = (logs + chunk).slice(-12000);
      if (logs.includes('Ready on http://127.0.0.1:18794')) { clearTimeout(timeout); resolve(); }
    };
    worker.stdout.on('data', receive); worker.stderr.on('data', receive);
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', code => { clearTimeout(timeout); reject(new Error(`Provider Worker exited ${code}\n${logs}`)); });
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), headless: true,
  });
  const failures = [];
  const selected = providers.filter(provider => !process.env.BYOB_PROVIDER || provider.name.toLowerCase() === process.env.BYOB_PROVIDER.toLowerCase());
  assert.ok(selected.length, 'BYOB_PROVIDER must select a supported provider');
  for (const provider of selected) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const network = [];
    const record = (url, result) => {
      const parsed = new URL(url);
      // Challenge/CDN paths can contain signed tokens as well as query strings.
      const path = /^\/(?:api\/(?:oembed\.json|player\.js)|video\/\d+)$/.test(parsed.pathname) ? parsed.pathname : '[redacted]';
      network.push({ host: parsed.hostname, path, result });
      if (network.length > 20) network.shift();
    };
    page.on('requestfailed', request => record(request.url(), request.failure()?.errorText));
    page.on('response', response => { if (response.status() >= 400) record(response.url(), response.status()); });
    try {
      await page.goto('http://127.0.0.1:18794');
      await page.locator('[data-action="create-room"]').click();
      await page.waitForURL(/\/room\/[a-z0-9]{8}$/);
      await page.waitForFunction(() => document.getElementById('connection-status')?.textContent === '');
      await page.locator('#url-input').fill(provider.url);
      await page.locator('#url-preview button[value="queue"]').click();
      await page.locator('[data-action="settings"]').click();
      await page.waitForFunction(() => document.getElementById('room-api-key')?.value.length > 20);
      const key = await page.locator('#room-api-key').inputValue();
      const endpoint = page.url().replace('/room/', '/api/rooms/');
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      const control = action => page.evaluate(async ({ endpoint, key, action }) => {
        const stateResponse = await fetch(endpoint, { headers: { Authorization: `Bearer ${key}` } });
        if (!stateResponse.ok) throw new Error(`Room state failed: ${stateResponse.status}`);
        const { data } = await stateResponse.json();
        const response = await fetch(`${endpoint}/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ position: data.current_time }) });
        if (!response.ok) throw new Error(`Room ${action} failed: ${response.status}`);
      }, { endpoint, key, action });
      const iframe = page.locator(`#player iframe[src*="${provider.host}"]`).first();
      await iframe.waitFor({ timeout: 20000 });
      const frame = await (await iframe.elementHandle()).contentFrame();
      assert.ok(frame, `${provider.name} iframe must attach`);
      await frame.locator('video').first().waitFor({ timeout: 20000 });
      const video = frame.locator('video').first();
      if (await video.evaluate(video => video.paused)) await video.click({ force: true });
      await frame.waitForFunction(() => { const video = document.querySelector('video'); return video && !video.paused && video.currentTime > 0.5; }, null, { timeout: 20000 });
      await control('pause');
      await frame.waitForFunction(() => document.querySelector('video')?.paused === true, null, { timeout: 10000 });
      if (provider.name === 'YouTube') {
        await frame.getByRole('button', { name: /^(Playback )?Settings$/i }).click();
        await frame.getByText(/^(Playback speed|Speed)$/).click();
        await frame.getByText(/^1\.5(?:x|×)?$/).click();
      } else {
        await video.evaluate(video => { video.playbackRate = 1.5; });
      }
      await page.waitForFunction(() => document.getElementById('activity-panel').textContent.includes('changed speed: 1× → 1.5×'));
      await control('play');
      await frame.waitForFunction(() => { const video = document.querySelector('video'); return video && !video.paused && video.playbackRate === 1.5; }, null, { timeout: 10000 });
      const start = await video.evaluate(video => video.currentTime);
      await frame.waitForFunction(start => document.querySelector('video').currentTime > start + 1, start, { timeout: 10000 });
      console.log(`PASS: real ${provider.name} embed playback, room pause/resume and actual1.5x rate`);
    } catch (error) {
      const messages = await Promise.all(page.frames().map(frame => frame.locator('body').innerText({ timeout: 1000 }).then(text => text.slice(0, 1200)).catch(() => 'Frame text unavailable')));
      const controls = await Promise.all(page.frames().filter(frame => frame.url().includes(provider.host)).map(frame => frame.locator('button,[role="button"]').evaluateAll(nodes => nodes.slice(0, 40).map(node => ({ label: node.getAttribute('aria-label'), title: node.getAttribute('title'), class: node.className }))).catch(() => [])));
      console.error(`Provider controls: ${JSON.stringify(controls)}`);
      failures.push(provider.name);
      console.error(`FAIL: ${provider.name}: ${error.message}; visible page/frame messages: ${JSON.stringify(messages)}; failed requests: ${JSON.stringify(network)}`);
    } finally { await context.close(); }
  }
  assert.deepEqual(failures, [], 'live-provider acceptance is incomplete');
} finally {
  await browser?.close();
  if (worker && worker.exitCode === null && worker.signalCode === null) await new Promise(resolve => {
    const timer = setTimeout(() => { try { process.kill(-worker.pid, 'SIGKILL'); } catch {} }, 5000);
    worker.once('exit', () => { clearTimeout(timer); resolve(); });
    process.kill(-worker.pid, 'SIGTERM');
  });
  await rm(temp, { recursive: true, force: true });
}
