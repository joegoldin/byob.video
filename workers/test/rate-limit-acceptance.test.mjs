import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReadRateLimit } from './support/rate-limit.mjs';

function fixedWindow({ enabled = true, step = 2 } = {}) {
  let time = 59900, epoch, count = 0, calls = 0;
  return { now: () => time, calls: () => calls,
    async read() {
      time += step; calls++;
      const current = Math.floor(time / 60000);
      if (epoch !== current) { epoch = current; count = 0; }
      if (enabled && count >= 60) return { status: 429, body: { error: 'Rate limited. Slow down.' } };
      count++;
      return { status: 200, body: {} };
    } };
}

test('a 65-read probe can miss a working limiter when the fixed minute window rolls over', async () => {
  const limiter = fixedWindow();
  for (let i = 0; i < 65; i++) assert.equal((await limiter.read()).status, 200);
});

test('rate-limit acceptance detects enforcement even when a burst crosses the minute boundary', async () => {
  const limiter = fixedWindow();
  await assertReadRateLimit(limiter.read, { limit: 60, period: 60 }, limiter.now);
  assert.ok(limiter.calls() > 65 && limiter.calls() <= 121);
});

test('acceptance still fails when enforcement is disabled or a burst spans too many windows', async () => {
  const disabled = fixedWindow({ enabled: false });
  await assert.rejects(assertReadRateLimit(disabled.read, { limit: 60, period: 60 }, disabled.now), /did not enforce the configured limit/);
  const slow = fixedWindow({ step: 1000 });
  await assert.rejects(assertReadRateLimit(slow.read, { limit: 60, period: 60 }, slow.now), /burst must finish within one period/);
});

test('unrelated HTTP errors cannot satisfy rate-limit acceptance', async () => {
  await assert.rejects(assertReadRateLimit(async () => ({ status: 429, body: { error: 'Capacity exceeded' } }), { limit: 60, period: 60 }), /rejection must come from rate limiting/);
  await assert.rejects(assertReadRateLimit(async () => ({ status: 500, body: {} }), { limit: 60, period: 60 }), /authenticated successful read/);
});
