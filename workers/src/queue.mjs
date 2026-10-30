import { changeMedia } from './playback.mjs';
import { currentPosition } from './room-sync.mjs';

export const queueLimits = Object.freeze({ queue: 200, history: 99 });

function queueEvent(state) {
  return ['queue_updated', { queue: state.queue, current_index: state.current_index }];
}

function startFirst(state, now) {
  const item = state.queue[0];
  const history = state.history[0]?.item.id === item.id ? state.history
    : [{ item, played_at: new Date(now).toISOString() }, ...state.history].slice(0, queueLimits.history);
  const result = changeMedia({ ...state, history, sponsor_segments: [] }, 0, now);
  if (state.advance_deadline !== null) result.events.unshift(['autoplay_countdown_cancelled', {}]);
  result.events.push(queueEvent(result.state));
  return result;
}

export function enqueue(state, items, mode, now) {
  if (!['queue', 'now'].includes(mode)) throw new Error('invalid_mode');
  if (!items.length) return { state, events: [] };
  if (mode === 'now') {
    const remaining = state.queue.filter((_, index) => index !== state.current_index);
    const incoming = items.slice(0, Math.max(0, queueLimits.queue - remaining.length));
    if (!incoming.length) return { state, events: [] };
    return startFirst({ ...state, queue: [...incoming, ...remaining] }, now);
  }
  const incoming = items.slice(0, Math.max(0, queueLimits.queue - state.queue.length));
  if (!incoming.length) return { state, events: [] };
  const next = { ...state, queue: [...state.queue, ...incoming] };
  if (next.current_index === null) return startFirst(next, now);
  return { state: next, events: [queueEvent(next)] };
}

export function playIndex(state, index, now) {
  if (!Number.isInteger(index) || index < 0 || index >= state.queue.length) throw new Error('invalid_index');
  const item = state.queue[index];
  const remaining = state.queue.filter((_, i) => i !== index && i !== state.current_index);
  return startFirst({ ...state, queue: [item, ...remaining] }, now);
}

export function removeItem(state, id) {
  const index = state.queue.findIndex(item => item.id === id);
  if (index < 0) return { state, events: [] };
  let current_index = state.current_index;
  if (current_index !== null) {
    if (index === current_index) current_index = null;
    else if (index < current_index) current_index--;
  }
  const next = { ...state, queue: state.queue.filter(item => item.id !== id), current_index };
  // A removed item must not later resume via its old ready-check deadline.
  if (current_index === null) {
    next.ready_deadline = null;
    next.ready_item_id = null;
  }
  return { state: next, events: [queueEvent(next)] };
}

export function reorderQueue(state, from, to) {
  if (![from, to].every(i => Number.isInteger(i) && i >= 0 && i < state.queue.length) || from === to) return { state, events: [] };
  const current = state.current_index === null ? null : state.queue[state.current_index].id;
  const queue = [...state.queue];
  queue.splice(to, 0, queue.splice(from, 1)[0]);
  const next = { ...state, queue, current_index: current === null ? null : queue.findIndex(item => item.id === current) };
  return { state: next, events: [queueEvent(next)] };
}

export function videoEnded(state, reference, now) {
  const item = state.current_index === null ? null : state.queue[state.current_index];
  const matches = typeof reference === 'string' ? reference === item?.id : Number.isInteger(reference) && reference === state.current_index;
  if (!item || !matches || state.advance_deadline !== null) return { state, events: [], status: 'stale' };
  return {
    state: { ...state, advance_deadline: now + 5000, play_state: 'paused', current_time: currentPosition(state, now), last_sync_at: now },
    events: [['autoplay_countdown', { duration_ms: 5000, server_time: now, has_next: state.current_index + 1 < state.queue.length }]],
    status: 'ok',
  };
}

export function advanceQueue(state, now) {
  const queue = state.queue.filter((_, i) => i !== state.current_index);
  const next = { ...state, queue, advance_deadline: null };
  if (queue.length) return startFirst(next, now);
  const ended = { ...next, current_index: null, current_time: 0, last_sync_at: now, play_state: 'ended', ready_deadline: null, ready_item_id: null };
  return { state: ended, events: [['queue_ended', {}], queueEvent(ended)] };
}

export function expireAdvance(state, now) {
  if (state.advance_deadline === null || state.advance_deadline > now) return { state, events: [] };
  return advanceQueue(state, now);
}
