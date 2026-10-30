import { currentPosition } from './room-sync.mjs';
import { tallies } from './round.mjs';
import { idleTimeout } from './room-lifecycle.mjs';

export const defaultSponsorSettings = Object.freeze({
  sponsor: 'auto_skip', selfpromo: 'show_bar', interaction: 'show_bar', intro: 'show_bar',
  outro: 'show_bar', preview: 'show_bar', music_offtopic: 'disabled', filler: 'show_bar',
});

export function newRoom(roomId, now, apiKey = newApiKey()) {
  if (!/^[a-z0-9]{1,16}$/.test(roomId)) throw new Error('invalid_room');
  return {
    schema_version: 1, room_id: roomId, api_key: apiKey, host_id: null,
    users: {}, queue: [], current_index: null, play_state: 'paused', current_time: 0,
    last_sync_at: now, playback_rate: 1, history: [], sponsor_segments: [],
    sb_settings: { ...defaultSponsorSettings }, last_seek_at: {}, activity_log: [],
    drift_samples: {}, user_sync_states: {}, last_user_seek_at_global: 0,
    media_loaded_for: {}, ready_deadline: null, ready_item_id: null,
    advance_deadline: null, pending_leaves: {}, empty_deadline: now + idleTimeout, idle_expired_at: null,
    open_tabs: {}, ready_tabs: {}, round: null, event_counts: {},
    pending_metadata: [], metadata_deadline: null,
    pending_pool_picks: [], pool_pick_deadline: null,
    last_clock_adjust_at: now, last_heartbeat_at: now, last_correction_at: now,
  };
}

export function newApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function roomSnapshot(state, now) {
  return {
    room_id: state.room_id, users: state.users, queue: state.queue,
    current_index: state.current_index, play_state: state.play_state,
    current_time: currentPosition(state, now), server_time: now,
    playback_rate: state.playback_rate, history: state.history,
    sponsor_segments: state.sponsor_segments, sb_settings: state.sb_settings,
    activity_log: state.activity_log.slice(0, 50), round: roundSnapshot(state.round, now),
  };
}

export function roundSnapshot(round, now) {
  if (!round) return null;
  return {
    id: round.id, mode: round.mode, started_by: round.started_by, started_at: round.started_at,
    expires_at: round.expires_at, server_time: now, candidates: round.candidates,
    tallies: round.mode === 'voting' ? tallies(round) : {},
    voter_ids_by_candidate: round.mode === 'voting' ? round.votes : {},
    phase: round.phase, seed: round.seed, winner_external_id: round.winner_external_id,
  };
}

export function logActivity(state, action, userId, detail, now) {
  const user = state.users[userId]?.username ?? userId ?? null;
  const last = state.activity_log?.[0];
  if (last?.action === action && last.user === user && now - Date.parse(last.at) < 2000) return state;
  const entry = { action, user, detail: detail ?? null, at: new Date(now).toISOString() };
  return { ...state, activity_log: [entry, ...(state.activity_log ?? [])].slice(0, 200) };
}

export function withActivity(result, action, userId, detail, now) {
  const state = logActivity(result.state, action, userId, detail, now);
  const events = [...result.events];
  if (state !== result.state) events.push(['activity_log_entry', state.activity_log[0]]);
  return { ...result, state, events };
}

export function nextDeadline(state) {
  const deadlines = [state.ready_deadline, state.advance_deadline, state.empty_deadline, state.metadata_deadline, state.pool_pick_deadline,
    ...Object.values(state.pending_leaves),
    state.round?.phase === 'active' ? state.round.expires_at : state.round?.finalize_at];
  const active = deadlines.filter(value => typeof value === 'number' && Number.isFinite(value));
  return active.length ? Math.min(...active) : null;
}
