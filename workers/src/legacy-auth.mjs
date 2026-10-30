const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function decode(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('invalid_encoding');
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}

// Only the small ETF subset emitted by the session/extension serializers is
// accepted. No compressed terms, executable terms, references or arbitrary atoms.
function term(bytes) {
  let offset = 0, nodes = 0;
  function take(size) {
    if (offset + size > bytes.length) throw new Error('invalid_term');
    const value = bytes.slice(offset, offset + size);
    offset += size;
    return value;
  }
  const integer = size => take(size).reduce((value, byte) => value * 256 + byte, 0);
  function read(depth = 0) {
    if (++nodes > 128 || depth > 8) throw new Error('invalid_term');
    const tag = integer(1);
    if (tag === 97) return integer(1);
    if (tag === 98) return new DataView(take(4).buffer).getInt32(0);
    if (tag === 110) {
      const size = integer(1), sign = integer(1);
      if (size > 7 || sign > 1) throw new Error('invalid_term');
      const value = take(size).reduceRight((total, byte) => total * 256 + byte, 0) * (sign ? -1 : 1);
      if (!Number.isSafeInteger(value)) throw new Error('invalid_term');
      return value;
    }
    if (tag === 109) return decoder.decode(take(integer(4)));
    if (tag === 104) return Array.from({ length: integer(1) }, () => read(depth + 1));
    if (tag === 116) {
      const count = integer(4), value = Object.create(null);
      if (count > 32) throw new Error('invalid_term');
      for (let i = 0; i < count; i++) {
        const key = read(depth + 1);
        if (typeof key !== 'string' || Object.hasOwn(value, key)) throw new Error('invalid_term');
        value[key] = read(depth + 1);
      }
      return value;
    }
    throw new Error('invalid_term');
  }
  if (integer(1) !== 131) throw new Error('invalid_term');
  const result = read();
  if (offset !== bytes.length) throw new Error('invalid_term');
  return result;
}

async function verified(env, token, salt, now) {
  const until = Number(env.LEGACY_AUTH_UNTIL);
  if (typeof env.LEGACY_SECRET_KEY_BASE !== 'string' || env.LEGACY_SECRET_KEY_BASE.length < 32 ||
      !Number.isSafeInteger(until) || until <= now || typeof token !== 'string' || token.length > 8192) return null;
  try {
    const [header, payload, signature, extra] = token.split('.');
    if (header !== 'SFMyNTY' || extra !== undefined) return null;
    const material = await crypto.subtle.importKey('raw', encoder.encode(env.LEGACY_SECRET_KEY_BASE), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 1000, hash: 'SHA-256' }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', key, decode(signature), encoder.encode(`${header}.${payload}`))) return null;
    return term(decode(payload));
  } catch { return null; }
}

export async function legacySession(env, cookie, now = Date.now()) {
  const value = await verified(env, cookie, 'DkrNptIj', now);
  if (!value || Array.isArray(value) || typeof value.user_id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.user_id)) return null;
  return { id: value.user_id };
}

export async function legacyExtension(env, token, now = Date.now()) {
  const value = await verified(env, token, 'extension', now);
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [data, signedAt] = value;
  if (!Number.isSafeInteger(signedAt) || signedAt < 0 || signedAt > now + 60000 || signedAt + 86400000 <= now) return null;
  const [room, owner] = typeof data === 'string' ? [data, `legacy:${crypto.randomUUID()}`] : Array.isArray(data) ? data : [];
  if (typeof room !== 'string' || !/^[a-z0-9]{1,16}$/.test(room) || typeof owner !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(owner)) return null;
  return { purpose: 'room', room, owner, exp: signedAt + 86400000 };
}
