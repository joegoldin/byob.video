import test from 'node:test';
import assert from 'node:assert/strict';
import { newRoom, nextDeadline } from '../src/room-state.mjs';
import { idleTimeout, planIdle, touchIdle, expireIdle, reconcileConnections } from '../src/room-lifecycle.mjs';
import { joinPeer, finalizeLeaves } from '../src/peers.mjs';

test('idle expiry is one-shot and retains queue, history, API key and learned device state', () => {
  const state = newRoom('abc123', 1000);
  state.queue = [{ id: 'item', url: 'https://example.com/video.mp4' }];
  state.history = [{ item: state.queue[0] }];
  state.user_sync_states = { alice: { learned_l_ms: 220 } };
  state.users['api:actor'] = { username: 'API actor', connected: true };
  assert.equal(nextDeadline(state), 1000 + idleTimeout);
  assert.equal(expireIdle(state, 1000 + idleTimeout - 1), state);
  const expired = expireIdle(state, 1000 + idleTimeout);
  assert.equal(expired.api_key, state.api_key);
  assert.equal(expired.queue, state.queue);
  assert.equal(expired.history, state.history);
  assert.equal(expired.user_sync_states, state.user_sync_states);
  assert.equal(expired.users['api:actor'].connected, false);
  assert.equal(nextDeadline(expired), null);
  assert.equal(planIdle(expired, state, 1000 + idleTimeout), expired);
  assert.equal(expireIdle(expired, 1000 + 2 * idleTimeout), expired);
  assert.equal(touchIdle(expired, 50000000).empty_deadline, 50000000 + idleTimeout);
});

test('join cancels idle retirement; last real departure rearms it without treating API actors as viewers', () => {
  const initial = newRoom('abc123', 1000);
  const joined = joinPeer(initial, 'alice', 'Alice', false, 2000).state;
  assert.equal(planIdle(joined, initial, 2000).empty_deadline, null);
  const staleAlarm = expireIdle({ ...joined, empty_deadline: 1000 }, 2000);
  assert.equal(staleAlarm.users.alice.connected, true);
  const leaving = { ...joined, users: { ...joined.users, 'api:actor': { connected: true } }, pending_leaves: { alice: 5000 } };
  const departed = finalizeLeaves(leaving, 5000).state;
  assert.equal(planIdle(departed, leaving, 5000).empty_deadline, 5000 + idleTimeout);
});

test('hard restart reconciles orphaned transports once, while hibernating live sockets remain untouched', () => {
  const state = joinPeer(newRoom('abc123', 1000), 'alice', 'Alice', false, 1000).state;
  assert.equal(reconcileConnections(state, new Set(['alice']), 2000), state);
  const recovered = reconcileConnections(state, new Set(), 2000);
  assert.equal(recovered.pending_leaves.alice, 7000);
  assert.equal(reconcileConnections(recovered, new Set(), 3000), recovered, 'a second wake must not prolong the leave grace');
  assert.equal(finalizeLeaves(recovered, 7000).state.users.alice.connected, false);
  const rejoined = joinPeer(recovered, 'alice', 'Alice', false, 6000).state;
  assert.deepEqual(rejoined.pending_leaves, {});
});
