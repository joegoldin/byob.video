import { youtubeData } from './youtube.mjs';
import { fetchMetadata } from './metadata.mjs';
import { parseMediaUrl, extractUrl, youtubePlaylist } from './media.mjs';
import { externalUrl } from './upstream.mjs';
import { enqueue } from './queue.mjs';
import { logActivity } from './room-state.mjs';

const text = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : null;
function thumbnail(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try { return externalUrl(value).href; } catch { return null; }
}

export async function fetchPlaylist(id, env, options = {}) {
  if (typeof id !== 'string' || !/^(PL|UU|FL|OL)[\w-]{1,198}$/.test(id)) return { error: 'invalid_playlist' };
  const settings = { ...options, ttl: 3600 };
  const items = await youtubeData('playlistItems', { part: 'snippet,contentDetails', playlistId: id, maxResults: '50' }, env, settings);
  if (items.error) return items;
  const list = await youtubeData('playlists', { part: 'snippet,contentDetails', id }, env, settings);
  if (list.error) return list;
  const details = list.data.items?.[0];
  if (!details || !Array.isArray(items.data.items)) return { error: 'not_found' };
  const parsed = items.data.items.slice(0, 50).flatMap(item => {
    const snippet = item?.snippet, content = item?.contentDetails;
    const video_id = content?.videoId ?? snippet?.resourceId?.videoId;
    if (!snippet || !content || typeof video_id !== 'string' || !/^[\w-]{1,128}$/.test(video_id)) return [];
    const thumbs = snippet.thumbnails ?? {};
    return [{ video_id, title: text(snippet.title), thumbnail_url: thumbnail((thumbs.medium ?? thumbs.high ?? thumbs.default)?.url),
      channel_title: text(snippet.videoOwnerChannelTitle ?? snippet.channelTitle), position: Number.isSafeInteger(snippet.position) && snippet.position >= 0 ? snippet.position : 0 }];
  });
  return { playlist_id: id, title: text(details.snippet?.title), channel_title: text(details.snippet?.channelTitle), items: parsed,
    total_count: Number.isSafeInteger(details.contentDetails?.itemCount) && details.contentDetails.itemCount >= 0 ? details.contentDetails.itemCount : parsed.length,
    'truncated?': typeof items.data.nextPageToken === 'string' && items.data.nextPageToken.length > 0 };
}

export async function fetchPreview(raw, env, selfHosts = [], options = {}) {
  if (typeof raw !== 'string' || raw.length > 8192) throw new Error('invalid_url');
  if (!raw.trim()) return { resolved_url: null, preview: null };
  const item = parseMediaUrl(extractUrl(raw) ?? raw, selfHosts);
  const playlist = youtubePlaylist(item.url);
  if (playlist) {
    const data = await fetchPlaylist(playlist.id, env, options);
    if (data.items?.length) {
      const focused = data.items.filter(value => value.video_id === playlist.focus);
      return { resolved_url: item.url, preview: { ...data, source_type: 'playlist', focus_video_id: playlist.focus,
        items: [...focused, ...data.items.filter(value => value.video_id !== playlist.focus)] } };
    }
  }
  if (item.source_type === 'direct_url') return { resolved_url: item.url, preview: { source_type: item.source_type, title: new URL(item.url).pathname.split('/').at(-1), thumbnail_url: null, url: item.url } };
  const meta = await fetchMetadata(item, env, options);
  return { resolved_url: item.url, preview: { title: null, thumbnail_url: null, ...meta, source_type: item.source_type } };
}

export function addPlaylist(state, peer, preview, payload, now) {
  if (preview?.source_type !== 'playlist' || !['all', 'selected', 'single'].includes(payload.scope) || !['now', 'queue'].includes(payload.mode)) throw new Error('invalid_playlist_request');
  let selected = preview.items;
  if (payload.scope === 'single') selected = selected.filter(item => item.video_id === payload.video_id);
  if (payload.scope === 'selected') {
    if (!Array.isArray(payload.selected) || payload.selected.length > 50 || payload.selected.some(id => typeof id !== 'string')) throw new Error('invalid_playlist_request');
    const ids = new Set(payload.selected);
    selected = selected.filter(item => ids.has(item.video_id));
  }
  if (!selected.length) throw new Error('no_items');
  const items = selected.map(item => ({ ...parseMediaUrl(`https://www.youtube.com/watch?v=${encodeURIComponent(item.video_id)}`),
    title: item.title, thumbnail_url: item.thumbnail_url, duration: null, published_at: null,
    added_by: peer.userId, added_by_name: state.users[peer.userId]?.username ?? null, added_at: new Date(now).toISOString() }));
  const result = enqueue(state, items, payload.mode, now);
  const accepted = items.filter(item => result.state.queue.some(value => value.id === item.id));
  if (!accepted.length) throw new Error('queue_full');
  const first = accepted[0];
  const next = logActivity(result.state, 'added', peer.userId, `${accepted.length} videos (starting with: ${first.title ?? first.url})`, now);
  if (next !== result.state) result.events.push(['activity_log_entry', next.activity_log[0]]);
  return { ...result, state: next, metadata_items: accepted, added_count: accepted.length };
}
