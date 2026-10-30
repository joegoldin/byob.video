import test from 'node:test';
import assert from 'node:assert/strict';
import * as views from '../web/views.mjs';
import { newRoom } from '../src/room-state.mjs';

test('room views retain stable player and panel mounts without embedding credentials', () => {
  const shell = String(views.roomShell('abc123'));
  for (const id of ['player', 'player-sizer', 'queue-panel', 'comments-panel', 'round-panel', 'settings-modal']) assert.ok(shell.includes(`id="${id}"`));
  const state = newRoom('abc123', 1000);
  assert.equal(String(views.settingsPanel(state, true)).includes(state.api_key), false);
  assert.ok(String(views.home()).includes('data-action="create-room"'));
});

test('queue, comments, previews and voting escape user-controlled content', () => {
  const dangerous = '<img src=x onerror=alert(1)>';
  const item = { id: 'one', external_id: 'one', title: dangerous, url: 'https://example.com/video.webm', added_by_name: dangerous };
  const state = { queue: [item], current_index: 0 };
  const fragments = [views.queuePanel(state), views.historyPanel([{ item }]),
    views.commentsPanel({ comments: [{ text: `${dangerous} 1:23`, author: dangerous, likes: 0, reply_count: 0 }] }),
    views.previewPanel({ resolved_url: item.url, preview: { source_type: 'direct_url', title: dangerous } }),
    views.votingPanel({ candidates: [item], mode: 'voting', phase: 'active', tallies: {}, started_by: 'alice' }, 'alice')];
  for (const fragment of fragments) { assert.equal(String(fragment).includes(dangerous), false); assert.ok(String(fragment).includes('&lt;img')); }
  assert.ok(String(fragments[2]).includes('data-seconds="83"'));
});

test('roulette view supplies the legacy animation hook with stable slice and overlay targets', () => {
  const markup = String(views.roulettePanel({ started_by: 'alice', candidates: Array.from({ length: 12 }, (_, index) => ({ external_id: String(index), title: '<script>bad</script>' })) }, 'alice'));
  for (const id of ['roulette-wheel', 'roulette-ball', 'roulette-loading', 'roulette-pie', 'roulette-pie-label', 'roulette-status', 'roulette-winner-text']) assert.ok(markup.includes(`id="${id}"`));
  assert.equal(markup.includes('<script>'), false);
  assert.equal((markup.match(/class="slice-winner-outline"/g) || []).length, 12);
  assert.equal(markup.includes('NaN'), false);
});

test('room preserves compact legacy navigation and expanded activity without duplicate player controls', () => {
  const shell = String(views.roomShell('abc123'));
  assert.ok(shell.includes('id="url-preview" class="absolute'));
  assert.ok(shell.includes('max-w-[40vw]'));
  assert.ok(shell.includes('aria-label="Settings"'));
  assert.ok(shell.includes('id="activity-panel" class="max-h-32 overflow-y-auto'));
  assert.equal(shell.includes('<summary class="cursor-pointer text-sm">Activity'), false);
  for (const action of ['play', 'pause', 'restart', 'skip', 'toggle-comments']) assert.equal(shell.includes(`data-action="${action}"`), false);
});

test('settings retain branded compact layout, named colored categories and comments toggle', () => {
  const settings = String(views.settingsPanel(newRoom('abc123', 1000), true));
  assert.ok(settings.includes('/images/logo.svg'));
  assert.ok(settings.includes('toggle toggle-sm toggle-primary'));
  assert.ok(settings.includes('Filler/Tangent'));
  assert.ok(settings.includes('Self Promotion'));
  assert.ok(settings.includes('Settings apply to this room for all users.'));
  assert.ok(settings.includes('type="password"'), 'retain private credential masking');
});

test('connected presence uses the original green dot and identifies the current user', () => {
  const users = String(views.usersPanel({ alice: { username: 'Alice', connected: true } }, 'alice'));
  assert.ok(users.includes('bg-success'));
  assert.ok(users.includes('(you)'));
  assert.ok(users.includes('Users'));
});

test('activity is chronological, readable and escaped for the expanded scroll box', () => {
  const log = String(views.activityPanel([
    { action: 'pause', user: 'Alice', detail: '<script>bad</script>', at: '2026-01-01T00:00:02Z' },
    { action: 'joined', user: 'Alice', at: '2026-01-01T00:00:01Z' },
  ]));
  assert.ok(log.indexOf('Alice joined') < log.indexOf('Alice paused'));
  assert.ok(log.includes('datetime="2026-01-01T00:00:02Z"'));
  assert.equal(log.includes('<script>'), false);
});

test('optional preview and comment failures have local context and preserve video actions', () => {
  const preview = String(views.previewPanel({ error: 'metadata_unavailable', resolved_url: 'https://video.test/movie.mp4' }));
  assert.ok(preview.includes('Preview unavailable: metadata unavailable'));
  assert.ok(preview.includes('value="now"'));
  assert.ok(preview.includes('value="queue"'));
  const comments = String(views.commentsPanel({ comments: [], error: 'comments_disabled' }));
  assert.ok(comments.includes('Comments unavailable: comments disabled'));
});

test('preview actions share the title row and align on the right', () => {
  const preview = String(views.previewPanel({ preview: { title: 'Video', source_type: 'youtube' } }));
  assert.ok(preview.includes('data-preview-row'));
  assert.ok(preview.includes('ml-auto shrink-0'));
  assert.equal(preview.includes('px-3 pb-3'), false);
});

test('queue and history expose original context-menu actions with escaped URLs', () => {
  const item = { id: 'a', url: 'https://video.test/<script>', title: 'Video' };
  assert.ok(String(views.queuePanel({ queue: [item], current_index: 0 })).includes('data-context-kind="queue"'));
  assert.ok(String(views.historyPanel([{ item }])).includes('data-context-kind="history"'));
  const current = String(views.contextMenu(item, { current: true, index: 0 }));
  assert.ok(current.includes('Restart'));
  assert.equal(current.includes('Remove from Queue'), false);
  const queued = String(views.contextMenu(item, { index: 1 }));
  assert.ok(queued.includes('Play Now') && queued.includes('Remove from Queue'));
  const history = String(views.contextMenu(item, { history: true }));
  assert.ok(history.includes('Add to Queue') && history.includes('Copy URL'));
  assert.equal(history.includes('<script>'), false);
});
