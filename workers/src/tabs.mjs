import { readyCount } from './peers.mjs';

function tabKey(peer, value) {
  if (!(typeof value === 'string' && value.length > 0 && value.length <= 64) && !Number.isSafeInteger(value)) throw new Error('invalid_tab');
  return `${peer.userId}:${value}`;
}

export function updateTabs(state, peer, event, payload) {
  if (peer.role !== 'extension') throw new Error('extension_required');
  const owner = peer.ownerId;
  let open = { ...state.open_tabs }, ready = { ...state.ready_tabs };
  const events = [];
  if (event === 'video:tabs_resync') {
    const ids = payload.tab_ids ?? [];
    const readyIds = payload.ready_tab_ids;
    if (!Array.isArray(ids) || ids.length > 64 || (readyIds !== undefined && (!Array.isArray(readyIds) || readyIds.length > 64))) throw new Error('invalid_tab');
    const otherOwner = value => value !== owner && value !== `ext:${owner}`;
    open = Object.fromEntries(Object.entries(open).filter(([, value]) => otherOwner(value)));
    for (const id of ids) open[tabKey(peer, id)] = owner;
    if (readyIds === undefined) {
      ready = Object.fromEntries(Object.entries(ready).filter(([key, value]) => otherOwner(value) || Object.hasOwn(open, key)));
    } else {
      ready = Object.fromEntries(Object.entries(ready).filter(([, value]) => otherOwner(value)));
      for (const id of readyIds) ready[tabKey(peer, id)] = owner;
    }
  } else {
    const key = tabKey(peer, payload.tab_id);
    if (event === 'video:tab_opened') open[key] = owner;
    else if (event === 'video:ready') ready[key] = owner;
    else if (event === 'video:unready') delete ready[key];
    else if (event === 'video:tab_closed') {
      const previousOwner = open[key];
      delete open[key];
      delete ready[key];
      if (previousOwner && !Object.values(open).includes(previousOwner)) {
        const username = state.users[previousOwner]?.username;
        if (username) events.push(['room_presence', { event: 'ext_closed', username }]);
      }
    } else throw new Error('unsupported_event');
  }
  if (Object.values(open).filter(value => value === owner).length > 64 || Object.values(ready).filter(value => value === owner).length > 64) throw new Error('too_many_tabs');
  const next = { ...state, open_tabs: open, ready_tabs: ready };
  const count = readyCount(next);
  if (count) events.push(['ready_count', count]);
  return { state: next, events };
}
