import { roomSnapshot } from './room-state.mjs';
import { readyCount } from './peers.mjs';
import { currentPosition } from './room-sync.mjs';

function extensionItem(item) {
  return { id: item.id, url: item.url, source_type: item.source_type, source_id: item.source_id,
    title: item.title ?? null, is_live: item.is_live ?? false };
}

export function channelState(state, peer, now) {
  if (peer.role !== 'extension') return { ...roomSnapshot(state, now), user_id: peer.userId, ready_count: browserReadyCount(readyCount(state), peer) };
  const snapshot = roomSnapshot(state, now);
  const current = state.current_index === null ? null : state.queue[state.current_index];
  return {
    queue: state.queue.map(extensionItem), current_index: state.current_index,
    play_state: state.play_state, current_time: snapshot.current_time, server_time: now,
    playback_rate: state.playback_rate, ready_count: readyCount(state),
    current_url: current?.url ?? null, current_source_type: current?.source_type ?? null,
    current_item_id: current?.id ?? null, is_live: current?.is_live ?? null, queue_size: state.queue.length,
  };
}

function browserReadyCount(count, peer) {
  return count ? { ...count, i_have_popup: count.users_with_open_tabs.includes(peer.userId) } : null;
}

const names = {
  sync_play: 'sync:play', sync_pause: 'sync:pause', sync_correction: 'sync:correction',
  sync_rate: 'sync:rate', state_heartbeat: 'sync:heartbeat', ready_count: 'ready:count',
  room_presence: 'room:presence', queue_updated: 'queue:updated', queue_ended: 'queue:ended',
  video_changed: 'video:change', live_status: 'live:status', users_updated: 'users:updated',
  activity_log_entry: 'activity:entry', activity_log_updated: 'activity:updated', sponsor_segments: 'sponsor:segments', sb_settings: 'sb:settings',
  media_metadata: 'media:metadata', comments_updated: 'comments:updated', round_updated: 'round:updated',
  round_started: 'round:started', round_revealed: 'round:revealed', round_cancelled: 'round:cancelled', round_finalized: 'round:finalized',
  extension_player_state: 'ext:player-state', extension_media_info: 'ext:media-info',
};

export function channelEvent(event, peer, reports = {}) {
  const [kind, data, detail] = event;
  if (kind === 'ready_count' && peer.role !== 'extension') return ['ready:count', browserReadyCount(data, peer)];
  if (kind === 'user_seek_command') return data === peer.userId ? ['sync:seek_command', detail] : null;
  if (kind === 'user_decision_state') {
    if (peer.role === 'extension') return null;
    const report = reports[data] ?? {};
    return ['sync:client_stats', { ...report, ...detail, user_id: data, key: `${data}:${report.source ?? 'browser'}` }];
  }
  if (kind === 'autoplay_countdown') return [peer.role === 'extension' ? 'autoplay:countdown' : 'sync:autoplay_countdown', data];
  if (kind === 'autoplay_countdown_cancelled') return [peer.role === 'extension' ? 'autoplay:cancelled' : 'sync:autoplay_cancelled', {}];
  if (peer.role === 'extension') {
    if (kind.startsWith('round_')) return null;
    if (['users_updated', 'activity_log_entry', 'activity_log_updated', 'comments_updated', 'round_updated', 'state_heartbeat', 'extension_player_state', 'extension_media_info'].includes(kind)) return null;
    if (kind === 'queue_updated') return ['queue:updated', { ...data, queue: data.queue.map(extensionItem) }];
    if (kind === 'video_changed') return ['video:change', { ...data, media_item: extensionItem(data.media_item) }];
  }
  return names[kind] ? [names[kind], data] : null;
}

export function driftReport(payload, peer, state, now = Date.now()) {
  const report = {
    user_id: peer.userId, username: state.users[peer.userId]?.username ?? null,
    source: peer.role === 'extension' ? 'extension' : 'browser',
    play_state: typeof payload.play_state === 'string' ? payload.play_state.slice(0, 16) : state.play_state,
    gesture_blocked: payload.gesture_blocked === true, hidden: payload.hidden === true,
  };
  for (const field of ['drift_ms', 'raw_drift_ms', 'noise_floor_ms', 'rtt_ms', 'observed_l_ms', 'offset_ms', 'server_position']) {
    const value = payload[field] ?? 0;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid_stats');
    report[field] = value;
  }
  for (const field of ['rtt_ms', 'noise_floor_ms', 'observed_l_ms']) report[field] = Math.trunc(report[field]);
  if (peer.role !== 'extension') {
    report.drift_ms = Math.trunc(report.drift_ms);
    report.offset_ms = Math.trunc(report.offset_ms);
    report.raw_drift_ms = report.drift_ms + report.offset_ms;
  }
  if (typeof payload.playing === 'boolean') report.play_state = payload.playing ? 'playing' : 'paused';
  report.server_position = Math.round(currentPosition(state, now) * 10) / 10;
  return report;
}
