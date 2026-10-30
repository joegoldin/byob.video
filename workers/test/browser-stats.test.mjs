import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('statistics chart treats peer names as text, not HTML', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'byob-stats-'));
  const previous = globalThis.document;
  const chart = {};
  globalThis.document = { querySelector: () => null, getElementById: id => id === 'byob-local-sync-chart' ? chart : null };
  try {
    const output = join(temp, 'stats.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../../assets/js/hooks/stats_panel.js', import.meta.url))], bundle: true, format: 'esm', outfile: output });
    const { default: definition } = await import(pathToFileURL(output));
    const hook = { ...definition, el: { dataset: { byobLocalUserId: 'alice' } }, handleEvent() {} };
    hook.mounted();
    hook._onSample({ key: 'alice:browser', user_id: 'alice', username: '<img src=x onerror=alert(1)>', drift_ms: 20 });
    assert.equal(chart.innerHTML.includes('<img'), false);
    assert.ok(chart.innerHTML.includes('&lt;img'));
    hook.destroyed();
  } finally { globalThis.document = previous; await rm(temp, { recursive: true, force: true }); }
});
