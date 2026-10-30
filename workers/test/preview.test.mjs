import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlaylist, fetchPreview, addPlaylist } from '../src/preview.mjs';
import { newRoom } from '../src/room-state.mjs';

const env = { YOUTUBE_API_KEY: 'test-only-playlist-key' };
const url = 'https://www.youtube.com/watch?v=abcdefghijk&list=PL123';
const items = [
  { snippet: { title: 'First', thumbnails: { medium: { url: 'https://example.com/first.jpg' } }, videoOwnerChannelTitle: 'Owner', position: 0 }, contentDetails: { videoId: 'dQw4w9WgXcQ' } },
  { snippet: { title: 'Focused', position: 1 }, contentDetails: { videoId: 'abcdefghijk' } },
];
const fetcher = async input => {
  const request = new URL(input);
  if (request.pathname.endsWith('/playlistItems')) {
    assert.equal(request.searchParams.get('maxResults'), '50');
    return Response.json({ items, nextPageToken: 'another-page' });
  }
  assert.ok(request.pathname.endsWith('/playlists'));
  return Response.json({ items: [{ snippet: { title: 'Playlist', channelTitle: 'Channel' }, contentDetails: { itemCount: 70 } }] });
};

test('playlist previews preserve count, truncation, attribution and focus-first ordering', async () => {
  const playlist = await fetchPlaylist('PL123', env, { fetcher });
  assert.equal(playlist.total_count, 70);
  assert.equal(playlist['truncated?'], true);
  assert.equal(playlist.items[0].channel_title, 'Owner');
  const preview = await fetchPreview(`Watch this ${url}`, env, [], { fetcher });
  assert.equal(preview.resolved_url, url);
  assert.equal(preview.preview.source_type, 'playlist');
  assert.deepEqual(preview.preview.items.map(item => item.video_id), ['abcdefghijk', 'dQw4w9WgXcQ']);
});

test('playlist results stay bounded and daily quota failure stops further provider requests', async () => {
  const oversized = await fetchPlaylist('PLlarge', env, { fetcher: async input => new URL(input).pathname.endsWith('/playlistItems')
    ? Response.json({ items: Array.from({ length: 60 }, () => items[0]), nextPageToken: 'more' })
    : Response.json({ items: [{ contentDetails: { itemCount: 60 } }] }) });
  assert.equal(oversized.items.length, 50);
  let calls = 0;
  const quota = await fetchPlaylist('PLquota', env, { fetcher: async () => {
    calls++;
    return Response.json({ error: { errors: [{ reason: 'dailyLimitExceeded' }] } }, { status: 403 });
  } });
  assert.equal(quota.error, 'quota_exhausted');
  assert.equal(calls, 1);
});

test('unavailable playlists fall back to video previews; direct previews make no network request', async () => {
  let calls = 0;
  const fallback = await fetchPreview(url, {}, [], { fetcher: async input => {
    calls++;
    assert.equal(new URL(input).hostname, 'www.youtube.com');
    return Response.json({ title: 'Single video' });
  } });
  assert.equal(fallback.preview.source_type, 'youtube');
  assert.equal(fallback.preview.title, 'Single video');
  assert.equal(calls, 1);
  const direct = await fetchPreview('https://example.com/movie.mp4', {}, [], { fetcher: async () => { calls++; return new Response('video'); } });
  assert.equal(direct.preview.title, 'movie.mp4');
  assert.equal(calls, 1);
  assert.deepEqual(await fetchPreview(' ', {}), { resolved_url: null, preview: null });
  await assert.rejects(fetchPreview('https://byob.video/room/abc123', {}), /self_reference/);
});

test('playlist all/selected/single additions preserve source order, attribution and capacity', async () => {
  const preview = (await fetchPreview(url, env, [], { fetcher })).preview;
  const state = newRoom('abc123', 1000);
  state.users.alice = { username: 'Alice' };
  const peer = { userId: 'alice', role: 'browser' };
  const all = addPlaylist(state, peer, preview, { scope: 'all', mode: 'queue' }, 2000);
  assert.deepEqual(all.state.queue.map(item => item.source_id), ['abcdefghijk', 'dQw4w9WgXcQ']);
  assert.equal(all.state.queue[0].added_by_name, 'Alice');
  assert.equal(all.metadata_items.length, 2);
  const single = addPlaylist(state, peer, preview, { scope: 'single', video_id: 'dQw4w9WgXcQ', mode: 'now' }, 2000);
  assert.equal(single.state.queue[0].title, 'First');
  const selected = addPlaylist(state, peer, preview, { scope: 'selected', selected: ['dQw4w9WgXcQ', 'forged-video'], mode: 'queue' }, 2000);
  assert.equal(selected.added_count, 1);
  assert.throws(() => addPlaylist(state, peer, preview, { scope: 'selected', selected: [], mode: 'queue' }, 2000), /no_items/);
  const full = { ...state, queue: Array.from({ length: 200 }, (_, id) => ({ id: String(id) })), current_index: 0 };
  assert.throws(() => addPlaylist(full, peer, preview, { scope: 'all', mode: 'queue' }, 2000), /queue_full/);
  const replaced = addPlaylist(full, peer, preview, { scope: 'all', mode: 'now' }, 2000);
  assert.equal(replaced.added_count, 1);
  assert.equal(replaced.state.queue.length, 200);
});
