import test from 'node:test';
import assert from 'node:assert/strict';
import { roomCommand } from '../src/commands.mjs';
import { newRoom } from '../src/room-state.mjs';

const extension = { role: 'extension', userId: 'ext:alice' };
function room(url = 'https://youtu.be/dQw4w9WgXcQ') {
  const item = { id: 'current', url, title: null, thumbnail_url: null, is_live: false };
  return { ...newRoom('abc123', 1000), queue: [item], current_index: 0, history: [{ item }], activity_log: [{ action: 'added', detail: url }] };
}

test('live detection is limited to legacy YouTube/Twitch hosts and updates history', () => {
  for (const url of ['https://youtu.be/dQw4w9WgXcQ', 'https://www.twitch.tv/channel', 'https://youtu.be./dQw4w9WgXcQ', 'https://www.twitch.tv./channel']) {
    const result = roomCommand(room(url), extension, 'video:live_status', { is_live: true, item_id: 'current' }, 1000);
    assert.equal(result.state.queue[0].is_live, true);
    assert.equal(result.state.history[0].item.is_live, true);
    assert.deepEqual(result.events[0], ['live_status', { is_live: true, item_id: 'current' }]);
    assert.equal(roomCommand(result.state, extension, 'video:live_status', { is_live: false }, 1000).state.queue[0].is_live, false);
  }
  for (const url of ['https://vimeo.com/123', 'https://www.crunchyroll.com/watch/123', 'https://example.com/video.mp4']) {
    const state = room(url);
    assert.equal(roomCommand(state, extension, 'video:live_status', { is_live: true }, 1000).state, state);
  }
  const state = room();
  assert.equal(roomCommand(state, extension, 'video:live_status', { is_live: true, item_id: 'old' }, 1000).state, state);
});

test('extension scraped metadata updates queue, history and activity without accepting unsafe images', () => {
  const state = room();
  const result = roomCommand(state, extension, 'video:media_info', { title: 'Scraped title', thumbnail_url: 'https://example.com/cover.jpg' }, 1000);
  assert.equal(result.state.queue[0].title, 'Scraped title');
  assert.equal(result.state.history[0].item.title, 'Scraped title');
  assert.equal(result.state.activity_log[0].detail, 'Scraped title');
  assert.equal(result.events.at(-1)[0], 'extension_media_info');
  assert.throws(() => roomCommand(state, { role: 'browser' }, 'video:media_info', { title: 'Spoof' }, 1000), /extension_required/);
  assert.throws(() => roomCommand(state, extension, 'video:media_info', { thumbnail_url: 'javascript:alert(1)' }, 1000), /invalid_media_info/);
  assert.equal(roomCommand(state, extension, 'video:media_info', { title: 'Stale', item_id: 'old' }, 1000).state, state);
});

test('extension URL handoff replaces in place, cancels autoplay and starts a fresh ready quorum', () => {
  const state = room();
  state.queue[0] = { ...state.queue[0], duration: 10, is_live: true, title: 'Old' };
  const successor = { id: 'next', url: 'https://example.com/next.mp4' };
  state.queue.push(successor);
  state.advance_deadline = 5000;
  const result = roomCommand(state, extension, 'video:update_url', { url: 'https://example.com/new.mp4' }, 2000);
  assert.equal(result.state.queue[0].id, 'current');
  assert.equal(result.state.queue[0].source_type, 'direct_url');
  assert.equal(result.state.queue[0].duration, null);
  assert.equal(result.state.queue[0].is_live, false);
  assert.equal(result.state.queue[1], successor);
  assert.equal(result.state.advance_deadline, null);
  assert.equal(result.state.ready_deadline, 4500);
  assert.equal(result.state.play_state, 'paused');
  assert.equal(result.events[0][0], 'autoplay_countdown_cancelled');
  assert.equal(result.metadata_item.url, 'https://example.com/new.mp4');
});

test('extension URL handoff appends when ended but cannot bypass queue bounds or site validation', () => {
  const state = newRoom('abc123', 1000);
  const result = roomCommand(state, extension, 'video:update_url', { url: 'https://example.com/new.mp4' }, 2000);
  assert.equal(result.state.current_index, 0);
  assert.equal(result.state.history.length, 1);
  assert.throws(() => roomCommand({ ...state, queue: Array(200).fill({ id: 'queued' }) }, extension, 'video:update_url', { url: 'https://example.com/new.mp4' }, 2000), /queue_full/);
  assert.throws(() => roomCommand(state, extension, 'video:update_url', { url: 'https://byob.video/room/abc123' }, 2000), /self_reference/);
});
