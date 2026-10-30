import { newSyncState } from './sync-decision.mjs';
import { resetRoomSync } from './room-sync.mjs';

function validPosition(position) {
  if (typeof position !== 'number' || !Number.isFinite(position) || position < 0) throw new Error('invalid_position');
}

export function changeMedia(previous, index, now) {
  const item = previous.queue[index];
  if (!item) throw new Error('invalid_index');
  const state = {
    ...resetRoomSync(previous), current_index: index, current_time: 0, last_sync_at: now,
    play_state: 'paused', playback_rate: 1, media_loaded_for: {},
    ready_item_id: item.id, ready_deadline: now + 2500, advance_deadline: null,
  };
  return { state, events: [['video_changed', { media_item: item, index, play_state: 'paused' }]] };
}

function finishReady(state, now) {
  return {
    state: { ...state, ready_deadline: null, ready_item_id: null, play_state: 'playing', current_time: 0, last_sync_at: now },
    events: [['sync_play', { time: 0, server_time: now, user_id: null }]],
  };
}

function checkReady(state, now) {
  if (state.ready_deadline === null) return { state, events: [] };
  // REST actors remain in presence/history but have no player to acknowledge a load.
  const visible = Object.entries(state.users).filter(([id, user]) => !id.startsWith('api:') && user.connected && !user.hidden);
  if (visible.length && visible.every(([id]) => state.media_loaded_for[id] === state.ready_item_id)) return finishReady(state, now);
  return { state, events: [] };
}

export function mediaLoaded(state, userId, itemId, now) {
  const current = state.current_index === null ? null : state.queue[state.current_index];
  if (!current || current.id !== itemId) return { state, events: [] };
  return checkReady({ ...state, media_loaded_for: { ...state.media_loaded_for, [userId]: itemId } }, now);
}

export function expireReady(state, itemId, now) {
  if (state.ready_deadline === null || now < state.ready_deadline || state.ready_item_id !== itemId) return { state, events: [] };
  return finishReady(state, now);
}

export function setVisibility(state, userId, hidden, now) {
  const user = state.users[userId];
  if (!user) return { state, events: [] };
  const updated = { ...state, users: { ...state.users, [userId]: { ...user, hidden: !!hidden } } };
  return hidden && !user.hidden ? checkReady(updated, now) : { state: updated, events: [] };
}

export function transitionPlayback(state, action, userId, position, now) {
  validPosition(position);
  if (!['play', 'pause'].includes(action)) throw new Error('invalid_action');
  const windowAt = state.control_window_at ?? now;
  const reset = now - windowAt >= 5000;
  const counts = reset ? {} : state.event_counts ?? {};
  if ((counts[userId] ?? 0) >= 20) throw new Error('rate_limited');
  state = { ...state, control_window_at: reset ? now : windowAt, event_counts: { ...counts, [userId]: (counts[userId] ?? 0) + 1 } };
  const play_state = action === 'play' ? 'playing' : 'paused';
  // Explicit controls supersede the earlier load quorum and its fallback alarm.
  state = { ...state, ready_deadline: null, ready_item_id: null };
  let next = state;
  if (state.play_state !== play_state) next = { ...state, play_state, current_time: position, last_sync_at: now };
  if (action === 'play') next = { ...next, advance_deadline: null };
  return { state: next, events: [[action === 'play' ? 'sync_play' : 'sync_pause', { time: position, server_time: now, user_id: userId }]] };
}

export function seekPlayback(state, userId, position, now) {
  validPosition(position);
  const item = state.current_index === null ? null : state.queue[state.current_index];
  if (item?.is_live) return { state, events: [] };
  const last = state.last_seek_at[userId];
  if (last !== undefined && now - last < 500) throw new Error('debounced');
  const next = resetRoomSync({
    ...state, current_time: position, last_sync_at: now,
    ready_deadline: null, ready_item_id: null,
    last_seek_at: { ...state.last_seek_at, [userId]: now }, last_user_seek_at_global: now,
  });
  const events = [];
  for (const [id, user] of Object.entries(next.users)) {
    if (id === userId || !user.connected) continue;
    const decision = next.user_sync_states[id] ?? newSyncState();
    const latency = state.play_state === 'paused' ? 0 : decision.learned_l_ms > 0 ? decision.learned_l_ms : 500;
    events.push(['user_seek_command', id, { position: Math.max(0, position + latency / 1000), server_time: now }]);
    next.user_sync_states[id] = { ...decision, last_seek_at: now, seek_streak: Math.max(1, decision.seek_streak), over_tolerance_count: 0 };
  }
  return { state: next, events };
}
