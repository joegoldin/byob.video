import { fetchMetadata } from './metadata.mjs';
import { fetchSponsor, applySponsor } from './sponsor.mjs';
import { fetchComments, commentsEvent } from './comments.mjs';

export function applyMetadata(state, job, meta) {
  if (!meta) return { state, events: [] };
  const update = item => {
    if (item.id !== job.id || item.url !== job.url) return item;
    const next = { ...item };
    for (const key of ['title', 'thumbnail_url', 'duration', 'published_at']) if (meta[key] != null) next[key] = meta[key];
    return next;
  };
  const queue = state.queue.map(update);
  const history = state.history.map(entry => ({ ...entry, item: update(entry.item) }));
  const activity_log = state.activity_log.map(entry => meta.title && ['added', 'played'].includes(entry.action) && entry.detail === job.url ? { ...entry, detail: meta.title } : entry);
  const next = { ...state, queue, history, activity_log };
  const events = [['queue_updated', { queue, current_index: state.current_index }]];
  if (meta.title) events.push(['activity_log_updated', activity_log]);
  return { state: next, events };
}

export class RoomMetadata {
  constructor(owner) {
    this.owner = owner;
    this.busy = false;
  }

  enqueueCurrent(state, previous, now) {
    const current = state.current_index === null ? null : state.queue[state.current_index];
    const old = previous?.current_index == null ? null : previous.queue[previous.current_index];
    const reloading = state.ready_deadline != null && state.ready_deadline !== previous?.ready_deadline;
    if (current?.id === old?.id && current?.url === old?.url && !reloading) return state;
    let next = { ...state, sponsor_segments: [] };
    if (current?.source_type !== 'youtube') return next;
    next = this.enqueue(next, current, now, 'sponsor');
    next = this.enqueue(next, current, now, 'comments');
    const forCurrent = job => job.id === current.id && job.url === current.url;
    return { ...next, pending_metadata: [...next.pending_metadata.filter(forCurrent), ...next.pending_metadata.filter(job => !forCurrent(job))] };
  }

  enqueue(state, item, now, kind = 'metadata') {
    if (!item || item.source_type === 'direct_url' || !state.queue.some(value => value.id === item.id && value.url === item.url)) return state;
    const pending = state.pending_metadata ?? [];
    if (pending.some(job => job.id === item.id && job.url === item.url && (job.kind ?? 'metadata') === kind)) return state;
    const relevant = [...state.queue, ...state.history.map(entry => entry.item)];
    const jobs = pending.filter(job => relevant.some(value => value.id === job.id && value.url === job.url));
    const job = { id: item.id, url: item.url, source_type: item.source_type, source_id: item.source_id, kind, attempt: 0 };
    if (kind !== 'metadata') jobs.unshift(job);
    else jobs.push(job);
    return { ...state, pending_metadata: jobs, metadata_deadline: state.metadata_deadline ?? now };
  }

  prepare(state, now) {
    if (this.busy || state.metadata_deadline == null || state.metadata_deadline > now) return { state, jobs: [] };
    const pending = (state.pending_metadata ?? []).filter(job => job.attempt < 3);
    const jobs = pending.slice(0, 3).map(job => ({ ...job, attempt: job.attempt + 1 }));
    return {
      state: { ...state, pending_metadata: [...jobs, ...pending.slice(3)], metadata_deadline: jobs.length ? now + 20000 : null },
      jobs,
    };
  }

  async finish(jobs) {
    this.busy = true;
    try {
      const results = await Promise.all(jobs.map(async job => {
        try {
          let meta;
          if (job.kind === 'sponsor') meta = await fetchSponsor(job.source_id);
          else if (job.kind === 'comments') meta = await fetchComments(job.source_id, null, this.owner.env);
          else meta = await fetchMetadata(job, this.owner.env);
          return { job, meta };
        } catch { return { job, meta: null }; }
      }));
      let state = this.owner.room;
      const events = [];
      for (const { job, meta } of results) {
        const pending = state.pending_metadata ?? [];
        const matches = entry => entry.id === job.id && entry.url === job.url && entry.attempt === job.attempt && (entry.kind ?? 'metadata') === (job.kind ?? 'metadata');
        if (!pending.some(matches)) continue;
        let updated;
        if (job.kind === 'sponsor') updated = applySponsor(state, meta);
        else if (job.kind === 'comments') updated = commentsEvent(state, meta);
        else updated = applyMetadata(state, job, meta);
        state = { ...updated.state, pending_metadata: pending.filter(entry => !matches(entry)) };
        events.push(...updated.events);
      }
      state = { ...state, metadata_deadline: state.pending_metadata.length ? Date.now() : null };
      await this.owner.persist(state);
      this.owner.sockets.broadcast(events, events.length > 0);
    } finally { this.busy = false; }
  }
}
