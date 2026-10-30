import { parseMediaUrl } from './media.mjs';
import { currentPosition } from './room-sync.mjs';
import { transitionPlayback } from './playback.mjs';
import { enqueue, removeItem, reorderQueue, advanceQueue } from './queue.mjs';
import { joinPeer, renamePeer } from './peers.mjs';

export function executeRoomApi(state, method, path, params, now, selfHosts = []) {
  const ok = data => ({ state, events: [], status: 200, body: { ok: true, data } });
  if (method === 'GET' && path === '') return ok({
    room_id: state.room_id, play_state: state.play_state, current_time: currentPosition(state, now),
    current_index: state.current_index, queue_length: state.queue.length, user_count: Object.keys(state.users).length,
  });
  if (method === 'GET' && path === '/queue') return ok({
    queue: state.queue.map(item => ({
      id: item.id, url: item.url, title: item.title ?? null, source_type: item.source_type,
      added_by: item.added_by_name ?? null, thumbnail_url: item.thumbnail_url ?? null,
    })), current_index: state.current_index,
  });
  if (method === 'GET' && path === '/users') return ok({
    users: Object.entries(state.users).map(([id, user]) => ({ id, username: user.username, connected: user.connected })),
  });

  const userId = `api:${state.api_key.slice(0, 8)}`;
  const events = [];
  const ensureUser = () => {
    if (state.users[userId]) return;
    const joined = joinPeer(state, userId, userId, false, now);
    state = joined.state;
    events.push(...joined.events);
  };
  const result = (transition, message, extra = {}) => ({
    state: transition.state, events: [...events, ...transition.events], status: 200,
    body: { ok: true, data: { message, ...extra } },
  });

  if (method === 'POST' && path === '/queue') {
    const parsed = parseMediaUrl(params.url, selfHosts);
    ensureUser();
    const item = {
      ...parsed, title: null, duration: null, thumbnail_url: null, published_at: null,
      added_by: userId, added_by_name: state.users[userId].username, added_at: new Date(now).toISOString(),
    };
    const mode = params.play_now !== false && params.play_now != null ? 'now' : 'queue';
    return { ...result(enqueue(state, [item], mode, now), 'Added to queue.'), metadata_item: item };
  }
  if (method === 'DELETE' && path.startsWith('/queue/')) return result(removeItem(state, decodeURIComponent(path.slice(7))), 'Removed from queue.');
  if (method === 'PUT' && path === '/queue/reorder') return result(reorderQueue(state, params.from, params.to), 'Queue reordered.');
  if (method === 'POST' && path === '/skip') {
    const advanced = advanceQueue(state, now);
    advanced.events.unshift(['autoplay_countdown_cancelled', {}]);
    return result(advanced, 'Skipped to next item.');
  }
  if (method === 'POST' && ['/play', '/pause'].includes(path)) {
    ensureUser();
    return result(transitionPlayback(state, path.slice(1), userId, params.position, now), path === '/play' ? 'Playing.' : 'Paused.');
  }
  if (method === 'PUT' && path === '/username') {
    if (typeof params.username !== 'string' || !params.username.trim() || params.username.length > 30) throw new Error('invalid_username');
    ensureUser();
    return result(renamePeer(state, userId, params.username), 'Username updated.', { username: params.username });
  }
  return { state, events: [], status: 404, body: { error: 'Not found.' } };
}
