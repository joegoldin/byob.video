import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function readJson(path) {
  try { return JSON.parse(await readFile(join(root, path), 'utf8')); }
  catch (cause) { throw new Error(`Cannot read valid JSON: ${path}`, { cause }); }
}
async function check(directory) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (/\.(?:m?js)$/.test(entry.name)) execFileSync(process.execPath, ['--check', join(root, path)], { stdio: 'inherit' });
    else if (entry.name.endsWith('.json')) await readJson(path);
  }
}
try {
  for (const directory of ['workers/src', 'workers/web', 'workers/scripts', 'workers/test', 'assets/js', 'extension', 'test/extension']) await check(directory);
  const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  for (const path of ['workers/package.json', 'extension/manifest.json', 'extension/manifest.firefox.json']) {
    assert.equal((await readJson(path)).version, version, `${path} must match VERSION`);
  }
  // The extension cannot import node_modules at runtime; keep its standalone
  // channel client identical to the version pinned in the package lock.
  assert.deepEqual(await readFile(join(root, 'extension/lib/phoenix.mjs')),
    await readFile(new URL(import.meta.resolve('phoenix'))), 'Refresh the vendored extension channel client after updating phoenix');
  console.log('PASS: JavaScript syntax, JSON, release versions and locked extension client');
} catch (error) {
  console.error('Source check failed:', error.message);
  process.exitCode = 1;
}
