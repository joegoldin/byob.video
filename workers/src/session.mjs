import { signToken, verifyToken } from './auth.mjs';
import { legacySession } from './legacy-auth.mjs';

const cookieName = '__Host-byob_session';
const sessionLifetime = 365 * 24 * 60 * 60 * 1000;

export async function roomTicket(secret, request, roomId, tabId, now = Date.now(), legacyEnv = {}) {
  if (!/^[a-z0-9]{1,16}$/.test(roomId)) throw new Error('invalid_room');
  if (typeof tabId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tabId)) throw new Error('invalid_tab');
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw new Error('invalid_origin');
  const cookie = (request.headers.get('Cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
  const existing = cookie ? await verifyToken(secret, cookie.slice(cookieName.length + 1), 'session', now) : null;
  const oldCookie = (request.headers.get('Cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith('_byob_key='));
  const migrated = !existing && oldCookie ? await legacySession(legacyEnv, oldCookie.slice('_byob_key='.length), now) : null;
  const session = existing ?? { purpose: 'session', id: migrated?.id ?? crypto.randomUUID(), exp: now + sessionLifetime };
  const owner = `${session.id}:${tabId}`;
  const token = await signToken(secret, { purpose: 'room', room: roomId, owner, exp: now + 86400000 });
  return {
    token, user_id: owner, room_id: roomId,
    cookie: `${cookieName}=${await signToken(secret, session)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((session.exp - now) / 1000)}`,
  };
}
