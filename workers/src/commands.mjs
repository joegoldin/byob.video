import { parseMediaUrl, extractUrl } from './media.mjs';
import { enqueue, playIndex, removeItem, reorderQueue, advanceQueue } from './queue.mjs';
import { seekPlayback } from './playback.mjs';
import { renamePeer } from './peers.mjs';
import { logActivity, defaultSponsorSettings } from './room-state.mjs';
import { updateLive, updateScrapedMedia, replaceCurrentUrl } from './media-updates.mjs';
import { voteRound, cancelRound } from './room-rounds.mjs';

function index(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_index');
  return value;
}

function activity(result, action, userId, detail, now) {
  const state = logActivity(result.state, action, userId, detail, now);
  const events = [...result.events];
  if (state !== result.state) events.push(['activity_log_entry', state.activity_log[0]]);
  return { ...result, state, events };
}

export function roomCommand(state, peer, event, payload, now) {
  const userId = peer.userId;
  if (['round:vote', 'round:cancel'].includes(event) && peer.role !== 'browser') throw new Error('browser_required');
  switch (event) {
    case 'debug:log':
      if (peer.role !== 'extension') throw new Error('extension_required');
      // Accept the legacy diagnostic event without retaining arbitrary page data.
      return { state, events: [] };
    case 'round:vote': return voteRound(state, userId, payload.round_id, payload.external_id, now);
    case 'round:cancel': return cancelRound(state, userId, payload.round_id, now);
    case 'comments:seek': return seekPlayback(state, userId, index(payload.seconds), now);
    case 'video:update_url': return activity(replaceCurrentUrl(state, peer, payload, now), 'played', userId, payload.url, now);
    case 'video:live_status': return updateLive(state, payload);
    case 'video:media_info': return updateScrapedMedia(state, peer, payload);
    case 'add_url':
    case 'queue:add':
    case 'history:play':
    case 'queue:readd': {
      if (typeof payload.url !== 'string' || payload.url.length > 8192) throw new Error('invalid_url');
      const parsed = parseMediaUrl(extractUrl(payload.url) ?? payload.url, [peer.siteHost]);
      const item = { ...parsed, title: null, thumbnail_url: null, duration: null, published_at: null,
        added_by: userId, added_by_name: state.users[userId]?.username ?? null, added_at: new Date(now).toISOString() };
      const mode = event === 'history:play' || payload.mode === 'now' ? 'now' : 'queue';
      return { ...activity(enqueue(state, [item], mode, now), 'added', userId, item.url, now), metadata_item: item };
    }
    case 'queue:skip': {
      const result = advanceQueue(state, now);
      result.events.unshift(['autoplay_countdown_cancelled', {}]);
      return activity(result, 'skipped', null, null, now);
    }
    case 'queue:remove': return removeItem(state, payload.item_id);
    case 'queue:play_index': {
      const selected = index(payload.index);
      const result = playIndex(state, selected, now);
      const item = state.queue[selected];
      return activity(result, 'played', userId, item.title ?? item.url, now);
    }
    case 'queue:reorder': return reorderQueue(state, index(payload.from), index(payload.to));
    case 'video:restart': return seekPlayback(state, userId, 0, now);
    case 'username:change': return activity(renamePeer(state, userId, payload.username), 'renamed', userId, `${state.users[userId]?.username} → ${payload.username}`, now);
    case 'sb:update': {
      if (!Object.hasOwn(defaultSponsorSettings, payload.category) || !['auto_skip', 'show_bar', 'disabled'].includes(payload.action)) throw new Error('invalid_settings');
      const next = { ...state, sb_settings: { ...state.sb_settings, [payload.category]: payload.action } };
      return { state: next, events: [['sb_settings', next.sb_settings]] };
    }
    default: throw new Error('unsupported_event');
  }
}
