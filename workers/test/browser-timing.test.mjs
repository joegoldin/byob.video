import test from 'node:test';
import assert from 'node:assert/strict';
import { alignSample } from './browser-timing.mjs';

test('browser drift uses the sample timestamp, not a later HTTP response position', () => {
  const sample = { position: 24.646468, at: 1793307615387 };
  const reference = { position: 21.587916, at: 1793307613636 };
  const laterApiPosition = 25.061666;
  assert.ok(Math.abs(sample.position - laterApiPosition) > 0.35);
  const aligned = alignSample(sample, reference, 1.75);
  assert.ok(Math.abs(aligned.drift + 0.005698) < 0.000001);
});

test('timestamp alignment still exposes real playback drift at every tested rate', () => {
  for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
    const reference = { position: 20, at: 1000 };
    for (const drift of [-0.4, 0.4]) {
      const sample = { position: 20 + 2 * rate + drift, at: 3000 };
      assert.ok(Math.abs(alignSample(sample, reference, rate).drift) > 0.35);
    }
  }
});
