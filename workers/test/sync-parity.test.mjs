import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newSyncState, evaluateSync, resetSync, toleranceMs, cooldownRemaining } from '../src/sync-decision.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

function compareWithLegacy(cases) {
  const oracle = spawnSync('elixir', ['workers/scripts/sync-oracle.exs'], {
    cwd: root, input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: 30000,
  });
  assert.equal(oracle.status, 0, oracle.error?.message ?? oracle.stderr);
  const expected = JSON.parse(oracle.stdout);
  assert.equal(expected.length, cases.length);
  for (const [i, entry] of cases.entries()) {
    const { state, data, room, now } = entry;
    assert.deepEqual({
      result: evaluateSync(state, data, room, now),
      tolerance: toleranceMs(data, room, state, now),
      cooldown: cooldownRemaining(state, now),
      reset: resetSync(state),
    }, expected[i], `legacy parity for case ${i}: ${JSON.stringify(entry)}`);
  }
}

test('adaptive sync matches Elixir at tolerance, latency, quiet-window and cooldown boundaries', () => {
  const cases = [];
  for (const drift_ms of [-1000, -600, -300, -299.999, 0, 299.999, 300, 600, 1000]) {
    for (const elapsed of [-1, 0, 499, 500, 999, 1000, 1999, 2000, 3999, 4000, 4999, 5000, 10000, 10001]) {
      for (const seek_streak of [0, 1, 2, 3, 4, 5, 20]) {
        cases.push({
          state: { ...newSyncState(), seek_streak, last_seek_at: 1000000, over_tolerance_count: 1 },
          data: { drift_ms, noise_floor_ms: 0, rtt_ms: 100, observed_l_ms: null },
          room: { expected_position: 10, room_jitter_ms: 0 }, now: 1000000 + elapsed,
        });
      }
    }
  }
  for (const observed_l_ms of [null, -1, 0, 49.999, 50, 500, 5000, 5000.001, 10000]) {
    for (const learned_l_ms of [50, 200, 500, 5000]) {
      for (const noise_floor_ms of [null, 0, 74.999, 75, 249.999, 250, 1000]) {
        cases.push({
          state: { ...newSyncState(), learned_l_ms, over_tolerance_count: 1 },
          data: { drift_ms: -1001, noise_floor_ms, observed_l_ms, rtt_ms: 900 },
          room: { expected_position: -1, room_jitter_ms: 60 }, now: 1000000,
        });
      }
    }
  }
  compareWithLegacy(cases);
});

test('stateful sync traces remain equivalent across resets and serialized hibernation boundaries', () => {
  let seed = 0x5eed;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const cases = [];
  for (const epoch of [-576460750000, 0, 1000000, 1793235485867]) {
    let state = newSyncState(), now = epoch;
    for (let i = 0; i < 1000; i++) {
      now += Math.floor(random() * 1600);
      if (i % 71 === 0) state = resetSync(state);
      // JSON is also the portable representation used for persistence/import.
      if (i % 17 === 0) state = JSON.parse(JSON.stringify(state));
      const entry = {
        state, now,
        data: { drift_ms: (random() - 0.5) * 6000, noise_floor_ms: random() * 400, observed_l_ms: random() * 5500, rtt_ms: random() * 1500 },
        room: { expected_position: (now - epoch) / 1000, room_jitter_ms: random() * 250 },
      };
      cases.push(entry);
      state = evaluateSync(state, entry.data, entry.room, now).state;
    }
  }
  compareWithLegacy(cases);
});
