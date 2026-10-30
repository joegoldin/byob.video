import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomMetadata, applyMetadata } from '../src/room-metadata.mjs';
import { newRoom, nextDeadline } from '../src/room-state.mjs';

function room() {
  const state = newRoom('abc123', 1000);
  state.queue = Array.from({ length: 5 }, (_, i) => ({ id: `item${i}`, url: `https://youtu.be/video${i}`, source_type: 'youtube', source_id: `video${i}`, title: null }));
  state.current_index = 0;
  state.history = [{ item: state.queue[0], played_at: '2026-01-01T00:00:00Z' }];
  return state;
}

test('metadata work is persisted, deduplicated, leased and capped at three simultaneous jobs', () => {
  const worker = new RoomMetadata({});
  let state = room();
  for (const item of state.queue) state = worker.enqueue(state, item, 2000);
  state = worker.enqueue(state, state.queue[0], 2000);
  assert.equal(state.pending_metadata.length, 5);
  assert.equal(nextDeadline(state), 2000);
  const batch = worker.prepare(JSON.parse(JSON.stringify(state)), 2000);
  assert.equal(batch.jobs.length, 3);
  assert.equal(batch.state.metadata_deadline, 22000);
  assert.equal(worker.prepare(batch.state, 21999).jobs.length, 0);
  assert.equal(worker.prepare(batch.state, 22000).jobs[0].attempt, 2);
  const exhausted = { ...batch.state, pending_metadata: batch.jobs.map(job => ({ ...job, attempt: 3 })) };
  assert.equal(worker.prepare(exhausted, 22000).state.metadata_deadline, null);
});

test('metadata enriches queue/history/logs but a stale URL cannot overwrite replacement media', () => {
  const initial = room();
  initial.activity_log = [{ action: 'added', detail: initial.queue[0].url, user: 'Alice', at: '2026-01-01T00:00:00Z' }];
  const job = initial.queue[0];
  const updated = applyMetadata(initial, job, { title: 'Video title', duration: 100 }).state;
  assert.equal(updated.queue[0].title, 'Video title');
  assert.equal(updated.history[0].item.duration, 100);
  assert.equal(updated.activity_log[0].detail, 'Video title');
  const replacement = { ...initial, queue: [{ ...job, url: 'https://youtu.be/replacement', title: 'New video' }] };
  const stale = applyMetadata(replacement, job, { title: 'Old result' }).state;
  assert.equal(stale.queue[0].title, 'New video');
  assert.equal(stale.history[0].item.title, 'Old result');
});

test('unused and direct-video metadata do not create wake-up work', () => {
  const worker = new RoomMetadata({}), state = room();
  assert.equal(worker.enqueue(state, { id: 'missing', url: 'https://youtu.be/missing', source_type: 'youtube' }, 2000), state);
  const direct = { ...state.queue[0], source_type: 'direct_url' };
  assert.equal(worker.enqueue(state, direct, 2000), state);
  assert.deepEqual(applyMetadata(state, state.queue[0], null), { state, events: [] });
});
