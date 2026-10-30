import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const origin = process.env.BYOB_BASE_URL;
assert.ok(origin && new URL(origin).protocol === 'https:', 'BYOB_BASE_URL must explicitly select an HTTPS deployment');
const health = await fetch(`${origin}/health`);
assert.equal(health.status, 200, 'hosted health must succeed');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), headless: true,
});
try {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const alice = await first.newPage();
  const bob = await second.newPage();
  const frames = [];
  bob.on('websocket', socket => socket.on('framereceived', frame => frames.push(String(frame.payload))));
  assert.equal((await alice.goto(origin)).status(), 200);
  await alice.locator('[data-action="create-room"]').click();
  await alice.waitForURL(/\/room\/[a-z0-9]{8}$/);
  const roomUrl = alice.url();
  await alice.waitForFunction(() => document.getElementById('connection-status')?.textContent === '');
  await bob.goto(roomUrl);
  await bob.waitForFunction(() => document.getElementById('connection-status')?.textContent === '');
  await alice.locator('[data-action="settings"]').click();
  await alice.waitForFunction(() => document.getElementById('room-api-key')?.value.length > 20);
  assert.equal(await alice.locator('#room-api-key').getAttribute('type'), 'password');
  const key = await alice.locator('#room-api-key').inputValue();
  const endpoint = roomUrl.replace('/room/', '/api/rooms/');
  assert.equal((await fetch(endpoint)).status, 401, 'room API must require credentials');
  assert.equal((await fetch(endpoint, { headers: { Authorization: 'Bearer incorrect' } })).status, 401);
  const request = (path, method = 'GET', body) => fetch(endpoint + path, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal((await request('/queue', 'POST', { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })).status, 200);
  await bob.locator('[data-queue-idx]').waitFor();
  const queue = (await (await request('/queue')).json()).data.queue;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].source_type, 'youtube');
  const rejected = await request('/queue', 'POST', { url: `${origin}/room/other` });
  assert.equal(rejected.status, 422, 'hosted request hostname must reject self-reference');
  // Pause only changes the anchor on a playing→paused transition; it is not
  // a seek command for an already-paused room.
  assert.equal((await request('/play', 'POST', { position: 12 })).status, 200);
  assert.equal((await request('/pause', 'POST', { position: 12 })).status, 200);
  const paused = (await (await request('')).json()).data;
  assert.equal(paused.play_state, 'paused', 'explicit pause must take effect before reload');
  assert.equal(paused.current_time, 12, 'explicit playing→paused transition must anchor at12');
  await bob.reload();
  await bob.waitForFunction(() => document.getElementById('connection-status')?.textContent === '');
  const state = (await (await request('')).json()).data;
  assert.equal(state.play_state, 'paused');
  assert.equal(state.current_time, 12);
  assert.equal(state.queue_length, 1);
  assert.equal(frames.some(frame => frame.includes(key)), false, 'room key must not appear in peer frames');
  assert.equal((await request(`/queue/${queue[0].id}`, 'DELETE')).status, 200);
  assert.equal((await (await request('/queue')).json()).data.queue.length, 0);
  console.log('PASS: hosted assets/health, browser creation, two real channels, private credentials, API authorization, queue broadcast, hostname protection and paused reload; fixture queue cleaned');
} finally { await browser.close(); }
