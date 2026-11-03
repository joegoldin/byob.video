import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { evaluateSync, resetSync, toleranceMs, cooldownRemaining } from '../src/sync-decision.mjs';

const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/sync-decision.json.gz', import.meta.url))));

test('sync decisions retain captured boundary, latency, cooldown and stateful traces', () => {
  assert.equal(fixture.cases.length, 5134);
  for (const [index, { input: { state, data, room, now }, expected }] of fixture.cases.entries()) {
    assert.deepEqual({ result: evaluateSync(state, data, room, now),
      tolerance: toleranceMs(data, room, state, now), cooldown: cooldownRemaining(state, now),
      reset: resetSync(state) }, expected, `captured sync case ${index}`);
  }
});
