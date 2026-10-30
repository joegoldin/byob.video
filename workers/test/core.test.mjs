import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseMediaUrl, extractUrl, youtubePlaylist } from '../src/media.mjs';
import { newSyncState, evaluateSync, resetSync, cooldownRemaining } from '../src/sync-decision.mjs';
import { newRound, castVote, tallies, resolveRound, landingSlice } from '../src/round.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/legacy.json', import.meta.url), 'utf8'));

test('parity fixtures match the original source files', async () => {
  for (const [path, hash] of Object.entries(fixture.sources)) {
    const source = await readFile(new URL(`../../${path}`, import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), hash, path);
  }
});

for (const { input, expected } of fixture.media) {
  test(`legacy media parsing: ${input}`, () => {
    if (expected.error) {
      assert.throws(() => parseMediaUrl(input, ['preview.example.test']), error => error.code === expected.error && error.service === expected.service);
    } else {
      const { id, ...actual } = parseMediaUrl(input, ['preview.example.test']);
      assert.ok(id);
      assert.deepEqual(actual, expected.ok);
    }
  });
}

test('URL extraction splits adjacent URLs and strips trailing punctuation', () => {
  assert.equal(extractUrl('https://a.comhttps://b.com/watch?v=x).'), 'https://b.com/watch?v=x');
  assert.equal(extractUrl('no URL'), null);
});

test('playlist detection preserves focus and excludes generated mixes', () => {
  assert.deepEqual(youtubePlaylist('youtube.com/watch?v=abc&list=PLexample'), { id: 'PLexample', focus: 'abc' });
  assert.equal(youtubePlaylist('https://youtube.com/watch?v=abc&list=RDabc'), null);
  assert.equal(youtubePlaylist('https://elsewhere.test/?list=PLexample'), null);
});

test('sync decisions reproduce the legacy transition trace', () => {
  let state = newSyncState();
  for (const step of fixture.sync) {
    const result = evaluateSync(state, step.data, step.room, step.now);
    assert.deepEqual(result, { state: step.state, seek: step.seek });
    state = result.state;
  }
  assert.equal(resetSync(state).learned_l_ms, state.learned_l_ms);
  assert.equal(resetSync(state).seek_streak, 0);
  assert.equal(cooldownRemaining({ ...state, last_seek_at: 9e12 }, 100), 5000);
});

test('roulette landing matches the legacy physics across seeds and wheel sizes', () => {
  for (const { seed, count, slice } of fixture.roulette) assert.equal(landingSlice(seed, count), slice);
});

test('votes replace an earlier choice; ties and no-vote outcomes remain defined', () => {
  const candidates = ['a', 'b', 'c'].map(external_id => ({ external_id }));
  let round = newRound('voting', 'user1', candidates, 1000);
  assert.equal(round.expires_at, 16000);
  assert.equal(resolveRound(round, 123).outcome, 'no_votes');
  round = castVote(round, 'user1', 'a');
  round = castVote(round, 'user1', 'b');
  round = castVote(round, 'user2', 'b');
  assert.deepEqual(tallies(round), { a: 0, b: 2, c: 0 });
  assert.deepEqual(castVote(round, 'user1', 'missing'), round);
  assert.equal(resolveRound(round, 123).round.winner_external_id, 'b');
  const roulette = newRound('roulette', 'user1', candidates, 1000);
  assert.equal(roulette.expires_at, 7500);
  assert.equal(resolveRound(roulette, 123).round.winner_external_id, candidates[landingSlice(123, 3)].external_id);
});
