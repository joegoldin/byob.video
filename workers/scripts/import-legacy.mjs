import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { legacyRoomState } from '../src/migration.mjs';

async function main() {
  const [path, endpoint, expectedHash] = process.argv.slice(2);
  if (!path || !endpoint || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('usage: import-legacy.mjs EXPORT_JSON MIGRATION_ORIGIN SHA256');
  const origin = new URL(endpoint);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw new Error('Invalid migration origin');
  const token = process.env.MIGRATION_TOKEN;
  if (!token || token.length < 32 || token.length > 256) throw new Error('Set MIGRATION_TOKEN to the temporary gateway secret');
  const file = await open(path, 'r');
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 128 * 1024 * 1024) throw new Error('Export must be a private regular file no larger than 128 MiB');
    bytes = await file.readFile();
  } finally { await file.close(); }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== expectedHash) throw new Error('Export checksum mismatch');
  let exported;
  try { exported = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid export JSON'); }
  if (exported?.format !== 'byob-legacy-export-v1' || !Array.isArray(exported.rooms) || !Array.isArray(exported.pool)) throw new Error('Unsupported export format');
  const seen = new Set();
  for (const room of exported.rooms) {
    legacyRoomState(room, Date.now());
    if (seen.has(room.room_id)) throw new Error('Duplicate room in export');
    seen.add(room.room_id);
  }
  async function send(path, body) {
    const response = await fetch(new URL(path, origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Import request failed with HTTP ${response.status}; rerun the same export after resolving the failure`);
    return response.json();
  }
  const result = { rooms_imported: 0, rooms_skipped: 0, pool_imported: 0, pool_skipped: 0, sha256: hash };
  for (const room of exported.rooms) {
    const reply = await send('/rooms', room);
    if (reply.imported === true) result.rooms_imported++;
    else if (reply.imported === false) result.rooms_skipped++;
    else throw new Error('Unexpected migration reply');
  }
  for (let index = 0; index < exported.pool.length; index += 100) {
    const reply = await send('/pool', { entries: exported.pool.slice(index, index + 100) });
    if (!Number.isSafeInteger(reply.imported) || !Number.isSafeInteger(reply.skipped)) throw new Error('Unexpected migration reply');
    result.pool_imported += reply.imported;
    result.pool_skipped += reply.skipped;
  }
  console.log(JSON.stringify(result));
}

main().catch(error => {
  // Never print the parsed export, request body, token, or remote error body.
  console.error(error.message);
  process.exitCode = 1;
});
