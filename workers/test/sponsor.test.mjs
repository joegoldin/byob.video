import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSponsor, applySponsor } from '../src/sponsor.mjs';
import { RoomMetadata } from '../src/room-metadata.mjs';
import { newRoom } from '../src/room-state.mjs';

const item = { id: 'item1', url: 'https://youtu.be/dQw4w9WgXcQ', source_type: 'youtube', source_id: 'dQw4w9WgXcQ' };

test('SponsorBlock preserves wire fields and duration, rejects malformed segments and reuses cache', async () => {
  let cached, calls = 0;
  const cache = { match: async () => cached?.clone(), put: async (_key, response) => { cached = response; } };
  const fetcher = async url => {
    calls++;
    assert.equal(new URL(url).searchParams.get('videoID'), item.source_id);
    assert.equal(JSON.parse(new URL(url).searchParams.get('categories')).length, 8);
    return Response.json([
      { segment: [10, 20], category: 'sponsor', actionType: 'skip', UUID: 'segment-id', videoDuration: 300 },
      { segment: [20, 10], category: 'sponsor' }, { segment: [-1, 2], category: 'sponsor' },
      { segment: [1, 2], category: 'unknown' }, null,
    ]);
  };
  const result = await fetchSponsor(item.source_id, { fetcher, cache });
  assert.deepEqual(result, { video_id: item.source_id, duration: 300, segments: [{ segment: [10, 20], category: 'sponsor', action_type: 'skip', uuid: 'segment-id', video_duration: 300 }] });
  assert.deepEqual(await fetchSponsor(item.source_id, { fetcher, cache }), result);
  assert.equal(calls, 1);
  assert.equal(await fetchSponsor(item.source_id, { fetcher: async () => new Response(null, { status: 404 }) }), null);
});

test('stale SponsorBlock results cannot attach segments to another video', () => {
  const state = { ...newRoom('abc123', 1000), queue: [item], current_index: 0 };
  const result = { video_id: item.source_id, duration: 300, segments: [{ segment: [10, 20] }] };
  assert.deepEqual(applySponsor(state, result).events, [['sponsor_segments', result]]);
  assert.equal(applySponsor(state, { ...result, video_id: 'different' }).state, state);
  assert.equal(applySponsor({ ...state, current_index: null }, result).events.length, 0);
});

test('media transitions and restarting the current item request SponsorBlock ahead of queued metadata', () => {
  const worker = new RoomMetadata({}), previous = newRoom('abc123', 1000);
  let state = { ...previous, queue: [item], current_index: 0, ready_deadline: 3500 };
  state = worker.enqueue(state, item, 1000);
  state = worker.enqueueCurrent(state, previous, 1000);
  assert.deepEqual(state.pending_metadata.map(job => job.kind), ['comments', 'sponsor', 'metadata']);
  assert.equal(worker.enqueueCurrent(state, state, 1100), state);
  const playing = { ...state, pending_metadata: [], metadata_deadline: null, ready_deadline: null, sponsor_segments: [{ segment: [10, 20] }] };
  const restarted = worker.enqueueCurrent({ ...playing, ready_deadline: 4500 }, playing, 2000);
  assert.deepEqual(restarted.pending_metadata.map(job => job.kind), ['comments', 'sponsor']);
  assert.deepEqual(restarted.sponsor_segments, []);
});
