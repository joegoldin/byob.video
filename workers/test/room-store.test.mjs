import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RoomStore } from '../src/room-store.mjs';
import { newRoom } from '../src/room-state.mjs';
import { newSyncState } from '../src/sync-decision.mjs';
import { currentPosition } from '../src/room-sync.mjs';

// Exercise the same SQL against SQLite locally; actual Durable Object storage
// and hibernation are a separate integration gate, not simulated by this test.
function eagerStorage() {
  const db = new DatabaseSync(':memory:');
  return { db, sql: { exec(sql, ...params) {
    const rows = db.prepare(sql).all(...params);
    return { toArray: () => rows };
  } }, transactionSync(fn) {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}

test('SQLite round trip preserves API key, playback anchor, deadlines and learned latency', () => {
  const backend = eagerStorage();
  try {
    const store = new RoomStore(backend);
    assert.equal(store.load(), null);
    const state = newRoom('abc123', 1000);
    Object.assign(state, { queue: [{ id: 'video1', duration: 300 }], current_index: 0, current_time: 10, play_state: 'playing', playback_rate: 2, ready_deadline: 5000 });
    state.user_sync_states.a = { ...newSyncState(), learned_l_ms: 220 };
    state.drift_samples.a = { drift_ms: -700, updated_at: 1000 };
    store.save(state);
    const restored = new RoomStore(backend).load();
    assert.equal(restored.api_key, state.api_key);
    assert.equal(restored.ready_deadline, 5000);
    assert.equal(restored.user_sync_states.a.learned_l_ms, 220);
    assert.deepEqual(restored.drift_samples, {});
    assert.equal(currentPosition(restored, 6000), 20);
    store.save({ ...restored, current_time: 40 });
    assert.equal(backend.sql.exec('SELECT COUNT(*) AS count FROM room_state').toArray()[0].count, 1);
    assert.equal(store.load().current_time, 40);
  } finally { backend.db.close(); }
});

test('unsupported schema or oversized state cannot overwrite a valid checkpoint', () => {
  const backend = eagerStorage();
  try {
    const store = new RoomStore(backend), original = newRoom('abc123', 1000);
    store.save(original);
    assert.throws(() => store.save({ ...original, schema_version: 99 }), /unsupported_room_schema/);
    assert.throws(() => store.save({ ...original, oversized: 'x'.repeat(1024 * 1024) }), /room_state_too_large/);
    assert.equal(store.load().api_key, original.api_key);
    backend.sql.exec('UPDATE room_state SET schema_version = 99');
    assert.throws(() => store.load(), /unsupported_room_schema/);
  } finally { backend.db.close(); }
});

function legacyRoom() {
  const item = { id: 'old-item', url: 'https://example.com/video.webm', source_type: 'direct_url', title: 'Original title', duration: 100, added_by: 'legacy-owner', added_at: '2025-01-02T03:04:05Z' };
  return { room_id: 'oldroom1', schema_version: 1, updated_at: 1000, state: {
    room_id: 'oldroom1', api_key: 'legacy-fixture-preserved-key', host_id: 'legacy-owner',
    queue: [item], current_index: 0, current_time: 42, play_state: 'playing', playback_rate: 2,
    persisted_wallclock: 1000, last_sync_at: -99999999,
    history: [{ item, played_at: '2025-01-02T04:05:06Z' }],
    sb_settings: { intro: 'disabled' }, activity_log: [{ action: 'added', user: 'Legacy name', at: '2025-01-02T03:04:05Z', detail: 'Original title' }],
    users: { orphan: { connected: true } }, ready_deadline: 20,
  } };
}

test('legacy import preserves durable data and wall-clock rate without restoring old transports or timers', async () => {
  const backend = eagerStorage();
  try {
    const store = new RoomStore(backend), record = legacyRoom();
    assert.deepEqual(await store.importLegacy(record, 1005000), { imported: true });
    const state = new RoomStore(backend).load();
    for (const field of ['room_id', 'api_key', 'host_id', 'queue', 'history', 'activity_log']) assert.deepEqual(state[field], record.state[field]);
    assert.equal(state.sb_settings.intro, 'disabled');
    assert.equal(currentPosition(state, 1005000), 52);
    assert.deepEqual(state.users, {});
    assert.equal(state.ready_deadline, null);
    assert.equal(state.empty_deadline, null);
    store.save({ ...state, current_time: 55 });
    assert.deepEqual(await store.importLegacy(record, 1006000), { imported: false });
    assert.equal(store.load().current_time, 55, 'retry must not rewind subsequent live changes');
    await assert.rejects(store.importLegacy({ ...record, updated_at: 2000 }, 1006000), /migration_room_conflict/);
  } finally { backend.db.close(); }
});

test('legacy import rejects malformed data and refuses to overwrite a non-migrated room', async () => {
  const backend = eagerStorage();
  try {
    const store = new RoomStore(backend), record = legacyRoom();
    await assert.rejects(store.importLegacy({ ...record, schema_version: 99 }, 1005000), /invalid_legacy_room/);
    await assert.rejects(store.importLegacy({ ...record, state: { ...record.state, current_index: 5 } }, 1005000), /invalid_legacy_room/);
    assert.equal(store.load(), null);
    const original = newRoom('oldroom1', 1000);
    store.save(original);
    await assert.rejects(store.importLegacy(record, 1005000), /migration_room_conflict/);
    assert.equal(store.load().api_key, original.api_key);
  } finally { backend.db.close(); }
});
