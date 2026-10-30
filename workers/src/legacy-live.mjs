import { json } from './http.mjs';
import { parseFrame, reply } from './protocol.mjs';
import { legacyPoll } from './legacy-poll.mjs';

export function legacyLive(request, env, now = Date.now()) {
  const until = Number(env.LEGACY_AUTH_UNTIL);
  if (typeof env.LEGACY_SECRET_KEY_BASE !== 'string' || env.LEGACY_SECRET_KEY_BASE.length < 32 || !Number.isSafeInteger(until) || until <= now) return json({ error: 'Not found.' }, 404);
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Forbidden origin.' }, 403);
  if (new URL(request.url).pathname === '/live/longpoll') return legacyPoll(request, env, now);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required.' }, 426);
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  // Use LiveView's stale-session reload path without restoring an obsolete
  // process or replaying any in-flight mutations against migrated data.
  const timeout = setTimeout(() => server.close(1000, 'BYOB upgraded; reload'), 5000);
  server.addEventListener('close', () => clearTimeout(timeout));
  server.addEventListener('message', event => {
    try {
      const frame = parseFrame(event.data);
      if (frame.event === 'phx_join') {
        server.send(reply(frame, 'error', { reason: 'stale' }));
        clearTimeout(timeout);
        server.close(1000, 'BYOB upgraded; reload');
      }
    } catch {
      clearTimeout(timeout);
      server.close(1008, 'Invalid frame');
    }
  });
  return new Response(null, { status: 101, webSocket: client });
}
