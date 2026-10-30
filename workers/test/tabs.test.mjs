import test from 'node:test';
import assert from 'node:assert/strict';
import { newRoom } from '../src/room-state.mjs';
import { joinPeer } from '../src/peers.mjs';
import { updateTabs } from '../src/tabs.mjs';

const alice = { userId: 'ext:alice', ownerId: 'alice', role: 'extension' };
const bob = { userId: 'ext:bob', ownerId: 'bob', role: 'extension' };
function room() {
  let state = newRoom('abc123', 0);
  for (const [id, name, extension] of [['alice', 'Alice', false], ['bob', 'Bob', false], ['ext:alice', 'Alice', true], ['ext:bob', 'Bob', true]]) state = joinPeer(state, id, name, extension, 1000).state;
  return state;
}

test('authoritative popup resync preserves other owners and restores ready counts', () => {
  let state = updateTabs(room(), alice, 'video:tabs_resync', { tab_ids: [1, 2], ready_tab_ids: [1] }).state;
  state = updateTabs(state, bob, 'video:tabs_resync', { tab_ids: [1], ready_tab_ids: [1] }).state;
  const resynced = updateTabs(state, alice, 'video:tabs_resync', { tab_ids: [2], ready_tab_ids: [2] });
  assert.deepEqual(resynced.state.open_tabs, { 'ext:bob:1': 'bob', 'ext:alice:2': 'alice' });
  assert.deepEqual(resynced.state.ready_tabs, { 'ext:bob:1': 'bob', 'ext:alice:2': 'alice' });
  assert.equal(resynced.events.at(-1)[1].ready, 2);
  assert.equal(resynced.events.at(-1)[1].total, 2);
});

test('closing the last popup clears ready state and emits one owner-based presence event', () => {
  let state = updateTabs(room(), alice, 'video:tabs_resync', { tab_ids: [1, 2], ready_tab_ids: [1, 2] }).state;
  const first = updateTabs(state, alice, 'video:tab_closed', { tab_id: 1 });
  assert.equal(first.events.some(([name]) => name === 'room_presence'), false);
  const last = updateTabs(first.state, alice, 'video:tab_closed', { tab_id: 2 });
  assert.deepEqual(last.state.ready_tabs, {});
  assert.deepEqual(last.events[0], ['room_presence', { event: 'ext_closed', username: 'Alice' }]);
  assert.equal(updateTabs(last.state, alice, 'video:tab_closed', { tab_id: 2 }).events.some(([name]) => name === 'room_presence'), false);
});

test('tab ownership cannot be supplied by a payload or claimed by a browser connection', () => {
  const state = updateTabs(room(), alice, 'video:tab_opened', { tab_id: 1, ownerId: 'bob' }).state;
  assert.equal(state.open_tabs['ext:alice:1'], 'alice');
  assert.throws(() => updateTabs(state, { ...alice, role: 'browser' }, 'video:ready', { tab_id: 1 }), /extension_required/);
  assert.throws(() => updateTabs(state, alice, 'video:tabs_resync', { tab_ids: Array(65).fill(1) }), /invalid_tab/);
});
