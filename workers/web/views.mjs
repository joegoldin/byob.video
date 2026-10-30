import { html, mediaUrl, duration } from './html.mjs';

export const links = Object.freeze({
  source: 'https://github.com/joegoldin/byob.video',
  privacy: 'https://github.com/joegoldin/byob.video/blob/main/PRIVACY.md',
  chrome: 'https://chromewebstore.google.com/detail/jlpogmjckejgpbbfhafgjgkbnocjfbmb',
  firefox: 'https://addons.mozilla.org/en-US/firefox/addon/byob-bring-your-own-binge/',
});

function thumbnail(item) {
  const url = mediaUrl(item.thumbnail_url);
  return url ? html`<img src="${url}" alt="" loading="lazy" class="w-20 h-12 rounded object-cover shrink-0" />` : html`<span class="w-20 h-12 rounded bg-base-300 shrink-0 flex items-center justify-center" aria-hidden="true">▶</span>`;
}

export function home() {
  return html`<nav class="navbar min-h-0 h-10 bg-base-200 px-4 gap-2"><a href="/" class="font-bold mr-auto">byob</a><a href="${links.source}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-xs">Source</a><button data-action="theme" class="btn btn-ghost btn-xs" aria-label="Toggle theme">◐</button></nav><div class="flex items-center justify-center min-h-[70vh] px-4"><section class="card bg-base-200 shadow-xl p-6 sm:p-10 text-center items-center w-full max-w-lg">
    <div class="bg-base-100 rounded-xl p-3 mb-4"><img src="/images/logo.svg" alt="byob — bring your own binge" class="w-64 h-auto max-w-full" /></div>
    <p class="text-base-content/60 mb-6">Watch videos together in sync. Free and open source.</p>
    <button data-action="create-room" class="btn btn-primary btn-lg mb-6">Create Room</button>
    <ul class="space-y-2 text-sm text-base-content/60 mb-6"><li>YouTube with <a href="https://sponsor.ajay.app" target="_blank" rel="noopener noreferrer" class="link">SponsorBlock</a></li><li>Vimeo</li><li>Twitch (live channels &amp; VODs)</li><li>Direct video files (.mp4, .webm, .mkv)</li><li>Any site via <button data-action="extension" class="link link-primary">browser extension</button></li></ul>
    <p class="text-xs text-base-content/50">No account needed. Create a room, share the link, and watch together.</p>
  </section></div>`;
}

export function roomShell(roomId) {
  return html`<nav id="room-nav" class="navbar min-h-0 flex-wrap sm:flex-nowrap sm:h-10 bg-base-200 border-b border-base-300 px-2 py-2 sm:py-0 gap-2">
    <a href="/" class="font-bold">byob</a><button data-action="copy-room" class="btn btn-ghost btn-xs">Copy Room Link</button>
    <form id="url-form" class="order-last sm:order-none flex w-full sm:w-auto sm:flex-1 min-w-0 gap-1"><input id="url-input" name="url" type="text" autocomplete="off" placeholder="Paste a video URL…" aria-label="Video URL" class="input input-bordered input-xs w-full" /><button class="btn btn-primary btn-xs" name="mode" value="queue">Add</button><button class="btn btn-ghost btn-xs" name="mode" value="now">Play now</button><button type="button" data-action="clear-url" class="btn btn-ghost btn-xs" aria-label="Clear URL">×</button></form>
    <button data-action="settings" class="btn btn-ghost btn-xs ml-auto sm:ml-0">Settings</button><button data-action="theme" class="btn btn-ghost btn-xs" aria-label="Toggle theme">◐</button>
  </nav><div id="connection-status" role="status" class="text-xs px-2 py-1">Connecting…</div><div id="url-preview"></div>
  <div id="room-layout" class="flex flex-col lg:flex-row gap-3 p-2 lg:h-[calc(100vh-4rem)]">
    <section class="flex-1 min-w-0 min-h-0 flex flex-col"><div id="player-sizer" class="mb-2 flex justify-center shrink-0"><div id="player" data-room-id="${roomId}" class="relative bg-base-300 rounded-lg overflow-hidden"><div class="absolute inset-0 flex items-center justify-center text-base-content/40">Paste a URL to start watching</div></div></div>
      <div class="flex flex-wrap gap-1 mb-2"><button data-action="play" class="btn btn-xs">Play</button><button data-action="pause" class="btn btn-xs">Pause</button><button data-action="restart" class="btn btn-xs">Restart</button><button data-action="skip" class="btn btn-xs">Skip</button><label class="text-xs">Speed <select id="playback-rate" class="select select-xs" aria-label="Playback speed">${[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(rate => html`<option value="${rate}" ${rate === 1 ? html`selected` : ''}>${rate}×</option>`)}</select></label><button data-action="round-voting" class="btn btn-xs">Vote on a video</button><button data-action="round-roulette" class="btn btn-xs">Roulette</button><button data-action="toggle-comments" class="btn btn-ghost btn-xs">Comments</button></div>
      <div id="round-panel"></div><div id="comments-panel" class="min-h-0 overflow-auto"></div>
    </section><aside class="lg:w-72 shrink-0 flex flex-col gap-2 min-h-0 lg:h-full">
      <section class="card bg-base-200 flex-1 min-h-0 overflow-hidden"><div class="p-3 flex flex-col min-h-0 h-full"><div role="tablist" class="tabs tabs-box tabs-sm mb-2"><button role="tab" id="queue-tab" data-action="queue-tab" class="tab tab-active" aria-selected="true">Queue</button><button role="tab" id="history-tab" data-action="history-tab" class="tab" aria-selected="false">History</button></div><div id="queue-panel" class="overflow-auto flex-1"></div></div></section>
      <details class="card bg-base-200 p-3"><summary class="cursor-pointer text-sm">Activity</summary><div id="activity-panel" class="max-h-40 overflow-auto"></div></details><section id="users-panel" class="card bg-base-200 p-3"></section>
    </aside>
  </div><dialog id="settings-modal" class="modal"><div class="modal-box max-w-2xl"><form method="dialog"><button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" aria-label="Close settings">×</button></form><h2 class="font-bold text-lg mb-4">Settings</h2><div id="settings-content"></div></div><form method="dialog" class="modal-backdrop"><button>Close</button></form></dialog>${autoplayHelp()}`;
}

export function queuePanel(state) {
  if (!state.queue.length) return html`<p class="text-sm text-base-content/50 py-6 text-center">Your queue is empty. Paste a video URL to get started.</p>`;
  return html`<ol class="space-y-2">${state.queue.map((item, index) => html`<li draggable="true" data-queue-idx="${index}" class="rounded p-2 ${index === state.current_index ? 'bg-primary/15 border border-primary/30' : 'bg-base-100'}">
    <div class="flex gap-2">${thumbnail(item)}<div class="min-w-0 flex-1"><button data-action="queue-play" data-index="${index}" class="text-left text-sm font-medium line-clamp-2">${item.title || item.url}</button><p class="text-xs text-base-content/50">${item.is_live ? 'LIVE' : duration(item.duration)} · ${item.added_by_name || 'Someone'}</p></div></div>
    <div class="flex justify-end gap-1 mt-1"><button data-action="queue-move" data-from="${index}" data-to="${Math.max(0, index - 1)}" class="btn btn-ghost btn-xs" aria-label="Move video up">↑</button><button data-action="queue-move" data-from="${index}" data-to="${Math.min(state.queue.length - 1, index + 1)}" class="btn btn-ghost btn-xs" aria-label="Move video down">↓</button><button data-action="queue-remove" data-id="${item.id}" class="btn btn-ghost btn-xs">Remove</button></div>
  </li>`)}</ol>`;
}

export function historyPanel(history) {
  return history.length ? html`<ol class="space-y-2">${history.map(({ item }) => html`<li class="bg-base-100 rounded p-2"><div class="flex gap-2">${thumbnail(item)}<span class="text-sm line-clamp-2">${item.title || item.url}</span></div><div class="flex justify-end gap-1 mt-1"><button data-action="history-add" data-url="${item.url}" class="btn btn-xs">Re-add</button><button data-action="history-play" data-url="${item.url}" class="btn btn-ghost btn-xs">Play now</button></div></li>`)}</ol>` : html`<p class="text-sm text-base-content/50 py-6 text-center">Watched videos appear here.</p>`;
}

export function usersPanel(users, owner, nicknames = {}) {
  return html`<h2 class="text-sm font-semibold mb-2">Watching together</h2><ul class="space-y-1">${Object.entries(users).filter(([, user]) => !user.is_extension).map(([id, user]) => html`<li class="flex gap-2 items-center text-sm ${user.connected ? '' : 'opacity-40'}"><span aria-label="${user.connected ? 'Online' : 'Offline'}">${user.connected ? '●' : '○'}</span><span class="truncate">${user.username}${nicknames[user.username] ? html` <small class="opacity-60">(${nicknames[user.username]})</small>` : ''}</span><button data-action="${id === owner ? 'rename' : 'nickname'}" data-name="${user.username}" class="btn btn-ghost btn-xs ml-auto">${id === owner ? 'Rename' : 'Nickname'}</button></li>`)}</ul>`;
}

export function activityPanel(entries) {
  return html`<ol class="text-xs space-y-1 mt-2">${entries.map(entry => html`<li><time title="${entry.at}">${new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> <strong>${entry.user || 'Room'}</strong> ${entry.action}${entry.detail ? html` <span class="opacity-60">${entry.detail}</span>` : ''}</li>`)}</ol>`;
}

export function commentsPanel(page, { collapsed = false, expanded = false } = {}) {
  if (!page) return html`<p class="text-sm text-base-content/50">Comments appear for YouTube videos.</p>`;
  return html`<section class="card bg-base-200 p-3"><div class="flex gap-2 items-center mb-2"><h2 class="font-semibold text-sm">Comments ${page.total_count ?? ''}</h2><button data-action="collapse-comments" class="btn btn-ghost btn-xs ml-auto">${collapsed ? 'Show' : 'Collapse'}</button><button data-action="expand-comments" class="btn btn-ghost btn-xs">${expanded ? 'Compact' : 'Expand'}</button></div>${collapsed ? '' : html`<div class="space-y-4 ${expanded ? '' : 'max-h-72 overflow-auto'}">${page.comments.map(comment => html`<article><div class="flex items-center gap-2 text-xs">${mediaUrl(comment.author_avatar) ? html`<img src="${mediaUrl(comment.author_avatar)}" alt="" class="w-6 h-6 rounded-full" loading="lazy" />` : ''}<strong>${comment.author}</strong><span class="opacity-50">${comment.published_at?.slice(0, 10)}</span></div><p class="text-sm whitespace-pre-wrap break-words mt-1">${commentText(comment.text || '')}</p><p class="text-xs opacity-50">♥ ${comment.likes} · ${comment.reply_count} replies</p></article>`)}</div>${page.next_page_token ? html`<button data-action="more-comments" class="btn btn-ghost btn-sm mt-2">Load more comments</button>` : ''}`}</section>`;
}

function commentText(text) {
  return text.split(/(\b(?:\d+:)?\d{1,2}:\d{2}\b)/g).map(part => {
    if (!/^(?:\d+:)?\d{1,2}:\d{2}$/.test(part)) return part;
    const seconds = part.split(':').reduce((total, value) => total * 60 + Number(value), 0);
    return html`<button class="link link-primary" data-action="comment-seek" data-seconds="${seconds}">${part}</button>`;
  });
}

export function previewPanel(result) {
  const preview = result?.preview;
  if (!preview) return html``;
  if (preview.source_type !== 'playlist') return html`<div class="card bg-base-200 p-3 m-2 flex-row gap-3">${thumbnail(preview)}<div><strong class="text-sm">${preview.title || result.resolved_url}</strong><p class="text-xs opacity-60">${preview.source_type}</p></div></div>`;
  return html`<section class="card bg-base-200 p-3 m-2"><h2 class="font-semibold">${preview.title}</h2><p class="text-xs opacity-60">${preview.total_count} videos${preview['truncated?'] ? ' · Showing the first 50' : ''}</p><div class="max-h-64 overflow-auto my-2">${preview.items.map(item => html`<label class="flex gap-2 items-center py-1"><input type="checkbox" value="${item.video_id}" class="checkbox checkbox-xs" checked />${thumbnail(item)}<span class="text-sm">${item.title}</span><button type="button" data-action="playlist-single" data-video="${item.video_id}" class="btn btn-ghost btn-xs ml-auto">Play</button></label>`)}</div><div class="flex gap-2"><button data-action="playlist-all" class="btn btn-sm">Queue all</button><button data-action="playlist-selected" class="btn btn-sm">Queue selected</button><button data-action="playlist-now" class="btn btn-primary btn-sm">Play selected now</button></div></section>`;
}

export function settingsPanel(state, showComments) {
  return html`<label class="flex gap-2 items-center mb-4"><input type="checkbox" id="show-comments" class="checkbox checkbox-sm" ${showComments ? html`checked` : ''} /> Show YouTube comments</label>
    <button data-action="autoplay-help" class="btn btn-ghost btn-sm mb-4">Autoplay help / reset dismissed tip</button>
    <h3 class="font-semibold mb-2">SponsorBlock</h3><div class="grid grid-cols-2 gap-2 mb-4">${Object.entries(state.sb_settings).map(([category, action]) => html`<label class="text-sm">${category}<select class="select select-sm w-full" data-sponsor-category="${category}">${[['auto_skip', 'Automatically skip'], ['show_bar', 'Show markers'], ['disabled', 'Disabled']].map(([value, label]) => html`<option value="${value}" ${value === action ? html`selected` : ''}>${label}</option>`)}</select></label>`)}</div>
    <h3 class="font-semibold">Room API</h3><p class="text-xs opacity-60 mb-2">Anyone with this key can control your room. Do not share it publicly.</p><div class="flex gap-2"><input id="room-api-key" type="password" readonly aria-label="Room API key" class="input input-sm flex-1" /><button data-action="copy-api-key" class="btn btn-sm">Copy key</button><button data-action="reveal-api-key" class="btn btn-ghost btn-sm">Show / hide</button></div>
    <p class="text-xs mt-2">Use Authorization: Bearer &lt;key&gt; with /api/rooms/${state.room_id}.</p><details class="mt-4"><summary>Stats for nerds</summary><div id="byob-local-sync-chart" class="mt-2"></div><div id="byob-drift-bands" class="mt-2"></div><pre id="connection-stats" class="text-xs overflow-auto max-h-64 mt-2"></pre></details><p class="text-xs mt-4"><a class="link" href="${links.source}" target="_blank" rel="noopener noreferrer">Source code</a> · <a class="link" href="${links.privacy}" target="_blank" rel="noopener noreferrer">Privacy</a></p>`;
}

export function votingPanel(round, owner) {
  if (!round) return html``;
  return html`<section class="card bg-base-200 p-3 mb-2"><div class="flex items-center gap-2"><h2 class="font-semibold">${round.mode === 'voting' ? 'Vote for the next video' : 'Video roulette'}</h2><span id="round-timer-label" class="text-sm ml-auto"></span>${round.started_by === owner && round.phase === 'active' ? html`<button data-action="round-cancel" class="btn btn-ghost btn-xs">Cancel</button>` : ''}</div><div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">${round.candidates.map(item => html`<button data-action="round-vote" data-video="${item.external_id}" ${round.mode !== 'voting' || round.phase !== 'active' ? html`disabled` : ''} class="text-left p-2 rounded ${round.winner_external_id === item.external_id ? 'bg-primary text-primary-content' : 'bg-base-100'}">${thumbnail(item)}<span class="text-xs line-clamp-2">${item.title}</span>${round.mode === 'voting' ? html`<span class="badge badge-sm">${round.tallies?.[item.external_id] || 0} votes</span>` : ''}</button>`)}</div>${round.phase === 'revealing' ? html`<p class="text-sm mt-2">Adding the selected video to your queue…</p>` : ''}</section>`;
}

export function roulettePanel(round, owner) {
  const count = round.candidates.length;
  const slices = round.candidates.map((item, index) => {
    const angle = 360 / count, start = (index * angle - 90) * Math.PI / 180, end = ((index + 1) * angle - 90) * Math.PI / 180;
    const mid = (start + end) / 2;
    const degrees = (index + 0.5) * angle - 90;
    return { item, index, mid, rotation: degrees > 90 && degrees < 270 ? degrees - 180 : degrees, path: `M 100 100 L ${100 + 96 * Math.cos(start)} ${100 + 96 * Math.sin(start)} A 96 96 0 ${angle > 180 ? 1 : 0} 1 ${100 + 96 * Math.cos(end)} ${100 + 96 * Math.sin(end)} Z` };
  });
  return html`<section class="card bg-base-200 p-3 mb-2"><div class="flex gap-2 items-center"><h2 class="font-semibold">Video roulette</h2><span id="round-timer-label" class="text-xs ml-auto"></span>${round.started_by === owner ? html`<button data-action="round-cancel" class="btn btn-ghost btn-xs">Cancel</button>` : ''}</div>
    <div id="roulette-wheel" data-slices="${count}" class="flex flex-col items-center gap-2 select-none"><div class="relative w-full max-w-[26rem] aspect-square mx-auto">
      <svg viewBox="0 0 200 200" class="w-full h-full"><defs>${slices.map(slice => html`<clipPath id="wheel-clip-${slice.index}"><path d="${slice.path}" /></clipPath>`)}</defs>
      ${slices.map(({ item, index, mid, rotation, path }) => html`<g class="wheel-slice" data-slice-index="${index}"><path d="${path}" fill="${['#334155', '#475569', '#1e3a5f', '#4c1d95'][index % 4]}" stroke="#0f172a" stroke-width="0.5" />${mediaUrl(item.thumbnail_url) ? html`<image class="slice-thumb" data-slice-index="${index}" href="${mediaUrl(item.thumbnail_url)}" x="4" y="4" width="192" height="192" preserveAspectRatio="xMidYMid slice" clip-path="url(#wheel-clip-${index})" style="opacity:0" />` : ''}<path class="slice-dark" data-slice-index="${index}" d="${path}" fill="black" style="opacity:0" /><text class="slice-text" data-slice-index="${index}" x="${100 + 58 * Math.cos(mid)}" y="${100 + 58 * Math.sin(mid)}" text-anchor="middle" font-size="5" fill="white" transform="rotate(${rotation} ${100 + 58 * Math.cos(mid)} ${100 + 58 * Math.sin(mid)})" style="opacity:0">${(item.title || '').slice(0, 18)}</text><path class="slice-winner-outline" data-slice-index="${index}" d="${path}" fill="none" stroke="#facc15" stroke-width="2" style="opacity:0" /></g>`) }
      <circle cx="100" cy="100" r="18" fill="#0f172a" /><text x="100" y="104" text-anchor="middle" font-size="14">🎰</text><circle id="roulette-ball" cx="100" cy="4" r="6" fill="#facc15" stroke="#1e293b" stroke-width="1" style="opacity:0" /></svg>
      <div id="roulette-loading" class="absolute inset-0 flex flex-col items-center justify-center bg-base-200/70 rounded-full" style="opacity:1"><span class="loading loading-spinner loading-lg"></span><span>Loading candidates…</span></div>
      <div id="roulette-pie" class="absolute top-2 right-2 w-14 h-14 rounded-full flex items-center justify-center text-white" style="opacity:0;z-index:50;background:conic-gradient(#facc15 var(--byob-roulette-pie-angle,0deg),#0f172a 0)"><span id="roulette-pie-label">—</span></div>
      <div class="pointer-events-none absolute inset-0">${slices.map(({ item, index, mid }) => html`<div class="roulette-card absolute left-1/2 top-1/2 w-52 rounded-lg bg-base-200 shadow-xl border border-base-300 overflow-hidden" data-slice-index="${index}" data-target-x="${25 * Math.cos(mid)}" data-target-y="${25 * Math.sin(mid)}" style="opacity:0;transform:translate(-50%,-50%) scale(0.85)">${mediaUrl(item.thumbnail_url) ? html`<img src="${mediaUrl(item.thumbnail_url)}" alt="" class="w-full h-28 object-cover" />` : html`<div class="h-28 flex items-center justify-center bg-base-300">▶</div>`}<p class="p-2 text-xs">${item.title}</p></div>`)}</div>
    </div><p id="roulette-status" class="text-xs"></p><p id="roulette-winner-text" class="hidden text-sm font-semibold"></p></div></section>`;
}

function autoplayHelp() {
  return html`<dialog id="byob-autoplay-help" class="modal"><div class="modal-box max-w-md"><h3 class="font-bold mb-2">Enable playback for this room</h3><p class="text-sm mb-4">Your browser may require a click before it lets a video start. Click the player to join playback.</p><dl class="text-sm space-y-2"><dt class="font-semibold">Chrome / Edge</dt><dd>Click the player once. If sound stays blocked, check Site settings → Sound in the address bar.</dd><dt class="font-semibold">Firefox</dt><dd>Use the address-bar permissions menu → Autoplay → Allow Audio and Video.</dd><dt class="font-semibold">Safari on Mac</dt><dd>Safari → Settings for This Website → Auto-Play → Allow All Auto-Play.</dd></dl><div class="modal-action items-center justify-between"><label class="text-xs"><input type="checkbox" id="byob-autoplay-help-dont-show" class="checkbox checkbox-xs" /> Don't show this again</label><form method="dialog"><button class="btn btn-primary btn-sm">Got it</button></form></div></div><form method="dialog" class="modal-backdrop"><button>Close</button></form></dialog>`;
}
