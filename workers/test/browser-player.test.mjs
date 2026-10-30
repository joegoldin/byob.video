import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

test('native player reconnect and initial seeks retain authoritative playback and rate', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'byob-player-'));
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  try {
    const output = join(temp, 'player.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../../assets/js/hooks/video_player.js', import.meta.url))], bundle: true, format: 'esm', outfile: output, logLevel: 'silent' });
    const { default: player } = await import(pathToFileURL(output));
    for (const native of [true, false]) {
      const events = [];
      const hook = { serverAuthoritativeReconnect: native, clockSync: { stop() {} }, pushEvent: (event, payload) => events.push([event, payload]),
        player: { getState: () => 'playing', getCurrentTime: () => 123 }, isReady: true };
      try {
        player.reconnected.call(hook);
        assert.equal(events[0][0], 'sync:ping');
        assert.equal(events.some(([event]) => event === 'video:play'), !native);
      } finally { hook.clockSync.stop(); }
    }
    const positions = [];
    player._applyPendingState.call({
      _pendingState: { play_state: 'playing', current_time: 10, server_time: 1000 },
      _roomRate: 2, clockSync: { serverNow: () => 3000 }, suppression: { suppress() {} },
      reconcile: { setServerState() {}, pauseFor() {}, start() {} },
      _seekTo: position => positions.push(position), _showSyncingOverlay() {}, _play() {}, _retryPlayOrShowOverlay() {},
    });
    assert.deepEqual(positions, [14], 'initial seek advances at the room rate, not at 1x');
    for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
      const resumed = [];
      player._onSyncPlay.call({
        userId: 'bob', _roomRate: rate, el: { querySelector: () => null },
        clockSync: { isReady: () => true, serverNow: () => 1250 },
        suppression: { suppress() {} }, _seekTo: position => resumed.push(position), _play() {},
        reconcile: { setServerState() {}, start() {} }, _retryPlayOrShowOverlay() {},
      }, { user_id: 'alice', time: 20, server_time: 1000 });
      assert.deepEqual(resumed, [20 + 0.25 * rate], `remote resume must compensate transit at ${rate}x`);
    }
    let reference;
    player._onSyncRate.call({
      userId: 'alice', clockSync: {}, _applyRoomRate() {},
      reconcile: { setServerState: (...args) => { reference = args; } },
    }, { rate: 2, current_time: 42, server_time: 3000, user_id: 'alice' });
    assert.equal(reference[0], 42);
    assert.equal(reference[1], 3000);
    assert.deepEqual(reference[3], { rate: 2 });
    const video = new EventTarget();
    video.currentTime = 20;
    video.style = {};
    video.playbackRate = 1;
    globalThis.document.createElement = () => video;
    const seeks = [];
    const direct = Object.assign(Object.create(player), {
      el: { appendChild() {} }, suppression: { isActive: () => true },
      _roomRate: 2, _signalLoaded() {}, _applyPendingState() {}, _startSeekDetector() {},
      clockSync: { serverNow: () => 3000 },
      reconcile: { setServerState() {}, pauseFor() {} },
      pushEvent: (event, payload) => seeks.push([event, payload]),
    });
    direct._loadDirectUrl('https://example.com/video.webm');
    video.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(video.playbackRate, 2, 'a freshly loaded direct player must restore the snapshot rate');
    video.dispatchEvent(new Event('seeked'));
    assert.deepEqual(seeks, [['video:seek', { position: 20 }]], 'a native seek immediately after pause must not be swallowed by pause suppression');
    direct.player.seek(30);
    video.dispatchEvent(new Event('seeked'));
    assert.equal(seeks.length, 1, 'a programmatic seek must not echo back to the room');
    assert.ok(direct._lastObservedL >= 1, 'native completion must record fast seek latency independently of user-command suppression');
    direct.player.seek(31);
    video.seeking = true;
    video.dispatchEvent(new Event('seeked'));
    video.seeking = false;
    video.dispatchEvent(new Event('seeked'));
    assert.equal(seeks.length, 1, 'a stale completion during the newer seek must not consume its ownership');
    video.currentTime = 40;
    video.dispatchEvent(new Event('seeked'));
    assert.deepEqual(seeks.at(-1), ['video:seek', { position: 40 }]);
    video.playbackRate = 1.5;
    video.dispatchEvent(new Event('ratechange'));
    assert.deepEqual(seeks.at(-1), ['video:rate', { rate: 1.5 }], 'native speed controls must synchronize without an external toolbar');
    const sent = seeks.length;
    direct._roomRate = 1;
    direct.player.setPlaybackRate(1);
    video.dispatchEvent(new Event('ratechange'));
    assert.equal(seeks.length, sent, 'canonical speed application must not echo');
    const originalInterval = globalThis.setInterval;
    try {
      const ticks = [];
      globalThis.setInterval = callback => { ticks.push(callback); return 0; };
      for (const sourceType of ['direct_url', 'youtube']) {
        const reports = [];
        const hook = {
          sourceType, lastKnownPosition: 0, _getCurrentTime: () => 20.4,
          player: { getState: () => 'playing', getDuration: () => 100 },
          suppression: { isActive: () => false }, clockSync: { serverNow: () => 3000 },
          reconcile: { setServerState() {}, pauseFor() {} },
          pushEvent: (...args) => reports.push(args),
        };
        ticks.length = 0;
        player._startSeekDetector.call(hook);
        ticks[0]();
        assert.equal(reports.length, sourceType === 'direct_url' ? 0 : 1, 'direct native events must not be duplicated by the polling fallback');
      }
    } finally { globalThis.setInterval = originalInterval; }
  } finally {
    globalThis.document = previousDocument;
    await rm(temp, { recursive: true, force: true });
  }
});
