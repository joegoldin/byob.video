import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchComments, commentsEvent } from '../src/comments.mjs';
import { youtubeData } from '../src/youtube.mjs';
import { newRoom } from '../src/room-state.mjs';
import { roomCommand } from '../src/commands.mjs';

const env = { YOUTUBE_API_KEY: 'test-only-provider-key' };
function cache(now = Date.now) {
  const entries = new Map();
  return {
    match: async key => { const entry = entries.get(key); return entry && entry.expires > now() ? entry.value.clone() : undefined; },
    put: async (key, value) => {
      assert.equal(key.includes(env.YOUTUBE_API_KEY), false);
      const ttl = Number(value.headers.get('Cache-Control').match(/max-age=(\d+)/)[1]);
      entries.set(key, { value, expires: now() + ttl * 1000 });
    },
  };
}

test('YouTube comment pagination retains legacy fields and plain text without exposing provider credentials', async () => {
  const result = await fetchComments('video123', 'next', env, { fetcher: async url => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('pageToken'), 'next');
    assert.equal(params.get('textFormat'), 'plainText');
    assert.equal(params.get('maxResults'), '20');
    return Response.json({ items: [{ snippet: { topLevelComment: { snippet: {
      authorDisplayName: 'Viewer', authorProfileImageUrl: 'https://example.com/avatar.jpg', textDisplay: '<b>1:23</b>', likeCount: 5, publishedAt: '2026-10-29T00:00:00Z',
    } }, totalReplyCount: 2 } }], nextPageToken: 'more', pageInfo: { totalResults: 42 } });
  } });
  assert.deepEqual(result, { video_id: 'video123', comments: [{ author: 'Viewer', author_avatar: 'https://example.com/avatar.jpg', text: '<b>1:23</b>', likes: 5, published_at: '2026-10-29T00:00:00Z', reply_count: 2 }], next_page_token: 'more', total_count: 42 });
  assert.equal(JSON.stringify(result).includes(env.YOUTUBE_API_KEY), false);
  const disabled = await fetchComments('disabled', null, env, { fetcher: async () => Response.json({ error: { errors: [{ reason: 'commentsDisabled' }] } }, { status: 403 }) });
  assert.deepEqual(disabled.comments, []);
  assert.equal((await fetchComments('video123', null, {})).error, 'not_configured');
});

test('YouTube requests share quota exhaustion across resources and resume on the next UTC day', async () => {
  let clock = Date.parse('2026-10-29T23:59:55Z');
  const storage = cache(() => clock);
  let calls = 0;
  const fetcher = async () => { calls++; return calls === 1 ? Response.json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 }) : Response.json({ items: [] }); };
  const now = clock;
  assert.equal((await youtubeData('commentThreads', { videoId: 'one' }, env, { fetcher, cache: storage, now })).error, 'quota_exhausted');
  assert.equal((await youtubeData('videos', { id: 'two' }, env, { fetcher, cache: storage, now })).error, 'quota_exhausted');
  assert.equal(calls, 1);
  clock += 10000;
  assert.deepEqual((await youtubeData('commentThreads', { videoId: 'one' }, env, { fetcher, cache: storage, now: clock })).data, { items: [] });
  assert.equal(calls, 2);
});

test('concurrent provider requests coalesce, cached pages are reused and cache failures are nonfatal', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return Response.json({ items: [] }); };
  const options = { fetcher, cache: cache() };
  await Promise.all(Array.from({ length: 5 }, () => fetchComments('coalesced', null, env, options)));
  assert.equal(calls, 1);
  await fetchComments('coalesced', null, env, options);
  assert.equal(calls, 1);
  const failedCache = { match: async () => { throw new Error('unavailable'); }, put: async () => { throw new Error('unavailable'); } };
  assert.deepEqual((await fetchComments('uncached', null, env, { fetcher, cache: failedCache })).comments, []);
  assert.equal(calls, 2);
});

test('stale comments are ignored and timestamp clicks use the canonical room seek path', () => {
  const state = { ...newRoom('abc123', 1000), queue: [{ id: 'item', url: 'https://youtu.be/video123', source_type: 'youtube', source_id: 'video123' }], current_index: 0 };
  const result = { video_id: 'video123', comments: [], next_page_token: null, total_count: 0 };
  assert.deepEqual(commentsEvent(state, result).events, [['comments_updated', result]]);
  assert.deepEqual(commentsEvent(state, { ...result, video_id: 'old' }).events, []);
  const sought = roomCommand(state, { userId: 'alice', role: 'browser' }, 'comments:seek', { seconds: '83' }, 2000);
  assert.equal(sought.state.current_time, 83);
  assert.throws(() => roomCommand(state, { userId: 'alice' }, 'comments:seek', { seconds: '-1' }, 2000), /invalid_index/);
});

test('a delayed stale cache miss cannot issue a duplicate concurrent provider request', async () => {
  const stored = cache();
  let reads = 0, calls = 0, release;
  const written = new Promise(resolve => { release = resolve; });
  const delayedCache = {
    async match(key) {
      if (key.includes('/data/') && ++reads === 2) { await written; return undefined; }
      return stored.match(key);
    },
    async put(key, value) { await stored.put(key, value); release(); },
  };
  const options = { cache: delayedCache, fetcher: async () => { calls++; return Response.json({ items: [] }); } };
  await Promise.all([
    youtubeData('videos', { id: 'cache-race' }, env, options),
    youtubeData('videos', { id: 'cache-race' }, env, options),
  ]);
  assert.equal(calls, 1);
});
