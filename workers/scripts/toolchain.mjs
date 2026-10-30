import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, mkdir, rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';

export const tailwindVersion = '4.1.12';
// GitHub release asset digests for v4.1.12, also matching sha256sums.txt.
const digests = {
  'linux-arm64': '181332974fff1b3423ad75d6a2f1d09adf1ca63eb1324db0afbc4c30ff1ad086',
  'linux-arm64-musl': 'eaedd516e9885a02ca752833b8acbf378c463b89abc1bf00f307fe4f523e1e7f',
  'linux-x64': '5eeee66ea237eae9a160fa3314fd0cf76ab993551a99fafb16fa1db6c6b90289',
  'linux-x64-musl': 'a8a1926a2951a5da0684c568d612bc0a590600334d3a85d0e63ea90ac7ced2e5',
  'macos-arm64': '7d69be1776bbe8a49e15714d9873d08959c320aff0f0714d8d8e6d9d00d9b543',
  'macos-x64': 'fc935d51813442472c2e1b28582fec3df204379e53d5724937d516dd425af37c',
  'windows-x64.exe': '27e14fd9c0872281464da9c0991709e0f7cadedc60e4acfac371299246d54669',
};

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadVerified(url, expected, target, fetcher = fetch) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error(`Tool download failed: HTTP ${response.status}`);
    const hash = createHash('sha256');
    let size = 0;
    const verify = new Transform({ transform(chunk, _, callback) {
      size += chunk.length;
      if (size > 160 * 1024 * 1024) { callback(new Error('Tool download too large')); return; }
      hash.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (hash.digest('hex') !== expected) throw new Error('Tool checksum mismatch');
    await chmod(temporary, 0o755);
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

export async function tailwindBinary(root) {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform;
  const musl = platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
  const suffix = `${platform}-${process.arch}${musl ? '-musl' : ''}${platform === 'windows' ? '.exe' : ''}`;
  const expected = digests[suffix];
  if (!expected) throw new Error(`Unsupported Tailwind platform: ${suffix}`);
  const cached = join(root, 'workers/.cache/tailwind', tailwindVersion, `tailwindcss-${suffix}`);
  const candidates = process.env.TAILWIND_BIN ? [process.env.TAILWIND_BIN] : [join(root, `_build/tailwind-${suffix}`), cached];
  for (const path of candidates) {
    try { await access(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (await digest(path) !== expected) throw new Error(`Tailwind ${tailwindVersion} checksum mismatch: ${path}`);
    return path;
  }
  if (process.env.TAILWIND_BIN) throw new Error('TAILWIND_BIN does not exist');
  console.log(`Provisioning verified Tailwind ${tailwindVersion} (${suffix})`);
  await downloadVerified(`https://github.com/tailwindlabs/tailwindcss/releases/download/v${tailwindVersion}/tailwindcss-${suffix}`, expected, cached);
  return cached;
}
