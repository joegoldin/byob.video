import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRoomApi } from '../src/api.mjs';
import { newRoom } from '../src/room-state.mjs';

test('REST queue, playback and user operations retain response envelopes and field names', () => {
  let state = newRoom('abc123', 1000);
  const add = executeRoomApi(state, 'POST', '/queue', { url: 'https://youtu.be/dQw4w9WgXcQ' }, 2000);
  assert.deepEqual(add.body, { ok: true, data: { message: 'Added to queue.' } });
  state = add.state;
  const queue = executeRoomApi(state, 'GET', '/queue', {}, 2000).body;
  assert.deepEqual(Object.keys(queue.data.queue[0]).sort(), ['added_by', 'id', 'source_type', 'thumbnail_url', 'title', 'url']);
  assert.equal(queue.data.queue[0].title, null);
  assert.equal(queue.data.current_index, 0);
  const play = executeRoomApi(state, 'POST', '/play', { position: 10 }, 3000);
  assert.equal(play.body.data.message, 'Playing.');
  const show = executeRoomApi(play.state, 'GET', '', {}, 4000).body.data;
  assert.equal(show.current_time, 11);
  assert.equal(show.queue_length, 1);
  assert.equal(show.user_count, 1);
  const rename = executeRoomApi(play.state, 'PUT', '/username', { username: 'API friend' }, 4000);
  assert.equal(rename.body.data.username, 'API friend');
  assert.equal(executeRoomApi(rename.state, 'GET', '/users', {}, 4000).body.data.users[0].username, 'API friend');
  assert.equal(executeRoomApi(rename.state, 'GET', '/queue', {}, 4000).body.data.queue[0].added_by, 'API friend');
  const deleted = executeRoomApi(rename.state, 'DELETE', `/queue/${state.queue[0].id}`, {}, 4000);
  assert.equal(deleted.state.queue.length, 0);
  assert.equal(deleted.body.data.message, 'Removed from queue.');
});

test('REST read responses never contain the room API key', () => {
  const state = newRoom('abc123', 1000);
  for (const path of ['', '/queue', '/users']) assert.equal(JSON.stringify(executeRoomApi(state, 'GET', path, {}, 2000).body).includes(state.api_key), false);
  assert.equal(executeRoomApi(state, 'GET', '/unknown', {}, 2000).status, 404);
  assert.throws(() => executeRoomApi(state, 'POST', '/queue', { url: 'javascript:alert(1)' }, 2000), /invalid_url/);
});
