// The legacy server's adaptive seek policy, expressed as pure transitions so
// it survives Durable Object hibernation without timers or process-local state.
export const syncLimits = Object.freeze({
  min_tolerance_ms: 300, max_tolerance_ms: 1000, post_seek_tolerance_bump_ms: 300,
  sustained_reports: 2, seek_cooldown_base_ms: 500, seek_cooldown_max_ms: 5000,
  seek_streak_reset_ms: 10000, default_learned_l_ms: 500,
});

export function newSyncState() {
  return { over_tolerance_count: 0, seek_streak: 0, last_seek_at: 0, learned_l_ms: 500 };
}

export function resetSync(state) {
  return { ...newSyncState(), learned_l_ms: state.learned_l_ms };
}

export function toleranceMs(data, room, state, now) {
  const base = Math.min(1000, Math.max(300, 4 * Math.max(data.noise_floor_ms ?? 0, room.room_jitter_ms ?? 0)));
  return state.last_seek_at > 0 && now - state.last_seek_at < 5000 ? Math.min(base + 300, 1000) : base;
}

export function cooldownRemaining(state, now) {
  if (state.last_seek_at === 0 || state.seek_streak === 0) return 0;
  const cooldown = Math.min(500 * 2 ** (state.seek_streak - 1), 5000);
  return Math.min(5000, Math.max(0, cooldown - (now - state.last_seek_at)));
}

export function evaluateSync(previous, data, room, now) {
  const state = { ...previous };
  const sample = data.observed_l_ms ?? 0;
  if (sample >= (room.min_seek_latency_ms ?? 50) && sample <= 5000) {
    state.learned_l_ms = state.learned_l_ms === 500 ? sample : 0.7 * sample + (1 - 0.7) * state.learned_l_ms;
  }
  if (state.seek_streak > 0 && state.last_seek_at > 0 && now - state.last_seek_at > 10000) state.seek_streak = 0;
  const drift = data.drift_ms ?? 0;
  if (Math.abs(drift) < toleranceMs(data, room, state, now)) {
    state.over_tolerance_count = 0;
    return { state, seek: null };
  }
  state.over_tolerance_count++;
  const required = state.last_seek_at > 0 && now - state.last_seek_at < 5000 ? 1 : 2;
  if (state.over_tolerance_count < required || cooldownRemaining(state, now) > 0) return { state, seek: null };
  // Processing time advances the canonical timeline at the room's velocity.
  const overshoot = drift < 0 ? state.learned_l_ms * (room.playback_rate ?? 1) : 0;
  state.over_tolerance_count = 0;
  state.seek_streak++;
  state.last_seek_at = now;
  return { state, seek: { position: Math.max(0, room.expected_position + overshoot / 1000), server_time: now } };
}
