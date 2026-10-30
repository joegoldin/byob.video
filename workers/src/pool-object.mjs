import { DurableObject } from 'cloudflare:workers';
import { PoolStore } from './pool-store.mjs';
import { fetchPoolPage, validateCandidates, subreddits, curatedPlaylists } from './pool-sources.mjs';

export class VideoPool extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new PoolStore(ctx.storage);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS pool_refresh (id INTEGER PRIMARY KEY CHECK(id = 1), state_json TEXT NOT NULL)');
    const row = ctx.storage.sql.exec('SELECT state_json FROM pool_refresh WHERE id = 1').toArray()[0];
    this.refresh = row ? JSON.parse(row.state_json) : { hourly_at: 0, daily_at: 0, jobs: [], lease_until: null };
    this.work = null;
  }

  importLegacy(entries) { return this.store.importLegacy(entries); }

  async saveRefresh() {
    this.ctx.storage.sql.exec('INSERT INTO pool_refresh(id, state_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json', JSON.stringify(this.refresh));
    if (this.refresh.jobs.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, this.refresh.lease_until ?? Date.now()));
    else await this.ctx.storage.deleteAlarm();
  }

  async scheduleRefresh(now) {
    const jobs = [];
    if (now >= this.refresh.hourly_at) {
      jobs.push({ kind: 'trending' }, ...subreddits.map(detail => ({ kind: 'subreddit', detail })));
      this.refresh.hourly_at = now + 3600000;
    }
    if (now >= this.refresh.daily_at) {
      jobs.push(...curatedPlaylists.map(detail => ({ kind: 'curated', detail })));
      this.refresh.daily_at = now + 86400000;
    }
    for (const job of jobs) if (!this.refresh.jobs.some(existing => existing.kind === job.kind && existing.detail === job.detail)) this.refresh.jobs.push({ ...job, id: crypto.randomUUID(), seen: [] });
    if (jobs.length) await this.saveRefresh();
  }

  runBatch() {
    if (this.work) return this.work;
    if (!this.refresh.jobs.length) return Promise.resolve();
    this.work = (async () => {
      const jobs = this.refresh.jobs.slice(0, 3);
      this.refresh.lease_until = Date.now() + 20000;
      await this.saveRefresh();
      const results = await Promise.all(jobs.map(async job => {
        try { return { job, result: await fetchPoolPage(job, this.env) }; }
        catch { return { job, result: { entries: [] } }; }
      }));
      const completed = new Set(jobs.map(job => job.id));
      const next = [];
      for (const { job, result } of results) {
        this.store.upsert(result.entries, Date.now());
        if (result.next_page_token && job.seen.length < 1000) {
          const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.next_page_token));
          const tokenHash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
          if (!job.seen.includes(tokenHash)) next.push({ ...job, id: crypto.randomUUID(), token: result.next_page_token, seen: [...job.seen, tokenHash] });
        }
      }
      this.refresh = { ...this.refresh, jobs: [...this.refresh.jobs.filter(job => !completed.has(job.id)), ...next], lease_until: null };
      await this.saveRefresh();
    })().finally(() => { this.work = null; });
    return this.work;
  }

  async pick(excluded, target) {
    await this.scheduleRefresh(Date.now());
    if (!this.store.count()) await this.runBatch();
    else this.ctx.waitUntil(this.runBatch());
    const rows = await validateCandidates(this.store.pick(excluded, target, Date.now()), this.env);
    return rows.map(row => ({ external_id: row.external_id, title: row.title, channel: row.channel,
      duration_s: row.duration_s, thumbnail_url: row.thumbnail_url, source_type: row.source_bucket }));
  }

  markPicked(externalId, at) { this.store.markPicked(externalId, at); }
  async alarm() { await this.runBatch(); }
}
