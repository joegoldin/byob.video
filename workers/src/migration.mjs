import { newRoom } from './room-state.mjs';

export async function migrationHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function invalid() { throw new Error('invalid_legacy_room'); }
function media(item) {
  if (!item || typeof item.id !== 'string' || !item.id || typeof item.url !== 'string' ||
      !['youtube', 'vimeo', 'twitch', 'direct_url', 'extension_required'].includes(item.source_type)) invalid();
  let url;
  try { url = new URL(item.url); } catch { invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid();
  if (item.duration != null && (!Number.isFinite(item.duration) || item.duration < 0)) invalid();
  return { ...item };
}

export function legacyRoomState(record, now) {
  const old = record?.state;
  if (record?.schema_version !== 1 || !old || old.room_id !== record.room_id ||
      typeof old.api_key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(old.api_key) ||
      !Array.isArray(old.queue) || old.queue.length > 200 || !Array.isArray(old.history) || old.history.length > 99 ||
      !['playing', 'paused', 'ended'].includes(old.play_state) || !Number.isFinite(old.current_time) || old.current_time < 0 ||
      !Number.isFinite(old.playback_rate ?? 1) || (old.playback_rate ?? 1) < 0.25 || (old.playback_rate ?? 1) > 2) invalid();
  if (old.current_index != null && (!Number.isInteger(old.current_index) || old.current_index < 0 || old.current_index >= old.queue.length)) invalid();
  const state = newRoom(record.room_id, now, old.api_key);
  const savedAt = old.persisted_wallclock ?? record.updated_at;
  if (!Number.isSafeInteger(savedAt) || savedAt < 0 || !Number.isSafeInteger(savedAt * 1000)) invalid();
  const history = old.history.map(entry => {
    if (!entry || typeof entry.played_at !== 'string' || !Number.isFinite(Date.parse(entry.played_at))) invalid();
    return { ...entry, item: media(entry.item) };
  });
  const settings = old.sb_settings ?? {};
  for (const [category, action] of Object.entries(settings)) {
    if (!Object.hasOwn(state.sb_settings, category) || !['auto_skip', 'show_bar', 'disabled'].includes(action)) invalid();
  }
  const activity = old.activity_log ?? [];
  if (!Array.isArray(activity) || activity.length > 200 || activity.some(entry => !entry || typeof entry.action !== 'string' || !Number.isFinite(Date.parse(entry.at)))) invalid();
  return {
    ...state, host_id: old.host_id ?? null, queue: old.queue.map(media), history,
    current_index: old.current_index ?? null, current_time: old.current_time,
    play_state: old.play_state, playback_rate: old.playback_rate ?? 1,
    last_sync_at: Math.min(now, savedAt * 1000), sb_settings: { ...state.sb_settings, ...settings },
    activity_log: activity,
    // Imported rooms are dormant until accessed. Old VM timers and transports
    // must not become native alarms, phantom viewers or periodic idle writes.
    empty_deadline: null, idle_expired_at: now,
  };
}
