import test from 'node:test';
import assert from 'node:assert/strict';
import { channelState, channelEvent, driftReport } from '../src/channel.mjs';
import { newRoom } from '../src/room-state.mjs';

const browser = { userId: 'alice', role: 'browser' };
const extension = { userId: 'ext:alice', role: 'extension' };

test('extension snapshot preserves the legacy shape without exposing private room fields', () => {
  const state = newRoom('abc123', 1000);
  state.queue = [{ id: 'video', url: 'https://youtu.be/abc', source_type: 'youtube', source_id: 'abc', is_live: false, title: null }];
  state.current_index = 0;
  const snapshot = channelState(state, extension, 2000);
  assert.equal(snapshot.current_item_id, 'video');
  assert.equal(snapshot.current_source_type, 'youtube');
  assert.equal(snapshot.is_live, false);
  assert.equal(snapshot.queue_size, 1);
  assert.equal(Object.hasOwn(snapshot, 'api_key'), false);
  assert.equal(Object.hasOwn(snapshot, 'users'), false);
});

test('private correction routing and browser/extension countdown names remain distinct', () => {
  const event = ['user_seek_command', 'alice', { position: 12, server_time: 1000 }];
  assert.deepEqual(channelEvent(event, browser), ['sync:seek_command', event[2]]);
  assert.equal(channelEvent(event, extension), null);
  assert.equal(channelEvent(['autoplay_countdown', {}], browser)[0], 'sync:autoplay_countdown');
  assert.equal(channelEvent(['autoplay_countdown', {}], extension)[0], 'autoplay:countdown');
  assert.equal(channelEvent(['user_decision_state', 'alice', {}], extension), null);
});

test('drift identity comes from the signed connection, not an arbitrary payload', () => {
  const state = newRoom('abc123', 0);
  state.users.alice = { username: 'Alice' };
  const report = driftReport({ user_id: 'victim', username: 'Forged', drift_ms: 100 }, browser, state);
  assert.equal(report.user_id, 'alice');
  assert.equal(report.username, 'Alice');
  assert.equal(report.source, 'browser');
  const normalized = driftReport({ drift_ms: -300.9, offset_ms: 20.8, observed_l_ms: 220.9, rtt_ms: 80.4, playing: false, server_position: 999 }, browser, state, 1000);
  assert.equal(normalized.drift_ms, -300);
  assert.equal(normalized.raw_drift_ms, -280);
  assert.equal(normalized.observed_l_ms, 220);
  assert.equal(normalized.rtt_ms, 80);
  assert.equal(normalized.server_position, 0);
  assert.equal(normalized.play_state, 'paused');
  assert.throws(() => driftReport({ drift_ms: '100' }, browser, state), /invalid_stats/);
  assert.throws(() => driftReport({ drift_ms: Infinity }, browser, state), /invalid_stats/);
});

test('browser snapshots and readiness identify the actual owner for player echo and popup handling', () => {
  const state = newRoom('abc123', 1000);
  state.users = { alice: { username: 'Same name', connected: true }, bob: { username: 'Same name', connected: true } };
  state.open_tabs = { popup: 'alice' };
  const snapshot = channelState(state, browser, 2000);
  assert.equal(snapshot.user_id, 'alice');
  assert.equal(snapshot.ready_count.i_have_popup, true);
  const count = { users_with_open_tabs: ['alice'], ready: 0, total: 1 };
  assert.equal(channelEvent(['ready_count', count], browser)[1].i_have_popup, true);
  assert.equal(channelEvent(['ready_count', count], { userId: 'bob', role: 'browser' })[1].i_have_popup, false);
  assert.deepEqual(channelEvent(['ready_count', count], extension), ['ready:count', count]);
  assert.deepEqual(channelEvent(['ready_count', null], browser), ['ready:count', null]);
});
