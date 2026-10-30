import { newSyncState, evaluateSync, toleranceMs, cooldownRemaining, resetSync } from './sync-decision.mjs';

export function currentPosition(state, now) {
  const elapsed = state.play_state === 'playing' ? Math.max(0, now - state.last_sync_at) / 1000 : 0;
  const position = Math.max(0, state.current_time + elapsed * (state.playback_rate ?? 1));
  const duration = state.current_index === null ? null : state.queue[state.current_index]?.duration;
  return typeof duration === 'number' && duration > 0 ? Math.min(position, duration) : position;
}

export function resetRoomSync(state) {
  return { ...state, drift_samples: {}, user_sync_states: Object.fromEntries(
    Object.entries(state.user_sync_states).map(([id, decision]) => [id, resetSync(decision)]),
  ) };
}

export function recordDrift(state, userId, data, now) {
  const samples = { ...state.drift_samples, [userId]: { drift_ms: data.drift_ms ?? 0, updated_at: now } };
  const room = {
    expected_position: currentPosition(state, now),
    playback_rate: state.play_state === 'playing' ? (state.playback_rate ?? 1) : 0,
    min_seek_latency_ms: state.queue[state.current_index]?.source_type === 'direct_url' ? 1 : 50,
    room_jitter_ms: Math.max(0, ...Object.values(samples).filter(s => now - s.updated_at < 5000).map(s => s.noise_floor_ms ?? 0)),
  };
  const previous = state.user_sync_states[userId] ?? newSyncState();
  const computed = evaluateSync(previous, data, room, now);
  const hidden = state.users[userId]?.hidden ?? false;
  const decision = hidden ? previous : computed.state;
  const events = [];
  if (!hidden && computed.seek) events.push(['user_seek_command', userId, computed.seek]);
  events.push(['user_decision_state', userId, {
    tolerance_ms: Math.trunc(toleranceMs(data, room, computed.state, now)),
    seek_streak: decision.seek_streak,
    cooldown_remaining_ms: cooldownRemaining(computed.state, now),
    learned_l_ms: Math.trunc(decision.learned_l_ms ?? 0),
  }]);
  return { state: { ...state, drift_samples: samples, user_sync_states: { ...state.user_sync_states, [userId]: decision } }, events };
}

export function clockAdjustTarget(drifts) {
  if (!drifts.length) return 0;
  if (drifts.every(d => d < 0)) return Math.max(...drifts);
  if (drifts.every(d => d > 0)) return Math.min(...drifts);
  return 0;
}

export function adjustRoomClock(state, now) {
  const drifts = Object.entries(state.drift_samples)
    .filter(([id, sample]) => now - sample.updated_at < 5000 && !state.users[id]?.hidden)
    .map(([, sample]) => sample.drift_ms);
  if (drifts.length < 2 || state.play_state !== 'playing' ||
      (state.last_user_seek_at_global > 0 && now - state.last_user_seek_at_global < 5000)) return { state, events: [] };
  const target = clockAdjustTarget(drifts);
  if (Math.abs(target) <= 15) return { state, events: [] };
  const position = Math.max(0, currentPosition(state, now) + Math.max(-1000, Math.min(1000, Math.trunc(target))) / 1000);
  const live = state.current_index !== null && state.queue[state.current_index]?.is_live;
  return {
    state: { ...state, current_time: position, last_sync_at: now },
    events: live ? [] : [['sync_correction', { expected_time: position, server_time: now }]],
  };
}

export function setPlaybackRate(state, rate, now) {
  if (typeof rate === 'string') rate = Number.parseFloat(rate);
  if (typeof rate !== 'number' || !Number.isFinite(rate)) throw new Error('invalid_rate');
  const normalized = Math.max(0.25, Math.min(2, rate));
  if (Math.abs((state.playback_rate ?? 1) - normalized) < 0.001) return state;
  // Capture the old rate's elapsed position before changing the clock slope;
  // otherwise a rate change rewinds to the last play/seek timestamp.
  return { ...state, current_time: currentPosition(state, now), last_sync_at: now, playback_rate: normalized };
}
