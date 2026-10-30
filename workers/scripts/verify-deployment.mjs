import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const files = new Map(await Promise.all(['index.html', 'assets/app.js', 'assets/app.css'].map(async path => [path, digest(await readFile(new URL(`../dist/${path}`, import.meta.url)))])));
for (const origin of ['https://byob.video', 'https://www.byob.video']) {
  let verified = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
      assert.equal(health.status, 200);
      assert.equal((await health.json()).status, 'ok');
      for (const [path, expected] of files) {
        const response = await fetch(`${origin}/${path === 'index.html' ? '' : path}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        assert.equal(response.status, 200);
        assert.equal(digest(Buffer.from(await response.arrayBuffer())), expected, `Deployed ${path} does not match this build`);
      }
      verified = true;
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      // A completed upload can precede propagation to the serving edge.
      await setTimeout(5000);
    }
  }
  assert.ok(verified);
  console.log(`PASS: ${origin} health and exact HTML/JavaScript/CSS build hashes`);
}
