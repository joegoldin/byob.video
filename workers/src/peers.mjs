import { currentPosition } from './room-sync.mjs';
import { logActivity } from './room-state.mjs';

function withoutOwners(tabs, owners) {
  return Object.fromEntries(Object.entries(tabs).filter(([, owner]) => !owners.includes(owner)));
}

export function readyCount(state) {
  const connected = Object.entries(state.users).filter(([, user]) => user.connected);
  if (!connected.some(([, user]) => user.is_extension) && !Object.keys(state.open_tabs).length) return null;
  const names = [...new Set(connected.filter(([, user]) => !user.is_extension).map(([, user]) => user.username))];
  const resolve = owner => state.users[owner]?.connected ? state.users[owner].username : null;
  const owners = [...new Set(Object.values(state.open_tabs))];
  const open = new Set(owners.map(resolve).filter(Boolean));
  const ready = new Set(Object.values(state.ready_tabs).map(resolve).filter(Boolean));
  const has_tab = Math.min(open.size, names.length);
  return {
    ready: Math.min(ready.size, has_tab), has_tab, total: names.length,
    needs_open: names.filter(name => !open.has(name)),
    needs_play: names.filter(name => open.has(name) && !ready.has(name)),
    users_with_open_tabs: owners,
  };
}

function presenceEvents(state) {
  const events = [['users_updated', state.users]];
  const count = readyCount(state);
  if (count) events.push(['ready_count', count]);
  return events;
}

export function joinPeer(state, userId, requestedName, extension, now) {
  let username = extension ? state.users[userId.slice(4)]?.username ?? requestedName : requestedName;
  username = typeof username === 'string' ? username.trim().slice(0, 30) : '';
  if (!username) username = extension ? 'ExtensionUser' : 'Anonymous';
  const present = Object.values(state.users).some(user => user.connected && user.username === username);
  const stale = Object.entries(state.users).filter(([id, user]) => id !== userId && !user.connected && user.is_extension === extension && user.username === username).map(([id]) => id);
  const users = Object.fromEntries(Object.entries(state.users).filter(([id]) => !stale.includes(id)));
  users[userId] = { username, joined_at: now, connected: true, is_extension: extension, hidden: false };
  if (!extension) {
    for (const [id, user] of Object.entries(users)) {
      if (user.is_extension && (id === `ext:${userId}` || stale.some(owner => id === `ext:${owner}`))) users[id] = { ...user, username };
    }
  }
  const pending_leaves = { ...state.pending_leaves };
  delete pending_leaves[userId];
  let next = {
    ...state, users, pending_leaves, host_id: state.host_id ?? userId, empty_deadline: null,
    open_tabs: withoutOwners(state.open_tabs, stale), ready_tabs: withoutOwners(state.ready_tabs, stale),
  };
  const events = [];
  if (!present) {
    const logged = logActivity(next, 'joined', userId, null, now);
    if (logged !== next) events.push(['activity_log_entry', logged.activity_log[0]]);
    next = logged;
  }
  events.push(...presenceEvents(next));
  if (!present) events.push(['room_presence', { event: 'joined', username }]);
  return { state: next, events };
}

export function leavePeer(state, userId, now) {
  if (!state.users[userId]) return state;
  return { ...state, pending_leaves: { ...state.pending_leaves, [userId]: now + 5000 } };
}

export function finalizeLeaves(state, now) {
  let next = state;
  const events = [];
  for (const [id, deadline] of Object.entries(state.pending_leaves)) {
    if (now < deadline) continue;
    const pending_leaves = { ...next.pending_leaves };
    delete pending_leaves[id];
    next = { ...next, pending_leaves };
    const user = next.users[id];
    if (!user) continue;
    if (user.is_extension) {
      const owner = id.startsWith('ext:') ? id.slice(4) : id;
      next = { ...next, open_tabs: withoutOwners(next.open_tabs, [owner]), ready_tabs: withoutOwners(next.ready_tabs, [owner]) };
    }
    next = { ...next, users: { ...next.users, [id]: { ...user, connected: false } } };
    const names = new Set(Object.values(next.users).filter(user => user.connected).map(user => user.username));
    if (names.size <= 1 && next.play_state === 'playing') {
      next = { ...next, play_state: 'paused', current_time: currentPosition(next, now), last_sync_at: now };
      events.push(['sync_pause', { time: next.current_time, server_time: now, user_id: null }]);
    }
    if (names.size) events.push(...presenceEvents(next));
    if (!names.has(user.username)) {
      const logged = logActivity(next, 'left', id, null, now);
      if (logged !== next) events.push(['activity_log_entry', logged.activity_log[0]]);
      next = logged;
      events.push(['room_presence', { event: 'left', username: user.username }]);
    }
  }
  return { state: next, events };
}

export function renamePeer(state, userId, username) {
  if (typeof username !== 'string' || !username.trim() || username.length > 30) throw new Error('invalid_username');
  if (!state.users[userId]) throw new Error('unknown_user');
  const users = { ...state.users, [userId]: { ...state.users[userId], username } };
  if (users[`ext:${userId}`]) users[`ext:${userId}`] = { ...users[`ext:${userId}`], username };
  const renameItem = item => item.added_by === userId ? { ...item, added_by_name: username } : item;
  const next = { ...state, users, queue: state.queue.map(renameItem), history: state.history.map(entry => ({ ...entry, item: renameItem(entry.item) })) };
  return { state: next, events: [...presenceEvents(next), ['queue_updated', { queue: next.queue, current_index: next.current_index }]] };
}
