import { externalUrl } from './upstream.mjs';
import { migrationHash } from './migration.mjs';

export const poolSources = Object.freeze(['trending', 'subreddit', 'curated']);
function valid(entry) {
  if (!poolSources.includes(entry.source_type) || typeof entry.external_id !== 'string' || !/^[\w-]{1,128}$/.test(entry.external_id) ||
      typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 500 ||
      typeof entry.thumbnail_url !== 'string' || entry.thumbnail_url.length > 4096 || entry.embeddable === false) return false;
  try { externalUrl(entry.thumbnail_url); return true; } catch { return false; }
}

export class PoolStore {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS video_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, source_detail TEXT,
      external_id TEXT NOT NULL, title TEXT NOT NULL, channel TEXT, duration_s REAL,
      thumbnail_url TEXT NOT NULL, score REAL, first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, last_picked_at INTEGER, UNIQUE(source_type, external_id))`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_pool_source_seen ON video_pool(source_type, last_seen_at DESC)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_pool_external ON video_pool(external_id)');
  }

  count() { return this.sql.exec('SELECT count(*) AS count FROM video_pool').toArray()[0].count; }

  upsert(entries, now) {
    if (!Array.isArray(entries) || entries.length > 500) throw new Error('invalid_pool_batch');
    const accepted = entries.filter(valid);
    this.storage.transactionSync(() => {
      for (const entry of accepted) this.sql.exec(`INSERT INTO video_pool
        (source_type, source_detail, external_id, title, channel, duration_s, thumbnail_url, score, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, external_id) DO UPDATE SET
          source_detail = excluded.source_detail, title = excluded.title, channel = excluded.channel,
          duration_s = excluded.duration_s, thumbnail_url = excluded.thumbnail_url,
          score = excluded.score, last_seen_at = excluded.last_seen_at`,
      entry.source_type, typeof entry.source_detail === 'string' ? entry.source_detail.slice(0, 300) : null,
      entry.external_id, entry.title, typeof entry.channel === 'string' ? entry.channel.slice(0, 500) : null,
      Number.isFinite(entry.duration_s) && entry.duration_s >= 0 ? entry.duration_s : null,
      entry.thumbnail_url, Number.isFinite(entry.score) ? entry.score : null, now, now);
    });
    return accepted.length;
  }

  async importLegacy(entries) {
    if (!Array.isArray(entries) || entries.length > 500) throw new Error('invalid_legacy_pool');
    const rows = await Promise.all(entries.map(async entry => {
      if (!entry || typeof entry !== 'object') throw new Error('invalid_legacy_pool');
      const row = { ...entry, thumbnail_url: entry.thumbnail_url ?? `https://i.ytimg.com/vi/${encodeURIComponent(entry.external_id)}/hqdefault.jpg` };
      if (!valid(row) || !['first_seen_at', 'last_seen_at'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0) ||
          (row.last_picked_at != null && (!Number.isSafeInteger(row.last_picked_at) || row.last_picked_at < 0)) ||
          ['source_detail', 'channel'].some(key => row[key] != null && typeof row[key] !== 'string') ||
          (row.duration_s != null && (!Number.isFinite(row.duration_s) || row.duration_s < 0)) ||
          (row.score != null && !Number.isFinite(row.score))) throw new Error('invalid_legacy_pool');
      return { row, source: await migrationHash(entry) };
    }));
    return this.storage.transactionSync(() => {
      this.sql.exec('CREATE TABLE IF NOT EXISTS pool_migration (source_type TEXT NOT NULL, external_id TEXT NOT NULL, source_hash TEXT NOT NULL, PRIMARY KEY(source_type, external_id))');
      let imported = 0;
      for (const { row, source } of rows) {
        const [receipt] = this.sql.exec('SELECT source_hash FROM pool_migration WHERE source_type = ? AND external_id = ?', row.source_type, row.external_id).toArray();
        if (receipt) {
          if (receipt.source_hash !== source) throw new Error('migration_pool_conflict');
          continue;
        }
        if (this.sql.exec('SELECT 1 FROM video_pool WHERE source_type = ? AND external_id = ?', row.source_type, row.external_id).toArray().length) throw new Error('migration_pool_conflict');
        this.sql.exec(`INSERT INTO video_pool (source_type, source_detail, external_id, title, channel, duration_s, thumbnail_url, score, first_seen_at, last_seen_at, last_picked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.source_type, row.source_detail ?? null, row.external_id, row.title, row.channel ?? null,
        row.duration_s ?? null, row.thumbnail_url, row.score ?? null, row.first_seen_at, row.last_seen_at, row.last_picked_at ?? null);
        this.sql.exec('INSERT INTO pool_migration VALUES (?, ?, ?)', row.source_type, row.external_id, source);
        imported++;
      }
      return { imported, skipped: rows.length - imported };
    });
  }

  markPicked(externalId, at) {
    if (typeof externalId !== 'string' || !Number.isSafeInteger(at) || at < 0) throw new Error('invalid_pool_pick');
    this.sql.exec('UPDATE video_pool SET last_picked_at = ? WHERE external_id = ? AND (last_picked_at IS NULL OR last_picked_at < ?)', at, externalId, at);
  }

  pick(excluded, target, now) {
    if (!Array.isArray(excluded) || excluded.length > 200 || excluded.some(id => typeof id !== 'string') || !Number.isInteger(target) || target < 1 || target > 36) throw new Error('invalid_pool_pick');
    const perSource = Math.ceil(target / poolSources.length);
    const rows = Object.fromEntries(poolSources.map(source => {
      // Keep the legacy exponential-race weighting; clamp zero repeat weight so
      // a just-picked video cannot sort first as SQLite's NULL division result.
      const found = this.sql.exec(`SELECT * FROM video_pool
        WHERE source_type = ? AND external_id NOT IN (SELECT value FROM json_each(?))
        ORDER BY -ln(abs(random()) / 9223372036854775807.0 + 1e-10) /
          max(1e-15, (CASE WHEN source_type = 'curated' THEN 1.0 ELSE exp(-max(0, ? - first_seen_at) / 1209600000.0) END) *
          (CASE WHEN last_picked_at IS NULL THEN 1.0 ELSE 1.0 - exp(-max(0, ? - last_picked_at) / 2592000000.0) END))
        LIMIT ?`, source, JSON.stringify(excluded), now, now, perSource + 2).toArray();
      return [source, found.map(row => ({ ...row, source_bucket: source }))];
    }));
    const selected = [], seen = new Set();
    const append = candidates => {
      for (const candidate of candidates) if (!seen.has(candidate.external_id)) {
        seen.add(candidate.external_id);
        selected.push(candidate);
      }
    };
    for (const source of poolSources) append(rows[source].slice(0, perSource));
    if (selected.length < target) {
      append(poolSources.flatMap(source => rows[source].slice(perSource)));
      if (selected.length < target) append(poolSources.flatMap(source => rows[source]));
    }
    return selected.slice(0, target);
  }
}
