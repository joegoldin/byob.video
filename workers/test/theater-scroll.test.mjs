import test from 'node:test';
import assert from 'node:assert/strict';
import { detentTarget } from '../web/theater-scroll.mjs';

test('desktop detent catches near approaches and overshoots but permits leaving in either direction', () => {
  assert.equal(detentTarget(220, 40, -110), 40);
  assert.equal(detentTarget(740, 40, -1200), 40);
  assert.equal(detentTarget(0, 40, 90), 40);
  assert.equal(detentTarget(740, 40, -100), null);
  assert.equal(detentTarget(40, 40, 90), null);
  assert.equal(detentTarget(40, 40, -100), null);
  assert.equal(detentTarget(220, 40, 110), null);
});

import { mountTheaterScroll } from '../web/theater-scroll.mjs';

function fixture() {
  class Element {}
  const listeners = new Map();
  const root = Object.assign(new Element(), { dataset: {}, classList: { contains: () => true } });
  const win = { innerWidth: 1280, innerHeight: 800, scrollY: 220, Element,
    getComputedStyle: element => ({ overflowY: element.overflowY || 'visible' }),
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
    scrollTo({ top }) { this.scrollY = top; },
  };
  const player = { getBoundingClientRect: () => ({ top: 40 - win.scrollY }) };
  const stop = mountTheaterScroll(root, player, { window: win });
  const wheel = overrides => {
    const event = { target: root, deltaY: -110, deltaMode: 0, prevented: false,
      preventDefault() { this.prevented = true; }, ...overrides };
    listeners.get('wheel')(event);
    return event;
  };
  return { root, win, listeners, stop, wheel, Element };
}

test('detent leaves mobile, browser zoom and nested panel scrolling untouched', () => {
  const f = fixture();
  try {
    f.win.innerWidth = 390;
    assert.equal(f.wheel().prevented, false);
    f.win.innerWidth = 1280;
    assert.equal(f.wheel({ ctrlKey: true }).prevented, false);
    const panel = Object.assign(new f.Element(), { parentElement: f.root, overflowY: 'auto', scrollTop: 200, scrollHeight: 1000, clientHeight: 100 });
    assert.equal(f.wheel({ target: panel }).prevented, false);
    assert.equal(f.win.scrollY, 220);
    assert.equal(f.wheel({ deltaMode: 1, deltaY: -7 }).prevented, true);
    assert.equal(f.win.scrollY, 40);
  } finally { f.stop(); }
  assert.equal(f.listeners.size, 0);
});

test('page-scroll fallback catches a provider iframe return without a parent wheel event', () => {
  const f = fixture();
  try {
    f.win.scrollY = 0;
    f.listeners.get('scroll')();
    assert.equal(f.win.scrollY, 40);
    assert.equal(f.root.dataset.theaterDetent, 'held');
  } finally { f.stop(); }
});
