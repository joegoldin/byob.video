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
    direct.suppression.shouldSuppress = () => true;
    direct.reconcile.start = () => {};
    direct.reconcile.stop = () => {};
    video.paused = true;
    video.play = () => { video.paused = false; video.dispatchEvent(new Event('play')); return Promise.resolve(); };
    video.pause = () => { if (!video.paused) { video.paused = true; video.dispatchEvent(new Event('pause')); } };
    const controls = seeks.length;
    direct.player.play();
    direct.player.pause();
    assert.equal(seeks.length, controls, 'remote play/pause must not echo');
    await video.play();
    assert.equal(seeks.at(-1)[0], 'video:play', 'native resume immediately after remote pause must escape the old suppression window');
    video.pause();
    assert.equal(seeks.at(-1)[0], 'video:pause', 'native pause must not be swallowed by the prior remote command');
    direct.player.seek(40);
    const beforeResume = seeks.length;
    await video.play();
    assert.equal(seeks.length, beforeResume + 1, 'a pending programmatic seek must not own a native play action');
    assert.equal(seeks.at(-1)[0], 'video:play');
    video.dispatchEvent(new Event('seeked'));
    const originalTimeout = globalThis.setTimeout;
    try {
      const callbacks = [];
      globalThis.setTimeout = callback => { callbacks.push(callback); return 0; };
      let retries = 0;
      const pending = { sourceType: 'direct_url', expectedPlayState: 'playing', player: { getState: () => 'paused' }, suppression: { suppress() {} }, _play() { retries++; } };
      player._retryPlayOrShowOverlay.call(pending, 0);
      pending.expectedPlayState = 'paused';
      callbacks[0]();
      assert.equal(retries, 0, 'an old autoplay retry must not override a newer explicit pause');
    } finally { globalThis.setTimeout = originalTimeout; }
    const originalInterval = globalThis.setInterval;
    try {
      const ticks = [];
      globalThis.setInterval = callback => { ticks.push(callback); return 0; };
      for (const sourceType of ['direct_url', 'youtube']) {
        const reports = [];
        const hook = {
          sourceType, lastKnownPosition: 0, isReady: true, _playerSettled: true, _getCurrentTime: () => 20.4,
          player: { getState: () => 'playing', getDuration: () => 100 },
          suppression: { isActive: () => false }, clockSync: { serverNow: () => 3000 },
          reconcile: { setServerState() {}, pauseFor() {} },
          pushEvent: (...args) => reports.push(args),
        };
        ticks.length = 0;
        player._startSeekDetector.call(hook);
        ticks[0]();
        assert.equal(reports.length, 0, 'the first restored provider position is not a user seek');
        hook._getCurrentTime = () => 40;
        ticks[0]();
        assert.equal(reports.length, sourceType === 'direct_url' ? 0 : 1, 'a later inferred seek must still propagate without duplicating direct native events');
      }
    } finally { globalThis.setInterval = originalInterval; }
  } finally {
    globalThis.document = previousDocument;
    await rm(temp, { recursive: true, force: true });
  }
});

test('YouTube completion holds playback through delayed looping without broadcasting a seek or pause', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'byob-youtube-end-'));
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousInterval = globalThis.setInterval;
  globalThis.document = new EventTarget();
  globalThis.window = {};
  try {
    const output = join(temp, 'player.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../../assets/js/hooks/video_player.js', import.meta.url))], bundle: true, format: 'esm', outfile: output, logLevel: 'silent' });
    const { default: player } = await import(pathToFileURL(output));
    for (const detection of ['poll', 'event']) {
      const ticks = [], reports = [];
      let position = 19.5, state = 'playing', pauses = 0, suppressed = false;
      globalThis.setInterval = callback => { ticks.push(callback); return 0; };
      const hook = Object.assign(Object.create(player), {
        sourceType: 'youtube', _currentItemId: 'short', _playerSettled: true, isReady: true,
        el: { querySelector: () => null }, _hideLoadingOverlay() {}, _hideSyncingOverlay() {},
        expectedPlayState: 'playing', lastKnownPosition: 19,
        player: { getState: () => state, getCurrentTime: () => position, getDuration: () => 20 },
        _getCurrentTime: () => position,
        _pause() { pauses++; state = 'paused'; this._onPlayerStateChange('paused'); },
        suppression: { isActive: () => false, suppress() { suppressed = true; }, shouldSuppress(name) { if (name === 'paused' && suppressed) { suppressed = false; return true; } return false; } },
        reconcile: { stop() {}, setServerState() {}, pauseFor() {}, start() {} },
        clockSync: { serverNow: () => 3000 },
        pushEvent: (...args) => reports.push(args),
      });
      hook._startSeekDetector();
      if (detection === 'poll') ticks[0]();
      else { state = 'ended'; hook._onPlayerStateChange('ended'); }
      assert.deepEqual(reports, [['video:ended', { item_id: 'short' }]]);
      if (detection === 'poll') {
        assert.equal(pauses, 0, 'near-end detection must not cut off the final half-second');
        position = 19.9;
        ticks[0]();
        assert.equal(pauses, 0, 'the final frames must keep playing while completion is latched');
      }
      // YouTube can restart after the old 500ms guard, with polling seeing
      // the wrap before its PLAYING callback arrives.
      hook._endedAt = Date.now() - 2000;
      position = 0.2;
      state = 'playing';
      ticks[0]();
      hook._onPlayerStateChange('playing');
      assert.equal(state, 'paused', 'automatic replay must be stopped even after 500ms');
      assert.equal(hook._endedFired, true, 'looping back to zero is not a user seek');
      assert.equal(hook.expectedPlayState, null);
      ticks[0]();
      assert.equal(hook._endedFired, true, 'a later paused poll must retain completion');
      assert.deepEqual(reports, [['video:ended', { item_id: 'short' }]], 'automatic replay must not cancel queue advancement');
      hook.el = { querySelector: () => null };
      hook._onSyncPlay({ user_id: hook.userId });
      assert.equal(hook._endedFired, false, 'an explicit room play must release the end hold');
      hook._endedFired = true;
      hook._showLoadingOverlay = () => {};
      hook.reconcile.resetOffset = () => {};
      hook._loadYouTube = () => {};
      await hook._loadVideo('youtube', 'next-short', null, { id: 'next' });
      clearTimeout(hook._startupRecoveryTimer);
      assert.equal(hook._endedFired, false, 'a new item must release completion even without player reuse');
    }
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.setInterval = previousInterval;
    await rm(temp, { recursive: true, force: true });
  }
});

test('YouTube correction ownership outlives event suppression and buffering samples', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'byob-seek-ownership-'));
  const previousDocument = globalThis.document;
  const previousInterval = globalThis.setInterval;
  globalThis.document = new EventTarget();
  try {
    const output = join(temp, 'player.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../../assets/js/hooks/video_player.js', import.meta.url))], bundle: true, format: 'esm', outfile: output, logLevel: 'silent' });
    const { default: player } = await import(pathToFileURL(output));
    const ticks = [], reports = [];
    let position = 649.2, state = 'playing', suppressed = false;
    globalThis.setInterval = callback => { ticks.push(callback); return 0; };
    const hook = Object.assign(Object.create(player), {
      sourceType: 'youtube', lastKnownPosition: position, isReady: true, _playerSettled: true,
      player: { getCurrentTime: () => position, getState: () => state, getDuration: () => 1800, seek() {} },
      suppression: { isActive: () => suppressed }, clockSync: { serverNow: () => 1000 },
      reconcile: { setServerState() {}, pauseFor() {} },
      pushEvent: (...args) => reports.push(args),
    });
    hook._startSeekDetector();
    ticks[0]();
    hook._seekTo(650);
    // The player can expose its reset position while a correction buffers.
    // State-event suppression may already have settled before the next poll.
    position = 0.4;
    state = 'buffering';
    ticks[0]();
    assert.deepEqual(reports, [], 'a buffering position is not a user seek');
    state = 'playing';
    ticks[0]();
    assert.deepEqual(reports, [], 'the first stable correction sample must not become a room seek');
    position = 0.9;
    ticks[0]();
    assert.deepEqual(reports, []);
    position = 650.5;
    ticks[0]();
    assert.deepEqual(reports, [], 'the delayed correction landing must also remain local');
    position = 710;
    ticks[0]();
    assert.deepEqual(reports, [['video:seek', { position: 710 }]], 'a later native user seek must still propagate');
    // Ownership must cover paused corrections too, which produce no PLAYING.
    reports.length = 0;
    state = 'paused';
    hook._seekTo(800);
    suppressed = true;
    position = 800;
    ticks[0]();
    assert.ok(hook._programmaticSeek, 'matching an early sample must not release an unsettled correction');
    suppressed = false;
    ticks[0]();
    assert.deepEqual(reports, [], 'a paused correction must not echo after suppression expires');
    position = 0.4;
    ticks[0]();
    assert.deepEqual(reports, [['video:seek', { position: 0.4 }]], 'intentional seeks to the start remain supported');
    reports.length = 0;
    state = 'buffering';
    position = 900;
    ticks[0]();
    assert.deepEqual(reports, [], 'buffering without a correction must not broadcast intermediate positions');
    state = 'playing';
    ticks[0]();
    assert.deepEqual(reports, [['video:seek', { position: 900 }]], 'a user scrub through buffering must still broadcast when stable');
    reports.length = 0;
    hook._seekTo(1000);
    hook._programmaticSeek.issuedAt -= 3100;
    ticks[0]();
    assert.deepEqual(reports, [], 'a failed correction must rebase without echoing');
    position = 950;
    ticks[0]();
    assert.deepEqual(reports, [['video:seek', { position: 950 }]], 'a failed correction must not permanently disable user seeks');
    reports.length = 0;
    hook.player.play = () => { position = 1; };
    hook._play();
    ticks[0]();
    assert.deepEqual(reports, [], 'a programmatic play that restarts a stuck provider must not become a user seek');
  } finally {
    globalThis.document = previousDocument;
    globalThis.setInterval = previousInterval;
    await rm(temp, { recursive: true, force: true });
  }
});

test('startup recovery does not mistake a settled pause or endless buffering for playback', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'byob-startup-'));
  const previousDocument = globalThis.document;
  const previousTimeout = globalThis.setTimeout;
  globalThis.document = new EventTarget();
  try {
    const output = join(temp, 'player.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../../assets/js/hooks/video_player.js', import.meta.url))], bundle: true, format: 'esm', outfile: output, logLevel: 'silent' });
    const { default: player } = await import(pathToFileURL(output));
    for (const state of ['paused', 'buffering']) {
      const callbacks = [], overlays = [], controls = [];
      globalThis.setTimeout = callback => { callbacks.push(callback); return callbacks.length; };
      let retries = 0;
      const hook = Object.assign(Object.create(player), {
        sourceType: 'youtube', _playerSettled: true, expectedPlayState: 'playing',
        player: { getState: () => state }, suppression: { suppress() {} },
        _play() { retries++; }, _showClickToPlay: position => overlays.push(position),
        pushEvent: (...args) => controls.push(args),
      });
      player._retryPlayOrShowOverlay.call(hook, 600);
      while (callbacks.length) callbacks.shift()();
      assert.equal(retries, 2, `${state} must receive bounded local play retries even if marked settled`);
      assert.deepEqual(overlays, [600], `${state} must expose recovery when playback never starts`);
      assert.deepEqual(controls, [], 'startup retries must never send room playback controls');
    }
  } finally {
    globalThis.document = previousDocument;
    globalThis.setTimeout = previousTimeout;
    await rm(temp, { recursive: true, force: true });
  }
});

test('startup watchdog offers recovery even when the provider never calls onReady and ignores replaced loads', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'byob-init-timeout-'));
  const previousDocument = globalThis.document, previousTimeout = globalThis.setTimeout;
  globalThis.document = new EventTarget();
  try {
    const output = join(temp, 'player.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../../assets/js/hooks/video_player.js', import.meta.url))], bundle: true, format: 'esm', outfile: output, logLevel: 'silent' });
    const { default: player } = await import(pathToFileURL(output));
    const callbacks = [], recovery = [];
    globalThis.setTimeout = callback => { callbacks.push(callback); return callbacks.length; };
    const hook = Object.assign(Object.create(player), {
      isReady: false, _roomRate: 2, _pendingState: { play_state: 'playing', current_time: 600, server_time: 1000 },
      clockSync: { isReady: () => true, serverNow: () => 3000 }, reconcile: { resetOffset() {} },
      _showLoadingOverlay() {}, _showClickToPlay: position => recovery.push(position),
      _loadYouTube: () => new Promise(() => {}),
    });
    void hook._loadVideo('youtube', 'first', '', { id: 'first' });
    const oldTimeout = callbacks.shift();
    void hook._loadVideo('youtube', 'second', '', { id: 'second' });
    oldTimeout();
    assert.deepEqual(recovery, [], 'a previous video must not install recovery over a new load');
    callbacks.shift()();
    assert.deepEqual(recovery, [604], 'a hung provider must expose recovery at the current canonical position');
    recovery.length = 0;
    hook._loadYouTube = async () => { throw new Error('provider setup failed'); };
    await hook._loadVideo('youtube', 'third', '', { id: 'third' });
    assert.deepEqual(recovery, [604], 'a rejected initialization must expose recovery without an unhandled rejection');
    assert.equal(hook.isReady, false);
  } finally {
    globalThis.document = previousDocument;
    globalThis.setTimeout = previousTimeout;
    await rm(temp, { recursive: true, force: true });
  }
});

test('startup retries require timeline progress and stop when playback is replaced or explicitly paused', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'byob-play-progress-'));
  const previousDocument = globalThis.document, previousTimeout = globalThis.setTimeout;
  globalThis.document = new EventTarget();
  try {
    const output = join(temp, 'player.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../../assets/js/hooks/video_player.js', import.meta.url))], bundle: true, format: 'esm', outfile: output, logLevel: 'silent' });
    const { default: player } = await import(pathToFileURL(output));
    for (const behavior of ['frozen', 'progressing', 'replaced', 'paused']) {
      const callbacks = [], overlays = [];
      globalThis.setTimeout = callback => { callbacks.push(callback); return callbacks.length; };
      let position = 600, retries = 0;
      const hook = Object.assign(Object.create(player), {
        expectedPlayState: 'playing', player: { getState: () => 'playing', getCurrentTime: () => position },
        suppression: { suppress() {} }, _play() { retries++; }, _showClickToPlay: position => overlays.push(position),
      });
      hook._retryPlayOrShowOverlay(600);
      if (behavior === 'progressing') position += 0.5;
      if (behavior === 'replaced') hook.player = { getState: () => 'paused' };
      if (behavior === 'paused') hook.expectedPlayState = 'paused';
      while (callbacks.length) callbacks.shift()();
      assert.equal(retries, behavior === 'frozen' ? 2 : 0, behavior);
      assert.deepEqual(overlays, behavior === 'frozen' ? [600] : [], behavior);
    }
  } finally {
    globalThis.document = previousDocument;
    globalThis.setTimeout = previousTimeout;
    await rm(temp, { recursive: true, force: true });
  }
});
