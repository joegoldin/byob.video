import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RoomCapacity } from '../src/room-capacity.mjs';

function backend() {
  const db = new DatabaseSync(':memory:');
  return { db, sql: { exec(sql, ...params) { const rows = db.prepare(sql).all(...params); return { toArray: () => rows }; } }, transactionSync(fn) {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}

test('global capacity admits exactly100 rooms and survives store reconstruction', () => {
  const storage = backend();
  try {
    const capacity = new RoomCapacity(storage);
    const tokens = Array.from({ length: 100 }, (_, i) => capacity.acquire(`room${i}`, 1000));
    assert.ok(tokens.every(result => result?.token));
    assert.equal(capacity.acquire('overflow', 1000), null);
    const restored = new RoomCapacity(storage);
    assert.equal(restored.acquire('overflow', 2000), null);
    assert.equal(restored.acquire('room0', 2000).token, tokens[0].token);
    assert.equal(restored.acquire('overflow', 1000 + 48 * 3600000), null, 'time alone cannot evict occupied rooms');
    restored.release('room0');
    assert.ok(restored.acquire('replacement', 3000));
    assert.equal(restored.acquire('overflow', 3000), null);
  } finally { storage.db.close(); }
});

test('creation reservations expire, confirmed rooms do not, and stale cleanup cannot free a new admission', () => {
  const storage = backend();
  try {
    const capacity = new RoomCapacity(storage);
    const reserved = capacity.acquire('pending', 1000, true);
    assert.deepEqual(capacity.acquire('pending', 2000, true), { collision: true });
    const admitted = capacity.acquire('pending', 2000);
    assert.equal(admitted.token, reserved.token);
    assert.equal(capacity.acquire('pending', 100000).token, reserved.token);
    capacity.release('pending', 'incorrect-token');
    assert.equal(capacity.acquire('pending', 100001).token, reserved.token);
    capacity.release('pending', reserved.token);
    const next = capacity.acquire('pending', 100002);
    capacity.release('pending', reserved.token);
    assert.equal(capacity.acquire('pending', 100003).token, next.token);
    const abandoned = capacity.acquire('abandoned', 1000, true);
    assert.equal(capacity.acquire('abandoned', 60999, true).collision, true);
    assert.notEqual(capacity.acquire('abandoned', 61000, true).token, abandoned.token);
  } finally { storage.db.close(); }
});
