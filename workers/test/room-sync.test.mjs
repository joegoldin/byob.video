import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newSyncState } from '../src/sync-decision.mjs';
import { mediaLoaded } from '../src/playback.mjs';
import { currentPosition, recordDrift, adjustRoomClock, resetRoomSync, setPlaybackRate } from '../src/room-sync.mjs';

function room(overrides = {}) {
  return {
    room_id: 'test', users: { a: { connected: true, hidden: false }, b: { connected: true, hidden: false } },
    queue: [{ duration: 300, is_live: false }], current_index: 0, current_time: 10,
    last_sync_at: 1000000, playback_rate: 1, play_state: 'playing',
    drift_samples: {}, user_sync_states: {}, last_user_seek_at_global: 0, ...overrides,
  };
}

function oracle(cases) {
  const result = spawnSync('elixir', ['workers/scripts/room-sync-oracle.exs'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), input: JSON.stringify(cases),
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}

test('API actors do not force loaded players to wait for the fallback readiness timer', () => {
  const state = room({ queue: [{ id: 'item', is_live: false }], play_state: 'paused', ready_deadline: 1002500, ready_item_id: 'item', media_loaded_for: { a: 'item', b: 'item' } });
  const withApi = { ...state, users: { ...state.users, 'api:test': { connected: true, hidden: false } } };
  assert.deepEqual(oracle([{ action: 'ready', state }, { action: 'ready', state: withApi }]), [true, false], 'executed legacy quorum is blocked by an API actor that has no player');
  assert.equal(mediaLoaded(withApi, 'b', 'item', 1000000).state.play_state, 'playing');
});

test('room consensus matches the real Elixir handler, including mixed-sign hold and hidden peers', () => {
  const cases = [];
  for (const drifts of [[-200, -500], [200, 500], [-200, 500], [0, -500], [-15, -50], [-16, -50], [-2000, -3000]]) {
    for (const age of [0, 4999, 5000]) {
      for (const hidden of [false, true]) {
        for (const freeze of [0, 1000001, 1005000]) {
          const state = room({
            users: { a: { connected: true, hidden: false }, b: { connected: true, hidden } },
            last_user_seek_at_global: freeze,
            drift_samples: { a: { drift_ms: drifts[0], updated_at: 1005000 - age }, b: { drift_ms: drifts[1], updated_at: 1005000 - age } },
          });
          cases.push({ action: 'adjust', state, now: 1005000 });
        }
      }
    }
  }
  cases.push({ action: 'adjust', state: room({ play_state: 'paused' }), now: 1005000 });
  const expected = oracle(cases);
  cases.forEach((entry, i) => assert.deepEqual(adjustRoomClock(entry.state, entry.now), expected[i], `room consensus case ${i}`));
});

test('room drift handling reproduces targeted commands and preserves hidden users decision state', () => {
  const cases = [];
  for (const hidden of [false, true]) {
    for (const drift_ms of [-1500, -300, 0, 300, 1500]) {
      for (const count of [0, 1, 2]) {
        const state = room({
          users: { a: { connected: true, hidden } },
          user_sync_states: { a: { ...newSyncState(), over_tolerance_count: count } },
        });
        cases.push({ action: 'drift', state, data: { user_id: 'a', drift_ms, noise_floor_ms: 70, rtt_ms: 120, observed_l_ms: 450 }, now: 1005000 });
      }
    }
  }
  const expected = oracle(cases);
  cases.forEach((entry, i) => assert.deepEqual(recordDrift(entry.state, 'a', entry.data, entry.now), expected[i], `room drift case ${i}`));
});

test('1x playback and paused positions match the original server', () => {
  const cases = ['playing', 'paused'].flatMap(play_state => [1000000, 1005000, 2000000].map(now => ({ action: 'position', state: room({ play_state }), now })));
  const expected = oracle(cases);
  cases.forEach((entry, i) => assert.equal(currentPosition(entry.state, entry.now), expected[i]));
});

test('rate-aware clock fixes the legacy 1x-only extrapolation and does not rewind on rate changes', () => {
  const state = room({ playback_rate: 2 });
  assert.equal(oracle([{ action: 'position', state, now: 1005000 }])[0], 15, 'legacy clock incorrectly advances only five seconds at 2x');
  assert.equal(currentPosition(state, 1005000), 20);
  const next = setPlaybackRate(state, 0.5, 1005000);
  assert.equal(next.current_time, 20);
  assert.equal(currentPosition(next, 1015000), 25);
  assert.equal(currentPosition(JSON.parse(JSON.stringify(next)), 1015000), 25);
  assert.equal(currentPosition(room({ play_state: 'paused', playback_rate: 2 }), 1015000), 10);
  assert.equal(currentPosition(state, 2000000), 300);
  assert.equal(setPlaybackRate(state, '4', 1005000).playback_rate, 2);
  assert.equal(setPlaybackRate(state, 0, 1005000).playback_rate, 0.25);
  assert.throws(() => setPlaybackRate(state, NaN, 1005000), /invalid_rate/);
});

test('seek processing compensation follows room velocity, including stationary paused targets', () => {
  for (const playback_rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
    for (const play_state of ['playing', 'paused']) {
      const state = room({ playback_rate, play_state, user_sync_states: {
        a: { ...newSyncState(), over_tolerance_count: 1, learned_l_ms: 200 },
      } });
      const result = recordDrift(state, 'a', { drift_ms: -1000 }, 1000000);
      const command = result.events.find(([event]) => event === 'user_seek_command')[2];
      assert.equal(command.position, 10 + (play_state === 'playing' ? playback_rate * 0.2 : 0), `${play_state} at ${playback_rate}x`);
    }
  }
});

test('direct media learns fast native seek completions without changing legacy provider bounds', () => {
  const state = room({ queue: [{ source_type: 'direct_url', duration: 300 }], user_sync_states: {
    a: { ...newSyncState(), over_tolerance_count: 1 },
  } });
  const result = recordDrift(state, 'a', { drift_ms: -1000, observed_l_ms: 3 }, 1000000);
  assert.equal(result.state.user_sync_states.a.learned_l_ms, 3);
  assert.equal(result.events[0][2].position, 10.003);
  const missing = recordDrift(state, 'a', { drift_ms: -1000, observed_l_ms: 0 }, 1000000);
  assert.equal(missing.state.user_sync_states.a.learned_l_ms, 500, 'zero remains the legacy missing-observation sentinel');
});

test('room resets clear drift history but retain each device learned seek latency', () => {
  const reset = resetRoomSync(room({
    drift_samples: { a: { drift_ms: -500, updated_at: 1000000 } },
    user_sync_states: { a: { ...newSyncState(), learned_l_ms: 240, seek_streak: 5, last_seek_at: 1000000 } },
  }));
  assert.deepEqual(reset.drift_samples, {});
  assert.deepEqual(reset.user_sync_states.a, { ...newSyncState(), learned_l_ms: 240 });
});
