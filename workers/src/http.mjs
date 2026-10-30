export function json(body, status = 200) {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  } });
}

export function apiToken(request) {
  const header = request.headers.get('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return new URL(request.url).searchParams.get('api_key') ?? '';
}

export async function matchesKey(expected, provided) {
  if (typeof provided !== 'string' || !provided.length || provided.length > 256) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([expected, provided].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

export async function readJson(request, limit = 16384) {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error('body_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value;
  try { value = size ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : {}; }
  catch { throw new Error('invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json');
  return value;
}

export function requestError(error) {
  if (error.message === 'rate_limited') return json({ error: 'Rate limited. Slow down.' }, 429);
  if (error.message === 'invalid_origin') return json({ error: 'Forbidden origin.' }, 403);
  if (error.message === 'body_too_large') return json({ error: 'Request body too large.' }, 413);
  if (error.code) return json({ error: `Failed to add to queue: ${error.code}` }, 422);
  if (['invalid_json', 'invalid_position', 'invalid_username', 'invalid_index', 'invalid_action', 'invalid_mode', 'invalid_room', 'invalid_tab'].includes(error.message)) {
    return json({ error: error.message }, 400);
  }
  return json({ error: 'Internal server error.' }, 500);
}
