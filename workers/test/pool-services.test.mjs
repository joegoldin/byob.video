import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPoolPage, validateCandidates, curatedPlaylists } from '../src/pool-sources.mjs';
import { enqueuePick, PoolPicks } from '../src/pool-picks.mjs';
import { newRoom } from '../src/room-state.mjs';

const env = { YOUTUBE_API_KEY: 'pool-test-key' };
test('pool source pages preserve source identity, duration and resumable curated pagination', async () => {
  const trending = await fetchPoolPage({ kind: 'trending' }, env, { fetcher: async url => {
    assert.equal(new URL(url).searchParams.get('chart'), 'mostPopular');
    return Response.json({ items: [{ id: 'abcdefghijk', snippet: { title: 'Trending', channelTitle: 'Channel', thumbnails: { high: { url: 'https://i.ytimg.com/cover.jpg' } } }, contentDetails: { duration: 'PT2M' }, status: { embeddable: false } }] });
  } });
  assert.equal(trending.entries[0].duration_s, 120);
  assert.equal(trending.entries[0].embeddable, false);
  assert.equal(trending.entries[0].source_type, 'trending');
  const curated = await fetchPoolPage({ kind: 'curated', detail: curatedPlaylists[0], token: 'page2' }, env, { fetcher: async url => {
    assert.equal(new URL(url).searchParams.get('pageToken'), 'page2');
    return Response.json({ items: [{ contentDetails: { videoId: 'abcdefghijk' }, snippet: { title: 'Curated', videoOwnerChannelTitle: 'Owner' } }], nextPageToken: 'page3' });
  } });
  assert.equal(curated.next_page_token, 'page3');
  assert.equal(curated.entries[0].source_detail, curatedPlaylists[0]);
  assert.equal(curated.entries[0].channel, 'Owner');
});

test('subreddit parsing admits YouTube links only, and candidate validation rejects known missing or unembeddable videos', async () => {
  const source = await fetchPoolPage({ kind: 'subreddit', detail: 'videos' }, {}, { fetcher: async (_url, options) => {
    assert.equal(options.headers.get('User-Agent'), 'byob.video/1.0 (+https://byob.video)');
    return Response.json({ data: { children: [{ data: { url: 'https://youtu.be/abcdefghijk', title: 'Post', ups: 42 } }, { data: { url: 'https://example.com/not-youtube', title: 'Other' } }] } });
  } });
  assert.equal(source.entries.length, 1);
  assert.equal(source.entries[0].score, 42);
  const rows = [...source.entries, { ...source.entries[0], external_id: 'blocked' }, { ...source.entries[0], external_id: 'missing' }];
  const validated = await validateCandidates(rows, env, { fetcher: async () => Response.json({ items: [
    { id: 'abcdefghijk', snippet: { title: 'Canonical video' }, contentDetails: { duration: 'PT1M' }, status: { embeddable: true } },
    { id: 'blocked', status: { embeddable: false } },
  ] }) });
  assert.equal(validated.length, 1);
  assert.equal(validated[0].title, 'Canonical video');
  assert.equal(validated[0].duration_s, 60);
  assert.equal(await validateCandidates(rows, {}, {}), rows);
});

test('winner outbox persists a lease, retries failures, and acknowledges only the exact delivered timestamp', async () => {
  const calls = [], persisted = [];
  const owner = { room: enqueuePick(newRoom('abc123', 1000), 'video', 1000), env: { POOL: { getByName: () => ({ markPicked: async (...args) => { calls.push(args); } }) } },
    async persist(state) { this.room = state; persisted.push(state); } };
  await new PoolPicks(owner).flush();
  assert.deepEqual(calls, [['video', 1000]]);
  assert.ok(persisted[0].pool_pick_deadline > Date.now());
  assert.deepEqual(owner.room.pending_pool_picks, []);
  assert.equal(owner.room.pool_pick_deadline, null);
  owner.room = enqueuePick(owner.room, 'video', 2000);
  owner.env.POOL.getByName = () => ({ markPicked: async () => { throw new Error('temporarily unavailable'); } });
  await new PoolPicks(owner).flush();
  assert.equal(owner.room.pending_pool_picks[0].at, 2000);
  assert.ok(owner.room.pool_pick_deadline > Date.now());
  owner.room.pool_pick_deadline = 0;
  owner.env.POOL.getByName = () => ({ markPicked: async () => { owner.room = enqueuePick(owner.room, 'video', 3000); } });
  await new PoolPicks(owner).flush();
  assert.equal(owner.room.pending_pool_picks[0].at, 3000, 'an older acknowledgement must not erase a newer pick');
});
