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
