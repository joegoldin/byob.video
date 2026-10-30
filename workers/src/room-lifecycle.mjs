export const idleTimeout = 8 * 60 * 60 * 1000;

export function hasViewers(state) {
  return !!state && Object.entries(state.users).some(([id, user]) => !id.startsWith('api:') && user.connected);
}

export function touchIdle(state, now) {
  return hasViewers(state) ? state : { ...state, empty_deadline: now + idleTimeout, idle_expired_at: null };
}

export function planIdle(state, previous, now) {
  if (hasViewers(state)) return state.empty_deadline != null || state.idle_expired_at != null ? { ...state, empty_deadline: null, idle_expired_at: null } : state;
  return hasViewers(previous) ? touchIdle(state, now) : state;
}

export function expireIdle(state, now) {
  if (state.empty_deadline == null || state.empty_deadline > now) return state;
  if (hasViewers(state)) return { ...state, empty_deadline: null, idle_expired_at: null };
  // The old idle shutdown retained the SQLite snapshot. Retire runtime-only
  // presence here without deleting the API key, queue, history or pending work.
  return { ...state, empty_deadline: null, idle_expired_at: now,
    users: Object.fromEntries(Object.entries(state.users).map(([id, user]) => [id, { ...user, connected: false }])),
    pending_leaves: {}, open_tabs: {}, ready_tabs: {}, drift_samples: {}, media_loaded_for: {},
    last_seek_at: {}, last_user_seek_at_global: 0, event_counts: {},
  };
}

export function reconcileConnections(state, liveIds, now) {
  if (!state) return state;
  let pending = state.pending_leaves;
  for (const [id, user] of Object.entries(state.users)) {
    if (user.connected && !id.startsWith('api:') && !liveIds.has(id) && pending[id] == null) pending = { ...pending, [id]: now + 5000 };
  }
  return pending === state.pending_leaves ? state : { ...state, pending_leaves: pending };
}
