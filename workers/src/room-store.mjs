import { legacyRoomState, migrationHash } from './migration.mjs';

// The room's canonical state is one atomic SQLite row. Playback is represented
// by its anchor and rate, not a constantly rewritten current-position counter.
export class RoomStore {
  constructor(storage) {
    this.storage = storage;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS room_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version INTEGER NOT NULL, state_json TEXT NOT NULL)');
  }

  load() {
    const [row] = this.storage.sql.exec('SELECT schema_version, state_json FROM room_state WHERE singleton = 1').toArray();
    if (!row) return null;
    if (row.schema_version !== 1) throw new Error('unsupported_room_schema');
    const state = JSON.parse(row.state_json);
    if (state.schema_version !== 1) throw new Error('unsupported_room_schema');
    return state;
  }

  async importLegacy(record, now) {
    const state = legacyRoomState(record, now);
    const source = await migrationHash(record);
    return this.storage.transactionSync(() => {
      const existing = this.load();
      if (existing) {
        if (existing.migration_source === source) return { imported: false };
        throw new Error('migration_room_conflict');
      }
      this.save({ ...state, migration_source: source });
      return { imported: true };
    });
  }

  save(state) {
    if (state.schema_version !== 1) throw new Error('unsupported_room_schema');
    // Fresh drift samples are restored from live socket attachments. Decision
    // states remain checkpointed here so learned latency survives disconnects.
    // Callers must not save on every drift report: that would dominate costs.
    const durable = { ...state, drift_samples: {} };
    const json = JSON.stringify(durable);
    if (new TextEncoder().encode(json).length > 1024 * 1024) throw new Error('room_state_too_large');
    this.storage.sql.exec('INSERT INTO room_state (singleton, schema_version, state_json) VALUES (1, 1, ?) ON CONFLICT(singleton) DO UPDATE SET schema_version = excluded.schema_version, state_json = excluded.state_json', json);
  }
}
