import { signToken, verifyToken } from './auth.mjs';
import { json } from './http.mjs';
import { parseFrame, reply } from './protocol.mjs';

async function frames(request) {
  if (!request.body) throw new Error('invalid_frame');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new Error('body_too_large'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  const lines = text.split('\n').filter(Boolean);
  if (lines.length > 16) throw new Error('invalid_frame');
  return lines.map(parseFrame).filter(frame => frame.event === 'phx_join').map(frame => reply(frame, 'error', { reason: 'stale' }));
}

export async function legacyPoll(request, env, now) {
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const claims = await verifyToken(env.TOKEN_SECRET, token, 'legacy_poll', now);
  if (!claims || typeof claims.id !== 'string' || !/^[a-f0-9-]{36}$/.test(claims.id)) {
    if (request.method !== 'GET') return json({ status: 410 });
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
    if (!(await env.JOIN_LIMITER.limit({ key: ip })).success) return json({ status: 403 });
    return json({ status: 410, token: await signToken(env.TOKEN_SECRET, {
      purpose: 'legacy_poll', id: crypto.randomUUID(), exp: Math.min(now + 30000, Number(env.LEGACY_AUTH_UNTIL)),
    }) });
  }
  const name = `byob_reload_${claims.id}`;
  const attributes = `Path=/live/longpoll; HttpOnly; SameSite=Strict${url.protocol === 'https:' ? '; Secure' : ''}`;
  if (request.method === 'POST') {
    try {
      const messages = await frames(request);
      const response = json({ status: 200 });
      if (messages.length) {
        // Phoenix ignores POST response messages and consumes them on its next
        // GET. A signed, per-connection cookie carries only stale-join replies,
        // avoiding a permanent server-side store for this temporary transition.
        const value = await signToken(env.TOKEN_SECRET, { purpose: 'legacy_reply', id: claims.id, messages, exp: claims.exp });
        if (value.length > 3500) return json({ error: 'Too many join frames.' }, 413);
        response.headers.set('Set-Cookie', `${name}=${value}; ${attributes}; Max-Age=30`);
      }
      return response;
    } catch (error) { return json({ error: 'Invalid legacy frames.' }, error.message === 'body_too_large' ? 413 : 400); }
  }
  const cookie = (request.headers.get('Cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  const pending = cookie ? await verifyToken(env.TOKEN_SECRET, cookie.slice(name.length + 1), 'legacy_reply', now) : null;
  if (pending?.id === claims.id && Array.isArray(pending.messages)) {
    const response = json({ status: 200, token, messages: pending.messages });
    response.headers.set('Set-Cookie', `${name}=; ${attributes}; Max-Age=0`);
    return response;
  }
  // An already outstanding GET may precede the join POST's Set-Cookie response.
  // Let that poll complete without creating a tight client retry loop.
  await new Promise(resolve => setTimeout(resolve, 500));
  return json({ status: 204, token, messages: [] });
}
