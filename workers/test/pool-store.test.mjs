import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PoolStore, poolSources } from '../src/pool-store.mjs';

function backend() {
  const db = new DatabaseSync(':memory:');
  db.function('random', () => 100000000);
  return { db, sql: { exec(sql, ...params) {
    const rows = db.prepare(sql).all(...params);
    return { toArray: () => rows };
  } }, transactionSync(fn) {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}
function entry(source, id) { return { source_type: source, external_id: id, title: id, thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }; }

test('pool refresh preserves first-seen and last-picked timestamps while refreshing metadata', () => {
  const storage = backend();
  try {
    const store = new PoolStore(storage);
    assert.equal(store.upsert([entry('trending', 'video1'), entry('curated', 'video1')], 1000), 2);
    store.markPicked('video1', 2000);
    store.upsert([{ ...entry('trending', 'video1'), title: 'Refreshed' }], 3000);
    store.markPicked('video1', 1500);
    const rows = storage.sql.exec('SELECT * FROM video_pool ORDER BY source_type').toArray();
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.first_seen_at === 1000 && row.last_picked_at === 2000));
    assert.equal(rows[1].title, 'Refreshed');
    assert.equal(rows[1].last_seen_at, 3000);
    assert.equal(new PoolStore(storage).count(), 2);
  } finally { storage.db.close(); }
});

test('pool picking balances sources, excludes queued videos and deduplicates cross-source entries', () => {
  const storage = backend();
  try {
    const store = new PoolStore(storage);
    store.upsert(poolSources.flatMap(source => Array.from({ length: 8 }, (_, index) => entry(source, `${source}${index}`))), 1000);
    const selected = store.pick([], 12, 2000);
    for (const source of poolSources) assert.equal(selected.filter(row => row.source_bucket === source).length, 4);
    const excluded = selected.map(row => row.external_id);
    assert.ok(store.pick(excluded, 12, 2000).every(row => !excluded.includes(row.external_id)));
    store.upsert(poolSources.map(source => entry(source, 'shared')), 1000);
    const withShared = store.pick([], 36, 2000);
    assert.equal(new Set(withShared.map(row => row.external_id)).size, withShared.length);
  } finally { storage.db.close(); }
});

test('pool exhaustion returns no candidates and sparse sources retain bounded legacy backfill', () => {
  const storage = backend();
  try {
    const store = new PoolStore(storage);
    assert.deepEqual(store.pick([], 12, 2000), []);
    const entries = Array.from({ length: 20 }, (_, index) => entry('curated', `curated${index}`));
    store.upsert(entries, 1000);
    const selected = store.pick([], 12, 2000);
    assert.equal(selected.length, 6, 'legacy per-source quota4 plus overfetch2 bounds sparse backfill');
    assert.ok(selected.every(row => row.source_bucket === 'curated'));
    assert.deepEqual(store.pick(entries.map(row => row.external_id), 12, 2000), []);
  } finally { storage.db.close(); }
});

test('freshness and recent-winner decay rank candidates without the zero-weight NULL trap', () => {
  const storage = backend();
  try {
    const store = new PoolStore(storage), now = 2000000000;
    store.upsert([entry('trending', 'older')], now - 1209600000);
    store.upsert([entry('trending', 'fresh'), entry('trending', 'picked')], now);
    store.markPicked('picked', now);
    const legacy = storage.sql.exec(`SELECT external_id FROM video_pool ORDER BY
      -ln(0.5) / (exp(-((? - first_seen_at) / 1209600000.0)) *
      CASE WHEN last_picked_at IS NULL THEN 1.0 ELSE 1.0 - exp(-((? - last_picked_at) / 2592000000.0)) END)
      LIMIT 1`, now, now).toArray();
    assert.equal(legacy[0].external_id, 'picked', 'the legacy zero repeat factor divides to NULL, sorting a just-picked video first');
    assert.equal(store.pick([], 1, now)[0].external_id, 'fresh');
    assert.equal(store.upsert([{ ...entry('curated', 'bad'), embeddable: false }, { ...entry('curated', 'unsafe'), thumbnail_url: 'javascript:alert(1)' }], now), 0);
  } finally { storage.db.close(); }
});

test('legacy pool import preserves all timestamps and retries never rewind later picks', async () => {
  const storage = backend();
  try {
    const store = new PoolStore(storage);
    const rows = ['curated', 'trending'].map(source => ({ ...entry(source, 'oldvideo'), thumbnail_url: null, first_seen_at: 1001, last_seen_at: 2002, last_picked_at: 3003 }));
    assert.deepEqual(await store.importLegacy(rows), { imported: 2, skipped: 0 });
    const imported = storage.sql.exec('SELECT * FROM video_pool').toArray();
    assert.ok(imported.every(row => row.first_seen_at === 1001 && row.last_seen_at === 2002 && row.last_picked_at === 3003));
    assert.ok(imported.every(row => row.thumbnail_url === 'https://i.ytimg.com/vi/oldvideo/hqdefault.jpg'));
    store.markPicked('oldvideo', 4004);
    assert.deepEqual(await new PoolStore(storage).importLegacy(rows), { imported: 0, skipped: 2 });
    assert.ok(storage.sql.exec('SELECT last_picked_at FROM video_pool').toArray().every(row => row.last_picked_at === 4004));
    await assert.rejects(store.importLegacy([{ ...rows[0], last_picked_at: 5005 }]), /migration_pool_conflict/);
  } finally { storage.db.close(); }
});

test('legacy pool import is atomic and cannot overwrite native refresh data', async () => {
  const storage = backend();
  try {
    const store = new PoolStore(storage);
    store.upsert([entry('curated', 'existing')], 1000);
    const rows = ['newvideo', 'existing'].map(id => ({ ...entry('curated', id), first_seen_at: 1, last_seen_at: 2, last_picked_at: null }));
    await assert.rejects(store.importLegacy(rows), /migration_pool_conflict/);
    assert.equal(store.count(), 1);
    await assert.rejects(store.importLegacy([null]), /invalid_legacy_pool/);
    await assert.rejects(store.importLegacy([{ ...rows[0], first_seen_at: -1 }]), /invalid_legacy_pool/);
    assert.equal(store.count(), 1);
  } finally { storage.db.close(); }
});
