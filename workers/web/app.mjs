import { RoomChannel } from './channel.mjs';
import { createCommentReplies } from './comment-replies.mjs';
import { mountHook } from './hooks.mjs';
import { html, render } from './html.mjs';
import * as views from './views.mjs';
import VideoPlayer from '../../assets/js/hooks/video_player.js';
import { mountRounds } from './rounds.mjs';
import StatsPanel from '../../assets/js/hooks/stats_panel.js';

const root = document.getElementById('app');
const notice = document.getElementById('notice');
const read = (storage, key, fallback) => { try { return storage.getItem(key) ?? fallback; } catch { return fallback; } };
const save = (storage, key, value) => { try { storage.setItem(key, value); } catch {} };
function message(text) { notice.textContent = text; notice.hidden = !text; }
function theme(value) { document.documentElement.dataset.theme = value; save(localStorage, 'phx:theme', value); }
theme(read(localStorage, 'phx:theme', 'dark'));
window.addEventListener('storage', event => { if (event.key === 'phx:theme') document.documentElement.dataset.theme = event.newValue || 'dark'; });
const roomId = location.pathname.match(/^\/room\/([a-z0-9]{1,16})\/?$/)?.[1];
let channel, player, rounds, statsHook, state, preview, previewTimer, previewEpoch = 0, comments, commentsVideo, sidebar = 'queue';
const browserId = read(localStorage, 'byob_browser_id', crypto.randomUUID());
save(localStorage, 'byob_browser_id', browserId);
let username = read(localStorage, 'watchparty_username', `Guest ${crypto.randomUUID().slice(0, 4)}`);
let showComments = read(localStorage, 'byob_show_comments', 'true') !== 'false';
let collapsed = false, expanded = false, dragFrom = null;
let nicknames;
try { nicknames = JSON.parse(read(localStorage, 'byob_nicknames', '{}')); } catch { nicknames = {}; }
const commentReplies = createCommentReplies({ request: payload => channel.request('comments:replies', payload), getVideo: () => commentsVideo, changed: updateComments });
const stats = new Map();
let notifications = 0;
function updateTitle() {
  const item = state?.current_index == null ? null : state.queue[state.current_index];
  document.title = `${notifications ? `(${notifications}) ` : ''}${item?.title ? `${item.title} | byob` : 'byob | bring your own binge'}`;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { notifications = 0; updateTitle(); } });
function notify() { if (document.hidden) { notifications++; updateTitle(); } }

function updateComments() {
  const panel = document.getElementById('comments-panel');
  panel.hidden = !showComments;
  render(panel, views.commentsPanel(comments, { collapsed, expanded, replies: commentReplies.entries }));
  document.getElementById('room-layout').classList.toggle('lg:h-[calc(100dvh-2.5rem)]', !expanded);
}
function updateRoom(next) {
  closeContextMenu();
  state = next;
  render(document.getElementById('queue-panel'), sidebar === 'queue' ? views.queuePanel(state) : views.historyPanel(state.history));
  render(document.getElementById('users-panel'), views.usersPanel(state.users, channel.session?.user_id, nicknames));
  const activity = document.getElementById('activity-panel');
  const following = activity.scrollHeight - activity.scrollTop - activity.clientHeight < 24;
  render(activity, views.activityPanel(state.activity_log));
  if (following) activity.scrollTop = activity.scrollHeight;
  for (const select of document.querySelectorAll('[data-sponsor-category]')) {
    select.value = state.sb_settings[select.dataset.sponsorCategory];
  }
  rounds.update(state.round, channel.session?.user_id);
  const item = state.current_index == null ? null : state.queue[state.current_index];
  document.getElementById('paused-play-button').hidden = state.play_state !== 'paused' || !['youtube', 'vimeo', 'direct_url'].includes(item?.source_type);
  updateTitle();
  const video = item?.source_type === 'youtube' ? item.source_id : null;
  if (video !== commentsVideo) {
    commentsVideo = video; comments = null; commentReplies.reset(); updateComments();
    if (video && showComments) void loadComments();
  }
}
async function loadComments(more = false) {
  const video = commentsVideo;
  if (!video) return;
  try {
    const result = await channel.request(more ? 'comments:load_more' : 'comments:load', { video_id: video, page_token: more ? comments?.next_page_token : null });
    if (video !== commentsVideo || result.error) return;
    comments = { ...result, comments: more ? [...(comments?.comments || []), ...result.comments] : result.comments };
    updateComments();
  } catch (error) {
    if (video !== commentsVideo) return;
    comments = { ...(comments || { comments: [] }), error: error.message };
    updateComments();
  }
}
async function command(event, payload = {}) {
  message('');
  try { return await channel.request(event, payload); }
  catch (error) { message(error.message); throw error; }
}
let contextOwner = null;
function closeContextMenu(restoreFocus = false) {
  document.getElementById('queue-context-menu')?.remove();
  if (restoreFocus && contextOwner?.isConnected) contextOwner.focus({ preventScroll: true });
  contextOwner = null;
}
root.addEventListener('contextmenu', event => {
  const row = event.target.closest('[data-context-kind]');
  if (!row || !state) return;
  event.preventDefault();
  closeContextMenu();
  const history = row.dataset.contextKind === 'history';
  const index = Number(history ? row.dataset.historyIndex : row.dataset.queueIdx);
  const item = history ? state.history[index]?.item : state.queue[index];
  if (!item) return;
  const container = document.createElement('div');
  render(container, views.contextMenu(item, { history, index, current: !history && index === state.current_index }));
  const menu = container.firstElementChild;
  root.append(menu);
  contextOwner = row;
  const bounds = row.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX || bounds.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY || bounds.bottom, innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector('button').focus({ preventScroll: true });
});
document.addEventListener('click', event => {
  const menu = document.getElementById('queue-context-menu');
  if (menu && !menu.contains(event.target)) closeContextMenu();
});
window.addEventListener('resize', () => closeContextMenu());
window.addEventListener('scroll', () => closeContextMenu(), true);
document.addEventListener('keydown', event => {
  const menu = document.getElementById('queue-context-menu');
  if (!menu) return;
  if (event.key === 'Escape') { event.preventDefault(); closeContextMenu(true); }
  else if (event.key === 'Tab') closeContextMenu();
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('[role="menuitem"]')];
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (buttons.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true });
  }
});

function positionPreview() {
  const panel = document.getElementById('url-preview');
  if (!panel) return;
  // The HTTP fallback banner can shift navigation below the viewport top.
  panel.style.top = innerWidth < 640 ? `${document.getElementById('url-input').getBoundingClientRect().bottom + 4}px` : '';
}
window.addEventListener('resize', positionPreview);
window.addEventListener('scroll', positionPreview);

function clearUrl() {
  previewEpoch++; clearTimeout(previewTimer); preview = null;
  document.getElementById('url-input').value = '';
  document.getElementById('url-clear-btn').classList.add('hidden');
  render(document.getElementById('url-preview'), html``);
}
async function playlist(scope, mode, videoId) {
  await command('playlist:add', { url: preview.resolved_url, scope, mode, video_id: videoId,
    selected: [...document.querySelectorAll('#url-preview input:checked')].map(input => input.value) });
  clearUrl();
}

if (roomId) {
  render(root, views.roomShell(roomId));
  const tabId = read(sessionStorage, 'byob_tab_id', crypto.randomUUID());
  save(sessionStorage, 'byob_tab_id', tabId);
  let extensionReported = false;
  channel = new RoomChannel({ origin: location.origin, roomId, tabId, browserId, username: () => username,
    hasExtension: () => (extensionReported = document.documentElement.hasAttribute('data-byob-extension')) });
  const reportExtension = () => {
    if (channel.joined && !extensionReported && document.documentElement.hasAttribute('data-byob-extension')) {
      extensionReported = true;
      channel.request('analytics:has_extension').catch(() => {});
    }
  };
  new MutationObserver(reportExtension).observe(document.documentElement, { attributes: true, attributeFilter: ['data-byob-extension'] });
  const element = document.getElementById('player');
  Object.assign(element.dataset, { serverUrl: location.origin, username });
  player = mountHook(VideoPlayer, element, channel);
  rounds = mountRounds(document.getElementById('round-panel'), channel);
  channel.on('session', session => {
    Object.assign(element.dataset, { userId: session.user_id, token: session.token, username });
    statsHook.hook.localUserId = session.user_id;
  });
  channel.on('room:state', updateRoom);
  channel.on('room:presence', event => { if (event.username !== username) notify(); });
  channel.on('activity:entry', entry => { if (entry.action === 'added') notify(); });
  channel.on('status', status => {
    if (status.state === 'connected') reportExtension();
    const statusPanel = document.getElementById('connection-status');
    statusPanel.hidden = status.state === 'connected';
    statusPanel.textContent = status.state === 'connected' ? '' : status.state === 'connecting' ? 'Connecting…' : 'Connection lost. Reconnecting…';
  });
  channel.on('connection:error', error => message(error.message));
  channel.on('action:error', error => message(error.message));
  channel.on('comments:updated', result => { if (result.video_id === commentsVideo) { comments = result; updateComments(); } });
  channel.on('sync:client_stats', sample => {
    stats.set(sample.key, sample);
    const panel = document.getElementById('connection-stats');
    if (panel) panel.textContent = JSON.stringify([...stats.values()], null, 2);
  });
  statsHook = mountHook(StatsPanel, root, channel);
  document.getElementById('url-input').addEventListener('input', () => {
    clearTimeout(previewTimer);
    const epoch = ++previewEpoch;
    const value = document.getElementById('url-input').value.trim();
    document.getElementById('url-clear-btn').classList.toggle('hidden', !value);
    if (!value) { preview = null; render(document.getElementById('url-preview'), html``); return; }
    previewTimer = setTimeout(async () => {
      try {
        const result = await channel.request('preview_url', { url: document.getElementById('url-input').value });
        if (epoch !== previewEpoch) return;
        preview = result; render(document.getElementById('url-preview'), views.previewPanel(result));
        positionPreview();
      } catch (error) {
        if (epoch !== previewEpoch) return;
        preview = null;
        render(document.getElementById('url-preview'), views.previewPanel({ error: error.message, resolved_url: document.getElementById('url-input').value }));
        positionPreview();
      }
    }, 300);
  });
  document.getElementById('url-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const mode = event.submitter?.value || 'queue';
      if (preview?.preview?.source_type === 'playlist') await playlist('selected', mode);
      else { await command('add_url', { url: document.getElementById('url-input').value, mode }); clearUrl(); }
    } catch { /* command() displays the failure without discarding the input. */ }
  });
  root.addEventListener('dragstart', event => {
    const item = event.target.closest('[data-queue-idx]');
    if (item) { dragFrom = Number(item.dataset.queueIdx); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(dragFrom)); }
  });
  root.addEventListener('dragover', event => { if (event.target.closest('[data-queue-idx]')) event.preventDefault(); });
  root.addEventListener('drop', event => {
    const item = event.target.closest('[data-queue-idx]');
    if (!item || dragFrom == null) return;
    event.preventDefault(); void command('queue:reorder', { from: dragFrom, to: Number(item.dataset.queueIdx) }).catch(() => {}); dragFrom = null;
  });
  root.addEventListener('dragend', () => { dragFrom = null; });
  root.addEventListener('change', event => {
    const input = event.target;
    if (input.dataset.sponsorCategory) void command('sb:update', { category: input.dataset.sponsorCategory, action: input.value }).catch(() => {});
    if (input.id === 'show-comments') { showComments = input.checked; save(localStorage, 'byob_show_comments', String(showComments)); updateComments(); if (showComments) void loadComments(); }
  });
  document.getElementById('byob-autoplay-help').addEventListener('close', () => {
    if (document.getElementById('byob-autoplay-help-dont-show').checked) save(localStorage, 'byob_autoplay_help_dismissed', '1');
  });
  void channel.start();
  window.addEventListener('pagehide', event => { if (!event.persisted) { rounds.destroy(); statsHook.destroy(); player.destroy(); channel.stop(); } });
} else if (location.pathname === '/') render(root, views.home());
else render(root, html`<section class="p-8"><h1>Room not found</h1><a href="/" class="link">Create a room</a></section>`);

root.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (button.closest('#queue-context-menu')) closeContextMenu(true);
  try {
    if (action === 'create-room') {
      button.disabled = true;
      const response = await fetch('/api/rooms', { method: 'POST', headers: { 'X-Byob-Browser-ID': browserId } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not create a room.');
      location.assign(`/room/${result.data.room_id}`); return;
    }
    if (action === 'extension') { window.open(/Firefox/.test(navigator.userAgent) ? views.links.firefox : views.links.chrome, '_blank', 'noopener,noreferrer'); return; }
    if (action === 'theme') { theme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); return; }
    if (action === 'copy-room') { await navigator.clipboard.writeText(location.href); message('Room link copied.'); return; }
    if (!state) return;
    if (action === 'settings') {
      render(document.getElementById('settings-content'), views.settingsPanel(state, showComments));
      document.getElementById('settings-modal').showModal();
      const result = await command('room:credentials');
      document.getElementById('room-api-key').value = result.api_key;
    } else if (action === 'autoplay-help') {
      try { localStorage.removeItem('byob_autoplay_help_dismissed'); } catch {}
      document.getElementById('byob-autoplay-help-dont-show').checked = false;
      document.getElementById('byob-autoplay-help').showModal();
    } else if (action === 'copy-api-key') { await navigator.clipboard.writeText(document.getElementById('room-api-key').value); message('API key copied.'); }
    else if (action === 'reveal-api-key') { const input = document.getElementById('room-api-key'); input.type = input.type === 'password' ? 'text' : 'password'; }
    else if (action === 'copy-video-url') await navigator.clipboard.writeText(button.dataset.url);
    else if (action === 'queue-restart') await command('video:restart');
    else if (action === 'paused-play') {
      if (!player.hook.isReady) return;
      const position = player.hook._getCurrentTime();
      // Start inside the click gesture; waiting for the network loses autoplay permission.
      player.hook._onSyncPlay({ time: position, server_time: player.hook.clockSync.serverNow(), user_id: null });
      await command('video:play', { position });
    }
    else if (action === 'queue-play') await command('queue:play_index', { index: Number(button.dataset.index) });
    else if (action === 'queue-remove') await command('queue:remove', { item_id: button.dataset.id });
    else if (action === 'queue-move') await command('queue:reorder', { from: Number(button.dataset.from), to: Number(button.dataset.to) });
    else if (action === 'history-add' || action === 'history-play') await command(action === 'history-add' ? 'queue:readd' : 'history:play', { url: button.dataset.url });
    else if (action === 'queue-tab' || action === 'history-tab') {
      sidebar = action.split('-')[0];
      for (const tab of ['queue', 'history']) { const element = document.getElementById(`${tab}-tab`); element.classList.toggle('tab-active', tab === sidebar); element.setAttribute('aria-selected', String(tab === sidebar)); }
      updateRoom(state);
    } else if (action === 'rename') {
      const next = prompt('Your name', username)?.trim();
      if (next) { await command('username:change', { username: next }); username = next; save(localStorage, 'watchparty_username', next); document.getElementById('player').dataset.username = next; }
    } else if (action === 'nickname') {
      const name = button.dataset.name, next = prompt(`Nickname for ${name} (leave blank to clear)`, nicknames[name] || '');
      if (next != null) { if (next.trim()) nicknames[name] = next.trim(); else delete nicknames[name]; save(localStorage, 'byob_nicknames', JSON.stringify(nicknames)); updateRoom(state); }
    } else if (action === 'clear-url') clearUrl();
    else if (action === 'playlist-all') await playlist('all', 'queue');
    else if (action === 'playlist-selected' || action === 'playlist-now') await playlist('selected', action === 'playlist-now' ? 'now' : 'queue');
    else if (action === 'playlist-single') await playlist('single', 'now', button.dataset.video);
    else if (action === 'round-voting' || action === 'round-roulette') await command('round:start', { mode: action.slice(6) });
    else if (action === 'round-vote') await command('round:vote', { round_id: state.round.id, external_id: button.dataset.video });
    else if (action === 'round-cancel') await command('round:cancel', { round_id: state.round.id });
    else if (action === 'comment-seek') await command('comments:seek', { seconds: Number(button.dataset.seconds) });
    else if (action === 'more-comments') await loadComments(true);
    else if (action === 'comment-replies') await commentReplies.toggle(button.dataset.commentId);
    else if (action === 'more-replies') await commentReplies.more(button.dataset.commentId);
    else if (action === 'retry-replies') await commentReplies.retry(button.dataset.commentId);
    else if (action === 'collapse-comments') { collapsed = !collapsed; updateComments(); }
    else if (action === 'expand-comments') { expanded = !expanded; updateComments(); }
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
