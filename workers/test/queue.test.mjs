import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, playIndex, removeItem, reorderQueue, videoEnded, advanceQueue, expireAdvance } from '../src/queue.mjs';
import { transitionPlayback, expireReady } from '../src/playback.mjs';

function room(queue = []) {
  return {
    users: {}, queue, history: [], current_index: queue.length ? 0 : null,
    current_time: 0, last_sync_at: 1000, playback_rate: 1, play_state: 'playing',
    user_sync_states: {}, drift_samples: {}, media_loaded_for: {},
    ready_item_id: null, ready_deadline: null, advance_deadline: null,
  };
}
const a = { id: 'a', duration: 100 }, b = { id: 'b', duration: 200 }, c = { id: 'c', duration: 300 };

test('empty queue starts with readiness; append preserves current playback; now replaces current item', () => {
  const first = enqueue(room(), [a], 'queue', 2000);
  assert.equal(first.state.play_state, 'paused');
  assert.equal(first.state.current_index, 0);
  assert.equal(first.state.history[0].item.id, 'a');
  const appended = enqueue(first.state, [b], 'queue', 3000);
  assert.equal(appended.state.ready_deadline, 4500);
  assert.deepEqual(appended.state.queue, [a, b]);
  const now = enqueue(appended.state, [c], 'now', 4000);
  assert.deepEqual(now.state.queue, [c, b]);
  assert.equal(now.state.history[0].item.id, 'c');
});

test('playlist insertion and playback history remain bounded', () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ id: `item${i}` }));
  const full = enqueue(room(), items, 'queue', 2000).state;
  assert.equal(full.queue.length, 200);
  assert.equal(enqueue(full, [a], 'queue', 2001).state.queue.length, 200);
  let state = room();
  for (let i = 0; i < 120; i++) state = enqueue(state, [{ id: `history${i}` }], 'now', 2000 + i).state;
  assert.equal(state.history.length, 99);
});

test('reorder/removal tracks the playing item rather than a stale index', () => {
  const reordered = reorderQueue(room([a, b, c]), 0, 2).state;
  assert.deepEqual(reordered.queue, [b, c, a]);
  assert.equal(reordered.current_index, 2);
  const removed = removeItem(reordered, 'b').state;
  assert.equal(removed.current_index, 1);
  assert.equal(removed.queue[removed.current_index].id, 'a');
  assert.equal(removeItem(removed, 'a').state.current_index, null);
  assert.deepEqual(reorderQueue(removed, -1, 0).events, []);
});

test('manual selection cancels autoplay and cannot drop a different item when restarting current', () => {
  const original = { ...room([a, b, c]), advance_deadline: 6000 };
  const jumped = playIndex(original, 2, 2000);
  assert.deepEqual(jumped.state.queue, [c, b]);
  assert.equal(jumped.state.advance_deadline, null);
  assert.equal(jumped.events[0][0], 'autoplay_countdown_cancelled');
  assert.deepEqual(playIndex(room([a, b, c]), 0, 2000).state.queue, [a, b, c]);
});

test('ended event freezes played-through position and advances only once after its deadline', () => {
  const ended = videoEnded(room([a, b]), 'a', 101000);
  assert.equal(ended.state.current_time, 100);
  assert.equal(ended.state.play_state, 'paused');
  assert.equal(videoEnded(ended.state, 'a', 101001).status, 'stale');
  assert.deepEqual(expireAdvance(ended.state, 105999).events, []);
  const advanced = expireAdvance(JSON.parse(JSON.stringify(ended.state)), 106000);
  assert.deepEqual(advanced.state.queue, [b]);
  assert.equal(advanced.state.play_state, 'paused');
  assert.equal(videoEnded(advanced.state, 'a', 106001).status, 'stale');
  assert.equal(advanceQueue(advanced.state, 107000).state.play_state, 'ended');
});

test('replay cancels pending autoplay and removal cannot resurrect media through an old ready alarm', () => {
  const ended = videoEnded(room([a, b]), 'a', 101000).state;
  const replay = transitionPlayback(ended, 'play', 'user', 0, 102000).state;
  assert.deepEqual(expireAdvance(replay, 106000).events, []);
  const started = enqueue(room(), [a], 'now', 2000).state;
  const removed = removeItem(started, 'a').state;
  assert.deepEqual(expireReady(removed, 'a', 4500).events, []);
});

test('finished media emits activity once, excluding duplicate ended callbacks', () => {
  const result = videoEnded({ ...room([a]), activity_log: [] }, 'a', 2000);
  assert.equal(result.state.activity_log[0]?.action, 'finished');
  assert.ok(result.events.some(([event]) => event === 'activity_log_entry'));
  assert.deepEqual(videoEnded(result.state, 'a', 2100).events, []);
});
