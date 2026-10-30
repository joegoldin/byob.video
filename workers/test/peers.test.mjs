import test from 'node:test';
import assert from 'node:assert/strict';
import { newRoom } from '../src/room-state.mjs';
import { joinPeer, leavePeer, finalizeLeaves, renamePeer, readyCount } from '../src/peers.mjs';

test('extension identity follows its owner rather than a stale client-supplied name', () => {
  let state = joinPeer(newRoom('abc123', 0), 'owner', 'Alice', false, 1000).state;
  state = joinPeer(state, 'ext:owner', 'Stale name', true, 1100).state;
  assert.equal(state.users['ext:owner'].username, 'Alice');
  state.open_tabs.tab1 = 'owner';
  state.ready_tabs.tab1 = 'owner';
  state = renamePeer(state, 'owner', 'Renamed').state;
  assert.equal(state.users['ext:owner'].username, 'Renamed');
  assert.deepEqual(readyCount(state), { ready: 1, has_tab: 1, total: 1, needs_open: [], needs_play: [], users_with_open_tabs: ['owner'] });
});

test('browser join heals extension-first race without duplicate presence toasts', () => {
  let state = joinPeer(newRoom('abc123', 0), 'ext:owner', null, true, 1000).state;
  state = joinPeer(state, 'owner', 'Alice', false, 1100).state;
  assert.equal(state.users['ext:owner'].username, 'Alice');
  const reconnect = joinPeer(state, 'owner', 'Alice', false, 1200);
  assert.equal(reconnect.events.some(([name]) => name === 'room_presence'), false);
});

test('reconnect within grace cancels leave; final departure pauses and clears only that owner tabs', () => {
  let state = joinPeer(newRoom('abc123', 0), 'a', 'Alice', false, 1000).state;
  state = joinPeer(state, 'b', 'Bob', false, 1100).state;
  state = { ...state, play_state: 'playing', current_time: 10, last_sync_at: 1000 };
  const grace = leavePeer(state, 'b', 2000);
  assert.equal(finalizeLeaves(grace, 6999).state.users.b.connected, true);
  const reconnect = joinPeer(grace, 'b', 'Bob', false, 3000).state;
  assert.equal(finalizeLeaves(reconnect, 8000).state.users.b.connected, true);
  const left = finalizeLeaves(grace, 7000);
  assert.equal(left.state.users.b.connected, false);
  assert.equal(left.state.play_state, 'paused');
  assert.equal(left.state.current_time, 16);
  state = joinPeer(state, 'ext:a', null, true, 2000).state;
  state.open_tabs = { tabA: 'a', tabB: 'b' };
  state.ready_tabs = { tabA: 'a', tabB: 'b' };
  const extensionLeft = finalizeLeaves(leavePeer(state, 'ext:a', 3000), 8000).state;
  assert.deepEqual(extensionLeft.open_tabs, { tabB: 'b' });
  assert.deepEqual(extensionLeft.ready_tabs, { tabB: 'b' });
});
