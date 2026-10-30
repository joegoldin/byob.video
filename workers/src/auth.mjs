const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('invalid_encoding');
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}

async function signingKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('A signing secret of at least 32 characters must be configured');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signToken(secret, claims) {
  const data = `v1.${encode(encoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(data));
  return `${data}.${encode(new Uint8Array(signature))}`;
}

export async function verifyToken(secret, token, purpose, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const key = await signingKey(secret);
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    if (!await crypto.subtle.verify('HMAC', key, decode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`))) return null;
    const claims = JSON.parse(decoder.decode(decode(parts[1])));
    if (!claims || claims.purpose !== purpose || !Number.isSafeInteger(claims.exp) || claims.exp <= now) return null;
    if (purpose === 'room' && (!/^[a-z0-9]{1,16}$/.test(claims.room ?? '') || !/^[A-Za-z0-9:_-]{1,128}$/.test(claims.owner ?? ''))) return null;
    return claims;
  } catch {
    return null;
  }
}
