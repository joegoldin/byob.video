import { readFileSync } from 'node:fs';
import { pbkdf2Sync, createHmac } from 'node:crypto';

export const legacyAuth = JSON.parse(readFileSync(new URL('../fixtures/legacy-auth.json', import.meta.url)));
export function legacyExport() {
  return JSON.parse(readFileSync(new URL('../fixtures/legacy-export.json', import.meta.url)));
}

// Refresh only the timestamped extension ticket for live runtime tests. The
// fixed 2023 ticket is checked byte-for-byte against the original serializer.
export function legacyExtensionTicket(now) {
  const binary = value => {
    const bytes = Buffer.from(value), size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    return Buffer.concat([Buffer.from([109]), size, bytes]);
  };
  let stamp = BigInt(Math.floor(now / 1000) * 1000);
  const bytes = [];
  while (stamp) { bytes.push(Number(stamp & 255n)); stamp >>= 8n; }
  const payload = Buffer.concat([Buffer.from([131, 104, 3, 104, 2]), binary('oldroom1'), binary(`${legacyAuth.owner}:tab1`),
    Buffer.from([110, bytes.length, 0, ...bytes, 98, 0, 1, 81, 128])]).toString('base64url');
  const message = `SFMyNTY.${payload}`;
  const key = pbkdf2Sync(legacyAuth.secret, 'extension', 1000, 32, 'sha256');
  return `${message}.${createHmac('sha256', key).update(message).digest('base64url')}`;
}
