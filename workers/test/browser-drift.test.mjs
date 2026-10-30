import test from 'node:test';
import assert from 'node:assert/strict';
import { Reconcile } from '../../assets/js/sync/reconcile.js';

test('browser drift follows the playback rate between server anchors', () => {
  for (const rate of [0.25, 0.5, 1, 1.5, 2]) {
    const reconcile = new Reconcile({ getCurrentTime: () => 10 + 2 * rate });
    reconcile.setServerState(10, 1000, { isReady: () => true, serverNow: () => 3000 }, { rate });
    assert.equal(reconcile.measureDriftMs(), 0, `rate ${rate}`);
    reconcile._tick();
    assert.equal(reconcile.getReport().driftMs, 0, `tick rate ${rate}`);
  }
});

test('changing speed preserves the playhead at the rate-change timestamp', () => {
  const reconcile = new Reconcile({ getCurrentTime: () => 15 });
  reconcile.setServerState(10, 1000, { isReady: () => true, serverNow: () => 4000 });
  reconcile.setPlaybackRate(2, 2000);
  assert.equal(reconcile.serverPosition, 11);
  assert.equal(reconcile.measureDriftMs(), 0);
});

test('playing seek commands scale transport time by the canonical room rate', () => {
  for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
    const positions = [];
    const reconcile = new Reconcile({ seekTo: position => positions.push(position) });
    reconcile.setServerState(20, 1000, { isReady: () => true, serverNow: () => 1250 }, { rate });
    reconcile.executeSeek(20, 1000, 'playing');
    assert.deepEqual(positions, [20 + 0.25 * rate], `rate ${rate}`);
  }
});

test('paused seek commands do not advance the target during transport', () => {
  const positions = [];
  const reconcile = new Reconcile({ seekTo: position => positions.push(position) });
  reconcile.setServerState(20, 1000, { isReady: () => true, serverNow: () => 1250 });
  reconcile.executeSeek(20, 1000, 'paused');
  assert.deepEqual(positions, [20]);
});
