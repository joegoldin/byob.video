import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../extension/content.js', import.meta.url), 'utf8');
function contentFunction(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `Missing content function ${name}`);
  const end = source.indexOf('\n  }', start);
  assert.ok(end > start);
  return source.slice(start, end + 4);
}

// Execute the shipped helpers and measurement loop, not a second implementation
// of their arithmetic. Full injected-script/DOM behavior is a browser-suite gate.
function content() {
  const messages = [], timers = new Map();
  let tick, nextTimer = 0;
  const context = vm.createContext({
    State: { PLAYING: 'playing', PAUSED: 'paused' }, EVT: { VIDEO_DRIFT: 'video:drift', VIDEO_RATE: 'video:rate', SYNC_SEEK_COMMAND: 'sync:seek_command' },
    roomRate: 1, rateChangeTimer: null, serverRef: null,
    hookedVideo: { currentTime: 10, playbackRate: 1, paused: false },
    synced: true, needsGesture: false, commandGuard: null, isLive: false, expectedPlayState: 'playing',
    clockSynced: true, clockOffset: 0, reconcileInterval: null, RECONCILE_TICK_MS: 500,
    _mismatchSince: 0, _lastSeekExecutedAt: 0, _POST_SEEK_QUIET_MS: 5000,
    _jitterSamples: 0, _lastDriftMs: 0, _jitterEmaMs: 0, _JITTER_ALPHA: 0.1, _lastObservedL: 0,
    _log() {}, updateSyncBarStatus() {}, CMD_SEEK_COMMAND_GUARD_MS: 1000,
    _seekIssuedAt: 0, lastSeekAt: 0,
    seekTo(position) { context.hookedVideo.currentTime = position; },
    sampleLiveStatus() {}, Date: { now: () => 3000 }, port: { postMessage: message => messages.push(message) },
    setInterval(callback) { tick = callback; return 1; }, clearInterval() {},
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout(id) { timers.delete(id); },
  });
  for (const name of ['updateServerRef', 'applyPlaybackRate', 'stopReconcile', 'startReconcile', 'onVideoRateChange', 'handleSWMessage']) vm.runInContext(contentFunction(name), context);
  return { messages, timers, run: code => vm.runInContext(code, context), tick: () => tick() };
}

test('extension applies canonical rates and reports zero drift for correctly paced video', () => {
  for (const rate of [0.25, 0.5, 1, 1.5, 2]) {
    const page = content();
    page.run(`updateServerRef(10, State.PLAYING, 1000); applyPlaybackRate(${rate}, 1000, 10); hookedVideo.currentTime = ${10 + 2 * rate}; startReconcile();`);
    assert.equal(page.run('hookedVideo.playbackRate'), rate, 'starting reconcile must not reset speed');
    page.tick();
    assert.equal(page.messages[0].drift, 0, `rate ${rate}`);
  }
});

test('extension distinguishes local rate choices from server echoes and preserves rate anchors', () => {
  const page = content();
  page.run('updateServerRef(10, State.PLAYING, 1000); applyPlaybackRate(2, 2000); onVideoRateChange();');
  assert.equal(page.run('serverRef.position'), 11);
  assert.equal(page.timers.size, 0, 'applying a server rate must not echo it back');
  page.run('hookedVideo.playbackRate = 1.5; onVideoRateChange();');
  assert.equal(page.timers.size, 1);
  [...page.timers.values()][0]();
  assert.equal(page.messages[0].type, 'video:rate');
  assert.equal(page.messages[0].rate, 1.5);
  page.run('applyPlaybackRate(0.5, 3000, 42);');
  assert.equal(page.run('serverRef.position'), 42);
  assert.equal(page.run('serverRef.rate'), 0.5);
});

test('paused extension seek commands preserve the exact stationary target', () => {
  const page = content();
  page.run("expectedPlayState = State.PAUSED; handleSWMessage({ type: EVT.SYNC_SEEK_COMMAND, position: 20, server_time: 2750 });");
  assert.equal(page.run('hookedVideo.currentTime'), 20);
});
