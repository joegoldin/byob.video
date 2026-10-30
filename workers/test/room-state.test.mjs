import test from 'node:test';
import assert from 'node:assert/strict';
import { newRoom, roomSnapshot, nextDeadline, logActivity } from '../src/room-state.mjs';
import { newRound, castVote } from '../src/round.mjs';

test('public snapshots never include API keys or transport/internal decision state', () => {
  const state = newRoom('abc123', 1000);
  assert.equal(state.api_key.length, 43);
  const publicState = roomSnapshot(state, 2000);
  for (const key of ['api_key', 'user_sync_states', 'pending_leaves', 'event_counts', 'open_tabs']) assert.equal(Object.hasOwn(publicState, key), false);
  assert.equal(JSON.stringify(publicState).includes(state.api_key), false);
  assert.throws(() => newRoom('../private', 0), /invalid_room/);
});

test('only actual state-transition deadlines schedule alarms, not periodic sync ticks', () => {
  const state = newRoom('abc123', 1000);
  assert.equal(nextDeadline(state), 1000 + 24 * 60 * 60 * 1000);
  assert.equal(nextDeadline({ ...state, empty_deadline: null, idle_expired_at: 30000000 }), null);
  assert.equal(nextDeadline({ ...state, ready_deadline: 3500, advance_deadline: 6000 }), 3500);
  assert.equal(nextDeadline({ ...state, pending_leaves: { a: 2500 } }), 2500);
  assert.equal(nextDeadline({ ...state, round: { phase: 'revealing', expires_at: 2000, finalize_at: 4000 } }), 4000);
});

test('round snapshots expose the legacy tally and voter fields rather than internal scheduling state', () => {
  const state = newRoom('abc123', 1000);
  state.round = castVote(newRound('voting', 'user1', [{ external_id: 'video1' }], 1000), 'user1', 'video1');
  const snapshot = roomSnapshot(state, 2000).round;
  assert.deepEqual(snapshot.tallies, { video1: 1 });
  assert.deepEqual(snapshot.voter_ids_by_candidate, { video1: ['user1'] });
  assert.equal(snapshot.server_time, 2000);
});

test('activity history deduplicates rapid echoes and bounds storage and public output', () => {
  let state = newRoom('abc123', 1000);
  state = logActivity(state, 'play', 'a', null, 2000);
  assert.equal(logActivity(state, 'play', 'a', null, 3000).activity_log.length, 1);
  for (let i = 0; i < 250; i++) state = logActivity(state, 'play', 'a', null, 5000 + i * 3000);
  assert.equal(state.activity_log.length, 200);
  assert.equal(roomSnapshot(state, 1000000).activity_log.length, 50);
});
