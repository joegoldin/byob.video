import test from 'node:test';
import assert from 'node:assert/strict';
import { startRound, voteRound, cancelRound, advanceRound } from '../src/room-rounds.mjs';
import { newRoom, nextDeadline } from '../src/room-state.mjs';

const candidates = ['dQw4w9WgXcQ', 'abcdefghijk'].map((id, index) => ({ external_id: id, title: `Candidate ${index}`, duration_s: 120, thumbnail_url: 'https://i.ytimg.com/cover.jpg', source_type: 'curated' }));
function room() {
  return { ...newRoom('abc123', 1000), users: {
    alice: { connected: true, username: 'Alice', is_extension: false },
    bob: { connected: true, username: 'Bob', is_extension: false },
    'ext:alice': { connected: true, username: 'Alice', is_extension: true },
  } };
}

test('voting closes when all connected non-extension users vote, reveals then enqueues once', () => {
  let state = startRound(room(), 'voting', 'alice', candidates, 1000).state;
  const id = state.round.id;
  assert.equal(nextDeadline(state), 16000);
  state = voteRound(state, 'alice', id, candidates[0].external_id, 1100, 0).state;
  assert.equal(state.round.phase, 'active');
  const voted = voteRound(state, 'bob', id, candidates[0].external_id, 1200, 0);
  assert.deepEqual(voted.events[0], ['round_revealed', { mode: 'voting', winner_external_id: candidates[0].external_id, tallies: { dQw4w9WgXcQ: 2, abcdefghijk: 0 } }]);
  state = voted.state;
  assert.equal(nextDeadline(state), 2700);
  assert.equal(advanceRound(state, 2699).state, state);
  const completed = advanceRound(JSON.parse(JSON.stringify(state)), 2700);
  assert.equal(completed.state.round, null);
  assert.equal(completed.state.queue.length, 1);
  assert.equal(completed.state.queue[0].source_id, candidates[0].external_id);
  assert.equal(completed.state.queue[0].added_by_name, 'Alice');
  assert.equal(completed.state.ready_deadline, 5200);
  assert.equal(completed.picked_external_id, candidates[0].external_id);
  assert.equal(completed.metadata_item.id, completed.state.queue[0].id);
  assert.equal(advanceRound(completed.state, 9000).state.queue.length, 1);
  assert.throws(() => voteRound(completed.state, 'bob', id, candidates[0].external_id, 9000), /invalid_round/);
});

test('no-vote expiry cancels, votes are replaceable, and cancellation belongs to the starter', () => {
  const initial = startRound(room(), 'voting', 'alice', candidates, 1000).state;
  assert.throws(() => startRound(initial, 'roulette', 'bob', candidates, 1001), /round_active/);
  assert.throws(() => cancelRound(initial, 'bob', initial.round.id, 1100), /not_authorized/);
  assert.equal(cancelRound(initial, 'alice', initial.round.id, 1100).state.round, null);
  const expired = advanceRound(initial, 16000, 0);
  assert.deepEqual(expired.events[0], ['round_cancelled', { reason: 'no_votes' }]);
  assert.equal(expired.state.round, null);
  let state = voteRound(initial, 'alice', initial.round.id, candidates[0].external_id, 1100).state;
  state = voteRound(state, 'alice', initial.round.id, candidates[1].external_id, 1200).state;
  assert.deepEqual(state.round.votes[candidates[0].external_id], []);
  assert.deepEqual(state.round.votes[candidates[1].external_id], ['alice']);
  assert.throws(() => voteRound(initial, 'alice', initial.round.id, candidates[0].external_id, 16000), /invalid_round/);
});

test('roulette retains its seed and full animation delay across state restoration', () => {
  const initial = startRound(room(), 'roulette', 'alice', candidates, 1000).state;
  assert.equal(initial.round.expires_at, 7500);
  const revealed = advanceRound(initial, 7500, 123456);
  assert.equal(revealed.state.round.seed, 123456);
  assert.equal(revealed.state.round.finalize_at, 15500);
  assert.equal(nextDeadline(revealed.state), 15500);
  const restored = JSON.parse(JSON.stringify(revealed.state));
  assert.equal(advanceRound(restored, 15499).state, restored);
  assert.equal(advanceRound(restored, 15500).state.queue[0].source_id, restored.round.winner_external_id);
  assert.throws(() => cancelRound(restored, 'alice', restored.round.id, 7600), /not_authorized/);
});
