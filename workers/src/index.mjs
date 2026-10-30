import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from './room-store.mjs';
import { newRoom, nextDeadline } from './room-state.mjs';
import { executeRoomApi } from './api.mjs';
import { expireReady } from './playback.mjs';
import { expireAdvance } from './queue.mjs';
import { json, apiToken, matchesKey, readJson, requestError } from './http.mjs';
import { roomTicket } from './session.mjs';
import { verifyToken } from './auth.mjs';
import { legacyExtension } from './legacy-auth.mjs';
import { legacyLive } from './legacy-live.mjs';
import { httpChannel } from './http-channel.mjs';
import { trackAnalytics } from './analytics.mjs';
import { RoomSockets } from './room-sockets.mjs';
import { finalizeLeaves } from './peers.mjs';
import { RoomMetadata } from './room-metadata.mjs';
import { advanceRound } from './room-rounds.mjs';
import { PoolPicks, enqueuePick } from './pool-picks.mjs';
import { planIdle, touchIdle, expireIdle, reconcileConnections } from './room-lifecycle.mjs';
export { VideoPool } from './pool-object.mjs';

const missingKey = 'Missing API key. Provide Authorization: Bearer <token> header or api_key query param.';

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new RoomStore(ctx.storage);
    this.room = this.store.load();
    this.sockets = new RoomSockets(this);
    this.metadata = new RoomMetadata(this);
    this.poolPicks = new PoolPicks(this);
    const liveIds = new Set(ctx.getWebSockets().filter(socket => socket.readyState === 1).map(socket => socket.deserializeAttachment()).filter(peer => peer?.joined).map(peer => peer.userId));
    const recovered = reconcileConnections(this.room, liveIds, Date.now());
    if (recovered !== this.room) ctx.blockConcurrencyWhile(() => this.persist(recovered));
  }

  async importLegacy(record) {
    if (typeof record?.room_id !== 'string' || this.env.ROOMS.idFromName(record.room_id).toString() !== this.ctx.id.toString()) throw new Error('invalid_migration_target');
    const result = await this.store.importLegacy(record, Date.now());
    if (result.imported) {
      this.room = this.store.load();
      await this.scheduleAlarm();
    }
    return result;
  }

  webSocketMessage(socket, message) { return this.sockets.message(socket, message); }
  webSocketClose(socket) { return this.sockets.close(socket); }
  webSocketError(socket) { return this.sockets.close(socket); }

  async persist(state) {
    state = planIdle(state, this.room, Date.now());
    state = this.metadata.enqueueCurrent(state, this.room, Date.now());
    this.store.save(state);
    this.room = state;
    await this.scheduleAlarm();
  }

  async scheduleAlarm() {
    const deadline = nextDeadline(this.room);
    if (deadline === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, deadline));
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/__socket' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return this.sockets.upgrade(url.searchParams.get('owner'), url.searchParams.get('role'), url.searchParams.get('site_host'), url.searchParams.get('connection'));
      }
      if (request.method === 'POST' && url.pathname === '/__http_message') {
        const socket = this.ctx.getWebSockets(`http:${url.searchParams.get('connection')}`).find(socket => {
          const peer = socket.deserializeAttachment();
          return socket.readyState === 1 && peer?.role === 'browser' && peer.ownerId === url.searchParams.get('owner');
        });
        if (!socket) return json({ error: 'Connection closed.' }, 409);
        const body = await readJson(request, 70000);
        if (typeof body.frame !== 'string') return json({ error: 'Invalid frame.' }, 400);
        await this.sockets.message(socket, body.frame);
        return json({ accepted: true });
      }
      if (request.method === 'GET' && url.pathname === '/__exists') return json({ exists: this.room !== null });
      if (request.method === 'POST' && url.pathname === '/__create') {
        if (this.room) return json({ error: 'Room already exists.' }, 409);
        const state = newRoom(url.searchParams.get('id'), Date.now());
        await this.persist(state);
        return json({ room_id: state.room_id, api_key: state.api_key }, 201);
      }
      const token = apiToken(request);
      if (!token) return json({ error: missingKey }, 401);
      if (!this.room || !await matchesKey(this.room.api_key, token)) return json({ error: 'Invalid API key for this room.' }, 401);
      const limiter = request.method === 'GET' ? this.env.API_READ_LIMITER : this.env.API_MUTATE_LIMITER;
      if (!(await limiter.limit({ key: token })).success) return json({ error: 'Rate limited. Slow down.' }, 429);
      const params = ['POST', 'PUT'].includes(request.method) ? await readJson(request) : {};
      const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
      const result = executeRoomApi(this.room, request.method, path, params, Date.now(), [url.searchParams.get('site_host')]);
      result.state = this.metadata.enqueue(result.state, result.metadata_item, Date.now());
      if (result.state !== this.room) await this.persist(touchIdle(result.state, Date.now()));
      this.sockets.broadcast(result.events, result.events.length > 0);
      return json(result.body, result.status);
    } catch (error) {
      return requestError(error);
    }
  }

  async alarm() {
    if (!this.room) return;
    const now = Date.now();
    let result = expireReady(this.room, this.room.ready_item_id, now);
    const events = [...result.events];
    result = expireAdvance(result.state, now);
    events.push(...result.events);
    result = finalizeLeaves(result.state, now);
    events.push(...result.events);
    result.state = expireIdle(result.state, now);
    result = advanceRound(result.state, now);
    events.push(...result.events);
    result.state = this.metadata.enqueue(result.state, result.metadata_item, now);
    if (result.picked_external_id) result.state = enqueuePick(result.state, result.picked_external_id, now);
    const metadata = this.metadata.prepare(result.state, now);
    await this.persist(metadata.state);
    this.sockets.broadcast(events, events.length > 0);
    if (metadata.jobs.length) this.ctx.waitUntil(this.metadata.finish(metadata.jobs));
    if (this.room.pool_pick_deadline != null) this.ctx.waitUntil(this.poolPicks.flush());
  }
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ status: 'ok' });
    if (['/live/websocket', '/live/longpoll'].includes(url.pathname)) return legacyLive(request, env);
    if (['/socket/stream', '/socket/message'].includes(url.pathname)) return httpChannel(request, env);
    if (['/socket/websocket', '/extension/websocket'].includes(url.pathname)) {
      try {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required.' }, 426);
        const role = url.pathname === '/extension/websocket' ? 'extension' : 'browser';
        const origin = request.headers.get('Origin');
        if (role === 'browser' && origin && origin !== url.origin) return json({ error: 'Forbidden origin.' }, 403);
        const token = url.searchParams.get('token');
        const claims = await verifyToken(env.TOKEN_SECRET, token, 'room') ??
          (role === 'extension' ? await legacyExtension(env, token) : null);
        if (!claims) return json({ error: 'Invalid room ticket.' }, 401);
        const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
        if (!(await env.JOIN_LIMITER.limit({ key: ip })).success) return json({ error: 'Rate limited. Slow down.' }, 429);
        const target = new URL('https://room.internal/__socket');
        target.searchParams.set('owner', claims.owner);
        target.searchParams.set('role', role);
        target.searchParams.set('site_host', url.hostname);
        return env.ROOMS.get(env.ROOMS.idFromName(claims.room)).fetch(new Request(target, request));
      } catch (error) { return requestError(error); }
    }
    const sessionRoute = url.pathname.match(/^\/session\/([a-z0-9]{1,16})$/);
    if (sessionRoute && request.method === 'POST') {
      try {
        const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
        if (!(await env.JOIN_LIMITER.limit({ key: ip })).success) return json({ error: 'Rate limited. Slow down.' }, 429);
        const params = await readJson(request, 4096);
        const id = sessionRoute[1];
        const ticket = await roomTicket(env.TOKEN_SECRET, request, id, params.tab_id, Date.now(), env);
        const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
        const { exists } = await (await stub.fetch('https://room.internal/__exists')).json();
        if (!exists) {
          if (!(await env.CREATE_LIMITER.limit({ key: ip })).success) return json({ error: 'Rate limited. Slow down.' }, 429);
          const created = await stub.fetch(`https://room.internal/__create?id=${id}`, { method: 'POST' });
          if (![201, 409].includes(created.status)) return created;
        }
        const response = json({ token: ticket.token, user_id: ticket.user_id, room_id: id });
        response.headers.set('Set-Cookie', ticket.cookie);
        return response;
      } catch (error) { return requestError(error); }
    }
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const key = request.headers.get('CF-Connecting-IP') ?? 'local';
      if (!(await env.CREATE_LIMITER.limit({ key })).success) return json({ error: 'Rate limited. Slow down.' }, 429);
      for (let attempt = 0; attempt < 3; attempt++) {
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        const id = Array.from(bytes, byte => '0123456789abcdefghijklmnopqrstuvwxyz'[byte % 36]).join('');
        const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
        const created = await stub.fetch(`https://room.internal/__create?id=${id}`, { method: 'POST' });
        if (created.status === 409) continue;
        if (created.status !== 201) return created;
        const data = await created.json();
        trackAnalytics(env, context, 'room_created', request.headers.get('X-Byob-Browser-ID'), { room_id: id });
        return json({ ok: true, data: { ...data, url: `${url.origin}/room/${id}` } }, 201);
      }
      return json({ error: 'Could not allocate a room. Please try again.' }, 503);
    }
    const route = url.pathname.match(/^\/api\/rooms\/([a-z0-9]{1,16})(\/.*)?$/);
    if (route) {
      const path = route[2] ?? '/';
      if (path !== '/' && !/^\/(?:queue(?:\/[^/]+)?|users|skip|play|pause|username)\/?$/.test(path)) return json({ error: 'Not found.' }, 404);
      if (!apiToken(request)) return json({ error: missingKey }, 401);
      const target = new URL(`https://room.internal${route[2] ?? '/'}`);
      target.search = url.search;
      target.searchParams.set('site_host', url.hostname);
      return env.ROOMS.get(env.ROOMS.idFromName(route[1])).fetch(new Request(target, request));
    }
    return json({ error: 'Not found.' }, 404);
  },
};
