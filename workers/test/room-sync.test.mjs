import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
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

const captured = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/room-sync.json.gz', import.meta.url)))).cases;

test('API actors do not force loaded players to wait for the fallback readiness timer', () => {
  const state = room({ queue: [{ id: 'item', is_live: false }], play_state: 'paused', ready_deadline: 1002500, ready_item_id: 'item', media_loaded_for: { a: 'item', b: 'item' } });
  const withApi = { ...state, users: { ...state.users, 'api:test': { connected: true, hidden: false } } };
  assert.equal(mediaLoaded(withApi, 'b', 'item', 1000000).state.play_state, 'playing');
});

for (const action of ['adjust', 'drift', 'position']) {
  test(`room ${action} retains captured consensus, hidden-peer and timestamp boundaries`, () => {
    assert.equal(captured.length, 166);
    for (const [index, { input, expected }] of captured.entries()) {
      if (input.action !== action || (action === 'position' && input.state.playback_rate !== 1)) continue;
      const { state, now, data } = input;
      const actual = action === 'adjust' ? adjustRoomClock(state, now)
        : action === 'drift' ? recordDrift(state, data.user_id, data, now) : currentPosition(state, now);
      assert.deepEqual(actual, expected, `captured room ${action} case ${index}`);
    }
  });
}

test('rate-aware clock fixes the legacy 1x-only extrapolation and does not rewind on rate changes', () => {
  const state = room({ playback_rate: 2 });
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

test('non-playing and gesture-blocked clients cannot trigger corrective seek loops or room-clock consensus', () => {
  for (const report of [
    { play_state: 'buffering' }, { play_state: 'paused' }, { play_state: 'unstarted' },
    { play_state: 'playing', gesture_blocked: true },
  ]) {
    let state = room({ current_time: 100, user_sync_states: { a: { ...newSyncState(), over_tolerance_count: 1 } } });
    for (let index = 0; index < 5; index++) {
      const result = recordDrift(state, 'a', { ...report, drift_ms: -9000 - index * 500, observed_l_ms: 3000 }, 1000000 + index * 500);
      assert.equal(result.events.some(([event]) => event === 'user_seek_command'), false, `${JSON.stringify(report)} is not active playback`);
      state = result.state;
    }
    assert.equal(state.user_sync_states.a.learned_l_ms, 500, 'failed starts must not teach seek latency');
    state = recordDrift(state, 'b', { play_state: 'playing', drift_ms: -100 }, 1002000).state;
    assert.equal(adjustRoomClock(state, 1002000).state, state, 'one playing client plus a stalled client cannot form consensus');
    const resumed = recordDrift(state, 'a', { play_state: 'playing', drift_ms: -1000 }, 1003000);
    assert.equal(resumed.events.some(([event]) => event === 'user_seek_command'), false, 'resumed playback starts with a fresh sustained-drift count');
    assert.ok(recordDrift(resumed.state, 'a', { play_state: 'playing', drift_ms: -1000 }, 1003500).events.some(([event]) => event === 'user_seek_command'), 'real playback must regain normal sync correction');
  }
});
