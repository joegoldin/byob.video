import test from 'node:test';
import assert from 'node:assert/strict';
import { watchDeployment } from '../web/deployment.mjs';

const oldBuild = 'a'.repeat(64), newBuild = 'b'.repeat(64);
function fixture(storage = new Map()) {
  const window = new EventTarget(), document = new EventTarget();
  document.hidden = false;
  const requests = [], reloads = [], intervals = [];
  let response = { ok: true, json: async () => ({ build: oldBuild }) };
  const options = {
    build: oldBuild, window, document,
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    reload: () => reloads.push(true),
    fetch: async (url, init) => { requests.push({ url, init }); if (response instanceof Error) throw response; return response; },
    setInterval: callback => { intervals.push(callback); return 1; }, clearInterval: id => intervals.push(['cleared', id]),
  };
  return { options, storage, requests, reloads, intervals, window, document, setResponse(value) { response = value; } };
}

test('changed deployments reload once without touching guest identity or looping on stale assets', async () => {
  const f = fixture(new Map([['byob_tab_id', 'guest-tab'], ['watchparty_username', 'Guest 7344']]));
  const watcher = watchDeployment(f.options);
  try {
    await watcher.check();
    assert.equal(f.reloads.length, 0);
    f.setResponse({ ok: true, json: async () => ({ build: newBuild }) });
    await watcher.check();
    assert.equal(f.reloads.length, 1, 'a different deployed build must reload');
    assert.equal(f.requests.at(-1).init.cache, 'no-store');
    assert.equal(f.requests.at(-1).init.redirect, 'error');
    assert.equal(f.storage.get('byob_tab_id'), 'guest-tab');
    assert.equal(f.storage.get('watchparty_username'), 'Guest 7344');
    await watcher.check();
    assert.equal(f.reloads.length, 1);
    const stale = watchDeployment(f.options);
    try { await stale.check(); assert.equal(f.reloads.length, 1, 'a stale page after reload must not reload-loop'); }
    finally { stale.stop(); }
    const upgraded = watchDeployment({ ...f.options, build: newBuild });
    try { await upgraded.check(); assert.equal(f.reloads.length, 1); }
    finally { upgraded.stop(); }
  } finally { watcher.stop(); }
});

test('outages, redirects, invalid manifests and unavailable reload guards leave playback alone', async () => {
  const f = fixture();
  const watcher = watchDeployment(f.options);
  try {
    for (const response of [new Error('offline'), { ok: false }, { ok: true, json: async () => { throw new Error('HTML fallback'); } }, { ok: true, json: async () => ({}) }, { ok: true, json: async () => ({ build: 'untrusted' }) }]) {
      f.setResponse(response);
      await watcher.check();
      assert.equal(f.reloads.length, 0);
    }
    f.setResponse({ ok: true, json: async () => ({ build: newBuild }) });
    const blocked = watchDeployment({ ...f.options, storage: { getItem() { throw new Error('denied'); } } });
    try { await blocked.check(); assert.equal(f.reloads.length, 0, 'without a persistent loop guard do not reload repeatedly'); }
    finally { blocked.stop(); }
  } finally { watcher.stop(); }
});

test('connected rooms check periodically and returning tabs check promptly; cleanup removes listeners', async () => {
  const f = fixture();
  const watcher = watchDeployment(f.options);
  await watcher.check();
  const initial = f.requests.length;
  f.document.hidden = true;
  f.document.dispatchEvent(new Event('visibilitychange'));
  await watcher.check();
  assert.equal(f.requests.length, initial + 1, 'explicit reconnect checks still run while hidden');
  f.document.hidden = false;
  f.document.dispatchEvent(new Event('visibilitychange'));
  await watcher.check();
  assert.equal(f.requests.length, initial + 2);
  f.window.dispatchEvent(new Event('online'));
  await watcher.check();
  assert.equal(f.requests.length, initial + 3);
  f.intervals[0]();
  await watcher.check();
  assert.equal(f.requests.length, initial + 4);
  watcher.stop();
  f.window.dispatchEvent(new Event('online'));
  f.document.dispatchEvent(new Event('visibilitychange'));
  await watcher.check();
  assert.equal(f.requests.length, initial + 4);
});
