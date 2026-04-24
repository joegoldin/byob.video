const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createDrmCommandSequencer,
  createOutboundPlayCoordinator,
  applyPauseAtPosition
} = require("../content_runtime.js");

function makeVideo({ paused = true, currentTime = 0 } = {}) {
  let _paused = paused;
  const ops = [];

  return {
    ops,
    get paused() {
      return _paused;
    },
    set paused(value) {
      _paused = value;
    },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value) {
      currentTime = value;
      ops.push(`seek:${value}`);
    },
    pause() {
      ops.push("pause");
      _paused = true;
    },
    play() {
      ops.push("play");
      _paused = false;
      return Promise.resolve();
    }
  };
}

function makeTimers() {
  let nextId = 1;
  let now = 0;
  const timers = new Map();

  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick(ms) {
      now += ms;
      const ready = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at);

      for (const [id, timer] of ready) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
}

test("drm queued play waits for matching seek before calling play", async () => {
  const video = makeVideo({ paused: true, currentTime: 100 });
  const timers = makeTimers();
  const sequencer = createDrmCommandSequencer({
    isDrmSite: true,
    settleDelayMs: 25,
    queueWindowMs: 200,
    shouldReleasePlay: () => true,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });

  const queued = sequencer.queuePlayIfNeeded(video, 400);
  assert.equal(queued, true);
  assert.deepEqual(video.ops, []);

  const consumed = sequencer.consumeMatchingSeek(video, 400, () => {
    video.currentTime = 400;
  });

  assert.equal(consumed, true);
  assert.deepEqual(video.ops, ["seek:400"]);

  timers.tick(24);
  assert.deepEqual(video.ops, ["seek:400"]);

  timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(video.ops, ["seek:400", "play"]);
});

test("drm matched seek waits for readiness before calling play", async () => {
  const video = makeVideo({ paused: true, currentTime: 100 });
  const timers = makeTimers();
  let ready = false;
  const sequencer = createDrmCommandSequencer({
    isDrmSite: true,
    settleDelayMs: 25,
    queueWindowMs: 200,
    releaseTimeoutMs: 5000,
    releasePollMs: 100,
    shouldReleasePlay: () => ready,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });

  assert.equal(sequencer.queuePlayIfNeeded(video, 400), true);
  assert.equal(sequencer.consumeMatchingSeek(video, 400, () => {
    video.currentTime = 400;
  }), true);

  timers.tick(25);
  await Promise.resolve();
  assert.deepEqual(video.ops, ["seek:400"]);

  timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(video.ops, ["seek:400"]);

  ready = true;
  timers.tick(100);
  await Promise.resolve();
  assert.deepEqual(video.ops, ["seek:400", "play"]);
});

test("drm matched seek falls back to play after readiness timeout", async () => {
  const video = makeVideo({ paused: true, currentTime: 100 });
  const timers = makeTimers();
  const sequencer = createDrmCommandSequencer({
    isDrmSite: true,
    settleDelayMs: 25,
    queueWindowMs: 200,
    releaseTimeoutMs: 5000,
    releasePollMs: 100,
    shouldReleasePlay: () => false,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });

  assert.equal(sequencer.queuePlayIfNeeded(video, 400), true);
  assert.equal(sequencer.consumeMatchingSeek(video, 400, () => {
    video.currentTime = 400;
  }), true);

  timers.tick(25);
  await Promise.resolve();
  assert.deepEqual(video.ops, ["seek:400"]);

  timers.tick(4900);
  await Promise.resolve();
  assert.deepEqual(video.ops, ["seek:400"]);

  timers.tick(100);
  await Promise.resolve();
  assert.deepEqual(video.ops, ["seek:400", "play"]);
});

test("drm queued play falls back to play when matching seek never arrives", async () => {
  const video = makeVideo({ paused: true, currentTime: 100 });
  const timers = makeTimers();
  const sequencer = createDrmCommandSequencer({
    isDrmSite: true,
    settleDelayMs: 25,
    queueWindowMs: 200,
    shouldReleasePlay: () => true,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });

  const queued = sequencer.queuePlayIfNeeded(video, 400);
  assert.equal(queued, true);

  timers.tick(199);
  assert.deepEqual(video.ops, []);

  timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(video.ops, ["play"]);
});

test("non-drm play stays immediate", async () => {
  const video = makeVideo({ paused: true, currentTime: 100 });
  const timers = makeTimers();
  const sequencer = createDrmCommandSequencer({
    isDrmSite: false,
    settleDelayMs: 25,
    queueWindowMs: 200,
    shouldReleasePlay: () => true,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });

  const queued = sequencer.queuePlayIfNeeded(video, 400);
  assert.equal(queued, false);
  assert.deepEqual(video.ops, []);
});

test("drm queued play can be forced even when already at target after a seek", async () => {
  const video = makeVideo({ paused: true, currentTime: 400 });
  const timers = makeTimers();
  const sequencer = createDrmCommandSequencer({
    isDrmSite: true,
    settleDelayMs: 25,
    queueWindowMs: 200,
    shouldReleasePlay: () => true,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });

  const queued = sequencer.queuePlayIfNeeded(video, 400, () => video.play(), { force: true });
  assert.equal(queued, true);
  assert.deepEqual(video.ops, []);

  timers.tick(199);
  assert.deepEqual(video.ops, []);

  timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(video.ops, ["play"]);
});

test("drm queued play can wait for readiness after a recent seek already reached target", async () => {
  const video = makeVideo({ paused: true, currentTime: 400 });
  const timers = makeTimers();
  let ready = false;
  const sequencer = createDrmCommandSequencer({
    isDrmSite: true,
    settleDelayMs: 25,
    queueWindowMs: 200,
    releaseTimeoutMs: 5000,
    releasePollMs: 100,
    shouldReleasePlay: () => ready,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });

  const queued = sequencer.queuePlayUntilReady(video, 400, () => video.play());
  assert.equal(queued, true);
  assert.deepEqual(video.ops, []);

  timers.tick(25);
  await Promise.resolve();
  assert.deepEqual(video.ops, []);

  timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(video.ops, []);

  ready = true;
  timers.tick(100);
  await Promise.resolve();
  assert.deepEqual(video.ops, ["play"]);
});

test("drm queued play reports timeout release reason", async () => {
  const video = makeVideo({ paused: true, currentTime: 400 });
  const timers = makeTimers();
  const releaseReasons = [];
  const sequencer = createDrmCommandSequencer({
    isDrmSite: true,
    settleDelayMs: 25,
    queueWindowMs: 200,
    releaseTimeoutMs: 5000,
    releasePollMs: 100,
    shouldReleasePlay: () => false,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });

  const queued = sequencer.queuePlayUntilReady(video, 400, (reason) => {
    releaseReasons.push(reason);
    return video.play();
  });
  assert.equal(queued, true);

  timers.tick(25);
  await Promise.resolve();
  assert.deepEqual(releaseReasons, []);

  timers.tick(5000);
  await Promise.resolve();
  assert.deepEqual(releaseReasons, ["ready-timeout"]);
  assert.deepEqual(video.ops, ["play"]);
});

test("drm outbound play defers and flushes after seek", () => {
  const timers = makeTimers();
  const sends = [];
  const coordinator = createOutboundPlayCoordinator({
    isDrmSite: true,
    delayMs: 200,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });

  assert.equal(coordinator.queue(344.75, (position) => {
    sends.push(`play:${position}`);
  }), true);

  assert.deepEqual(sends, []);
  assert.equal(coordinator.flush("seeked", 344.75), true);
  assert.deepEqual(sends, ["play:344.75"]);
});

test("drm outbound play falls back after short delay when no seek follows", () => {
  const timers = makeTimers();
  const sends = [];
  const coordinator = createOutboundPlayCoordinator({
    isDrmSite: true,
    delayMs: 200,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });

  assert.equal(coordinator.queue(292.208843, (position) => {
    sends.push(`play:${position}`);
  }), true);

  timers.tick(199);
  assert.deepEqual(sends, []);

  timers.tick(1);
  assert.deepEqual(sends, ["play:292.208843"]);
});

test("drm outbound play waits longer once seeking starts", () => {
  const timers = makeTimers();
  const sends = [];
  const coordinator = createOutboundPlayCoordinator({
    isDrmSite: true,
    delayMs: 200,
    seekDelayMs: 2500,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });

  assert.equal(coordinator.queue(474.25, (position) => {
    sends.push(`play:${position}`);
  }), true);

  timers.tick(150);
  assert.equal(coordinator.noteSeeking(474.25), true);

  timers.tick(100);
  assert.deepEqual(sends, []);

  timers.tick(2399);
  assert.deepEqual(sends, []);

  timers.tick(1);
  assert.deepEqual(sends, ["play:474.25"]);
});

test("pause command on a playing video seeks before pausing at target", () => {
  const video = makeVideo({ paused: false, currentTime: 346 });

  applyPauseAtPosition(video, 409.782562, {
    applySeek: (target) => {
      video.currentTime = target;
    }
  });

  assert.deepEqual(video.ops, ["seek:409.782562", "pause"]);
  assert.equal(video.paused, true);
});

test("pause command on an already paused video still seeks to target", () => {
  const video = makeVideo({ paused: true, currentTime: 346 });

  applyPauseAtPosition(video, 409.782562, {
    applySeek: (target) => {
      video.currentTime = target;
    }
  });

  assert.deepEqual(video.ops, ["seek:409.782562"]);
  assert.equal(video.paused, true);
});
