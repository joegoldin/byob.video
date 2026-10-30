import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVerified } from '../scripts/toolchain.mjs';

const bytes = 'fixture executable';
const checksum = createHash('sha256').update(bytes).digest('hex');

test('tool provisioning verifies bytes before publishing an executable and cleans partial downloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'byob-toolchain-'));
  const target = join(directory, 'tool');
  try {
    await downloadVerified('https://fixture.test/tool', checksum, target, async () => new Response(bytes));
    assert.equal(await readFile(target, 'utf8'), bytes);
    assert.equal((await stat(target)).mode & 0o777, 0o755);
    await writeFile(target, 'keep existing');
    await assert.rejects(downloadVerified('https://fixture.test/tool', checksum, target, async () => new Response('corrupt')), /checksum mismatch/);
    assert.equal(await readFile(target, 'utf8'), 'keep existing');
    assert.deepEqual(await readdir(directory), ['tool']);
    await assert.rejects(downloadVerified('https://fixture.test/tool', checksum, target, async () => new Response('', { status: 503 })), /HTTP 503/);
    assert.deepEqual(await readdir(directory), ['tool']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
