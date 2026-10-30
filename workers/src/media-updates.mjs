import { applyMetadata } from './room-metadata.mjs';
import { externalUrl } from './upstream.mjs';
import { canonicalHost, parseMediaUrl } from './media.mjs';
import { changeMedia } from './playback.mjs';
import { queueLimits } from './queue.mjs';

export function replaceCurrentUrl(state, peer, payload, now) {
  if (peer.role !== 'extension') throw new Error('extension_required');
  if (typeof payload.url !== 'string' || payload.url.length > 8192) throw new Error('invalid_url');
  const parsed = parseMediaUrl(payload.url, [peer.siteHost]);
  const current = state.current_index === null ? null : state.queue[state.current_index];
  if (!current && state.queue.length >= queueLimits.queue) throw new Error('queue_full');
  const item = current ? { ...current, ...parsed, id: current.id } : {
    ...parsed, added_by: peer.userId, added_by_name: state.users[peer.userId]?.username ?? null, added_at: new Date(now).toISOString(),
  };
  Object.assign(item, { title: null, thumbnail_url: null, duration: null, published_at: null });
  const index = current ? state.current_index : state.queue.length;
  const queue = [...state.queue];
  queue[index] = item;
  const history = state.history[0]?.item.id === item.id ? state.history : [{ item, played_at: new Date(now).toISOString() }, ...state.history].slice(0, queueLimits.history);
  const result = changeMedia({ ...state, queue, history, sponsor_segments: [] }, index, now);
  result.events.unshift(['queue_updated', { queue, current_index: index }]);
  if (state.advance_deadline !== null) result.events.unshift(['autoplay_countdown_cancelled', {}]);
  return { ...result, metadata_item: item };
}

const liveHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);

export function updateLive(state, payload) {
  if (typeof payload.is_live !== 'boolean') throw new Error('invalid_live_status');
  const item = state.current_index === null ? null : state.queue[state.current_index];
  if (!item || (payload.item_id != null && payload.item_id !== item.id) || item.is_live === payload.is_live) return { state, events: [] };
  if (payload.is_live && !liveHosts.has(canonicalHost(new URL(item.url).hostname))) return { state, events: [] };
  const update = value => value.id === item.id && value.url === item.url ? { ...value, is_live: payload.is_live } : value;
  const queue = state.queue.map(update), history = state.history.map(entry => ({ ...entry, item: update(entry.item) }));
  return { state: { ...state, queue, history }, events: [
    ['live_status', { is_live: payload.is_live, item_id: item.id }], ['queue_updated', { queue, current_index: state.current_index }],
  ] };
}

export function updateScrapedMedia(state, peer, payload) {
  if (peer.role !== 'extension') throw new Error('extension_required');
  if ((payload.title != null && typeof payload.title !== 'string') || (payload.thumbnail_url != null && typeof payload.thumbnail_url !== 'string')) throw new Error('invalid_media_info');
  const title = payload.title?.slice(0, 500) ?? null;
  let thumbnail_url = null;
  if (payload.thumbnail_url) {
    try { thumbnail_url = externalUrl(payload.thumbnail_url).href; } catch { throw new Error('invalid_media_info'); }
    if (thumbnail_url.length > 4096) throw new Error('invalid_media_info');
  }
  const item = state.current_index === null ? null : state.queue[state.current_index];
  if (item && payload.item_id != null && payload.item_id !== item.id) return { state, events: [] };
  const result = item && (title !== null || thumbnail_url !== null) ? applyMetadata(state, item, { title, thumbnail_url }) : { state, events: [] };
  result.events.push(['extension_media_info', { title, thumbnail_url }]);
  return result;
}
