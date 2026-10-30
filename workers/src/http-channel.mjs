import { verifyToken } from './auth.mjs';
import { json, readJson, requestError } from './http.mjs';

export async function httpChannel(request, env) {
  const url = new URL(request.url);
  if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: 'Forbidden origin.' }, 403);
  const stream = url.pathname === '/socket/stream';
  if (request.method !== (stream ? 'GET' : 'POST')) return json({ error: 'Method not allowed.' }, 405);
  const connection = url.searchParams.get('connection');
  if (!/^[a-f0-9-]{36}$/.test(connection ?? '')) return json({ error: 'Invalid connection.' }, 400);
  try {
    const claims = await verifyToken(env.TOKEN_SECRET, url.searchParams.get('token'), 'room');
    if (!claims) return json({ error: 'Invalid room ticket.' }, 401);
    const target = new URL(stream ? 'https://room.internal/__socket' : 'https://room.internal/__http_message');
    target.searchParams.set('owner', claims.owner);
    target.searchParams.set('role', 'browser');
    target.searchParams.set('site_host', url.hostname);
    target.searchParams.set('connection', connection);
    const room = env.ROOMS.getByName(claims.room);
    if (!stream) {
      const body = await readJson(request, 70000);
      if (typeof body.frame !== 'string') return json({ error: 'Invalid frame.' }, 400);
      return room.fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
    if (!(await env.JOIN_LIMITER.limit({ key: ip })).success) return json({ error: 'Rate limited.' }, 429);
    const response = await room.fetch(target, { headers: { Upgrade: 'websocket' } });
    if (response.status !== 101) return response;
    const socket = response.webSocket;
    socket.accept();
    let ended = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        const finish = () => { if (!ended) { ended = true; controller.close(); } };
        controller.enqueue(encoder.encode('\n'));
        socket.addEventListener('message', event => {
          if (ended) return;
          // A stalled reader must not accumulate an unbounded room event log.
          if (controller.desiredSize <= 0) { socket.close(1008, 'Slow reader'); finish(); return; }
          controller.enqueue(encoder.encode(`${event.data}\n`));
        });
        socket.addEventListener('close', finish);
        socket.addEventListener('error', finish);
      },
      cancel() { ended = true; socket.close(1000, 'HTTP transport closed'); },
    }, { highWaterMark: 1024 * 1024, size: chunk => chunk.byteLength });
    return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return requestError(error); }
}
