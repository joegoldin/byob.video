import test from 'node:test';
import assert from 'node:assert/strict';
import { roomCommand } from '../src/commands.mjs';
import { newRoom } from '../src/room-state.mjs';
import { joinPeer } from '../src/peers.mjs';

const peer = { userId: 'alice', role: 'browser', siteHost: 'preview.example.test' };
function room() { return joinPeer(newRoom('abc123', 1000), 'alice', 'Alice', false, 1000).state; }

test('browser queue commands preserve attribution, pasted URL extraction and history replay', () => {
  const added = roomCommand(room(), peer, 'add_url', { url: 'watch this https://youtu.be/dQw4w9WgXcQ', mode: 'now' }, 2000);
  assert.equal(added.state.queue[0].added_by_name, 'Alice');
  assert.equal(added.state.queue[0].url, 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(added.state.play_state, 'paused');
  const replay = roomCommand(added.state, peer, 'queue:readd', { url: added.state.queue[0].url }, 3000);
  assert.equal(replay.state.queue.length, 2);
  const selected = roomCommand(replay.state, peer, 'queue:play_index', { index: '1' }, 4000);
  assert.equal(selected.state.queue.length, 1);
  assert.equal(selected.state.activity_log[0].action, 'played');
});

test('legacy extension diagnostics are acknowledged without persisting or broadcasting their contents', () => {
  const state = room();
  const result = roomCommand(state, { ...peer, role: 'extension' }, 'debug:log', { message: 'private diagnostic' }, 2000);
  assert.equal(result.state, state);
  assert.deepEqual(result.events, []);
  assert.throws(() => roomCommand(state, peer, 'debug:log', {}, 2000), /extension_required/);
});

test('settings and rename mutate shared state without accepting unknown categories or indices', () => {
  let state = roomCommand(room(), peer, 'sb:update', { category: 'sponsor', action: 'disabled' }, 2000).state;
  assert.equal(state.sb_settings.sponsor, 'disabled');
  state = roomCommand(state, peer, 'username:change', { username: 'Renamed' }, 3000).state;
  assert.equal(state.users.alice.username, 'Renamed');
  assert.equal(state.activity_log[0].action, 'renamed');
  assert.throws(() => roomCommand(state, peer, 'sb:update', { category: '__proto__', action: 'disabled' }, 3000), /invalid_settings/);
  assert.throws(() => roomCommand(state, peer, 'queue:play_index', { index: '1garbage' }, 3000), /invalid_index/);
  assert.throws(() => roomCommand(state, peer, 'add_url', { url: 'https://preview.example.test/room/abc123' }, 3000), /self_reference/);
});
