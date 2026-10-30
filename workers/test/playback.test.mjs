import test from 'node:test';
import assert from 'node:assert/strict';
import { newSyncState } from '../src/sync-decision.mjs';
import { changeMedia, mediaLoaded, expireReady, setVisibility, transitionPlayback, seekPlayback } from '../src/playback.mjs';

function room() {
  return {
    users: { a: { connected: true, hidden: false }, b: { connected: true, hidden: false } },
    queue: [{ id: 'first', duration: 100 }, { id: 'next', duration: 100 }], current_index: 0,
    current_time: 5, last_sync_at: 1000, play_state: 'playing', playback_rate: 1,
    user_sync_states: { b: { ...newSyncState(), learned_l_ms: 250, seek_streak: 3 } },
    drift_samples: {}, last_seek_at: {}, last_user_seek_at_global: 0,
    media_loaded_for: {}, ready_deadline: null, ready_item_id: null, advance_deadline: null,
  };
}

test('media change waits for visible peers, rejects stale loads and starts exactly once', () => {
  const changed = changeMedia(room(), 1, 2000);
  assert.equal(changed.state.play_state, 'paused');
  assert.equal(changed.state.ready_deadline, 4500);
  assert.equal(changed.state.user_sync_states.b.learned_l_ms, 250);
  assert.equal(changed.state.user_sync_states.b.seek_streak, 0);
  assert.deepEqual(mediaLoaded(changed.state, 'a', 'first', 2100).events, []);
  const first = mediaLoaded(changed.state, 'a', 'next', 2200);
  assert.equal(first.state.play_state, 'paused');
  const second = mediaLoaded(first.state, 'b', 'next', 2300);
  assert.equal(second.state.play_state, 'playing');
  assert.deepEqual(second.events, [['sync_play', { time: 0, server_time: 2300, user_id: null }], ['activity_log_entry', { action: 'now_playing', user: null, detail: null, at: '1970-01-01T00:00:02.300Z' }]]);
  assert.deepEqual(mediaLoaded(second.state, 'b', 'next', 2400).events, []);
  assert.deepEqual(expireReady(second.state, 'next', 4500).events, []);
});

test('explicit playback controls supersede pending readiness across reload and late loaded events', () => {
  for (const action of ['play', 'pause', 'seek']) {
    const waiting = changeMedia(room(), 1, 2000).state;
    const controlled = action === 'seek' ? seekPlayback(waiting, 'a', 12, 2100).state
      : transitionPlayback(waiting, action, 'a', 12, 2100).state;
    const restored = JSON.parse(JSON.stringify(controlled));
    const expired = expireReady(restored, 'next', 4500);
    assert.deepEqual(expired.events, [], `${action}: old readiness deadline must not override user intent`);
    assert.equal(expired.state.current_time, controlled.current_time);
    assert.equal(expired.state.play_state, controlled.play_state);
    const loaded = mediaLoaded(mediaLoaded(restored, 'a', 'next', 4600).state, 'b', 'next', 4700);
    assert.deepEqual(loaded.events, [], `${action}: late player readiness must not restart playback`);
  }
});

test('visibility changes unblock readiness; all-hidden rooms still use the deadline', () => {
  let state = changeMedia(room(), 1, 2000).state;
  state = mediaLoaded(state, 'a', 'next', 2100).state;
  assert.equal(setVisibility(state, 'b', true, 2200).state.play_state, 'playing');
  state = changeMedia(room(), 1, 2000).state;
  state = setVisibility(state, 'a', true, 2100).state;
  state = setVisibility(state, 'b', true, 2200).state;
  assert.equal(state.play_state, 'paused');
  assert.equal(expireReady(state, 'next', 4499).state.play_state, 'paused');
  assert.equal(expireReady(state, 'first', 4500).state.play_state, 'paused');
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(expireReady(restored, 'next', 4500).state.play_state, 'playing');
});

test('redundant play/pause cannot overwrite canonical position; play cancels queued advance', () => {
  const initial = { ...room(), advance_deadline: 9000 };
  const playing = transitionPlayback(initial, 'play', 'a', 0, 2000).state;
  assert.equal(playing.current_time, 5);
  assert.equal(playing.last_sync_at, 1000);
  assert.equal(playing.advance_deadline, null);
  const paused = transitionPlayback(playing, 'pause', 'a', 6, 2000).state;
  assert.equal(paused.current_time, 6);
  assert.equal(transitionPlayback(paused, 'pause', 'b', 0, 3000).state.current_time, 6);
  assert.throws(() => transitionPlayback(paused, 'play', 'a', Infinity, 3000), /invalid_position/);
});

test('user seek preserves device learning, excludes originator and debounces repeated events', () => {
  const result = seekPlayback(room(), 'a', 30, 2000);
  assert.deepEqual(result.events, [['user_seek_command', 'b', { position: 30.25, server_time: 2000 }], ['activity_log_entry', { action: 'seeked', user: 'a', detail: '5.0s → 30.0s', at: '1970-01-01T00:00:02.000Z' }]]);
  assert.equal(result.state.last_user_seek_at_global, 2000);
  assert.equal(result.state.user_sync_states.b.seek_streak, 1);
  assert.equal(result.state.user_sync_states.b.learned_l_ms, 250);
  assert.throws(() => seekPlayback(result.state, 'a', 31, 2499), /debounced/);
  assert.equal(seekPlayback(result.state, 'a', 31, 2500).state.current_time, 31);
  const live = room();
  live.queue[0].is_live = true;
  assert.deepEqual(seekPlayback(live, 'a', 10, 2000), { state: live, events: [] });
});

test('play/pause preserve the legacy per-user 20-event window across restored state', () => {
  let state = room();
  for (let i = 0; i < 20; i++) state = transitionPlayback(state, 'play', 'a', 0, 2000 + i).state;
  state = JSON.parse(JSON.stringify(state));
  assert.throws(() => transitionPlayback(state, 'pause', 'a', 10, 6999), /rate_limited/);
  assert.equal(transitionPlayback(state, 'pause', 'b', 10, 6999).state.play_state, 'paused');
  assert.equal(transitionPlayback(state, 'pause', 'a', 10, 7000).state.play_state, 'paused');
});

test('paused user seeks do not add device latency to a stationary playhead', () => {
  const result = seekPlayback({ ...room(), play_state: 'paused' }, 'a', 20, 2000);
  assert.equal(result.state.current_time, 20);
  assert.equal(result.events[0][2].position, 20);
});

test('play, pause and seek emit activity once for real controls', () => {
  const original = { ...room(), activity_log: [], users: { a: { username: 'Alice', connected: true } } };
  const paused = transitionPlayback(original, 'pause', 'a', 12, 2000);
  assert.equal(paused.state.activity_log[0]?.action, 'pause');
  assert.equal(paused.state.activity_log[0]?.user, 'Alice');
  assert.ok(paused.events.some(([event]) => event === 'activity_log_entry'));
  const duplicate = transitionPlayback(paused.state, 'pause', 'a', 12, 5000);
  assert.equal(duplicate.state.activity_log.length, 1);
  const played = transitionPlayback(duplicate.state, 'play', 'a', 12, 6000);
  assert.equal(played.state.activity_log[0]?.action, 'play');
  const sought = seekPlayback(played.state, 'a', 30, 7000);
  assert.equal(sought.state.activity_log[0]?.action, 'seeked');
});

test('readiness logs now playing only once', () => {
  const waiting = changeMedia({ ...room(), activity_log: [] }, 0, 2000).state;
  const playing = expireReady(waiting, 'first', 4500);
  assert.equal(playing.state.activity_log[0]?.action, 'now_playing');
  assert.equal(expireReady(playing.state, 'first', 5000).state.activity_log.length, 1);
});

test('rate changes emit attributed activity and canonical anchors without logging echoes', async () => {
  const { changePlaybackRate } = await import('../src/playback.mjs');
  const changed = changePlaybackRate({ ...room(), activity_log: [] }, 'a', 1.5, 2000);
  assert.equal(changed.state.activity_log[0]?.action, 'rate_changed');
  assert.equal(changed.state.activity_log[0]?.user, 'a');
  assert.ok(changed.events.some(([event]) => event === 'activity_log_entry'));
  assert.equal(changed.events[0][1].current_time, 6);
  const repeated = changePlaybackRate(changed.state, 'a', 1.5, 5000);
  assert.deepEqual(repeated.events, []);
  assert.equal(repeated.state.activity_log.length, 1);
});
