export function enqueuePick(state, externalId, now) {
  const pending = state.pending_pool_picks ?? [];
  return { ...state, pending_pool_picks: [...pending.filter(pick => pick.external_id !== externalId), { external_id: externalId, at: now }], pool_pick_deadline: now };
}

async function mark(pool, pick) {
  let timer;
  try {
    await Promise.race([
      pool.markPicked(pick.external_id, pick.at),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('pool_timeout')), 8000); }),
    ]);
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export class PoolPicks {
  constructor(owner) { this.owner = owner; this.busy = false; }
  async flush() {
    if (this.busy || this.owner.room.pool_pick_deadline == null || this.owner.room.pool_pick_deadline > Date.now()) return;
    this.busy = true;
    try {
      const picks = this.owner.room.pending_pool_picks.slice(0, 3);
      await this.owner.persist({ ...this.owner.room, pool_pick_deadline: Date.now() + 20000 });
      const pool = this.owner.env.POOL.getByName('global');
      const successes = await Promise.all(picks.map(pick => mark(pool, pick)));
      const state = this.owner.room;
      const pending = state.pending_pool_picks.filter(entry => !picks.some((pick, index) => successes[index] && pick.external_id === entry.external_id && pick.at === entry.at));
      await this.owner.persist({ ...state, pending_pool_picks: pending, pool_pick_deadline: pending.length ? Date.now() + (successes.every(Boolean) ? 1 : 60000) : null });
    } finally { this.busy = false; }
  }
}
