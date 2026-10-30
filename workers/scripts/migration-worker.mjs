import { json, matchesKey, readJson } from '../src/http.mjs';

// Deploy separately and remove after cutover. The public site never routes
// migration requests; this worker requires its own temporary secret.
export default {
  async fetch(request, env) {
    if (!env.MIGRATION_TOKEN) return json({ error: 'Not found.' }, 404);
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ') || !await matchesKey(env.MIGRATION_TOKEN, authorization.slice(7))) return json({ error: 'Unauthorized.' }, 401);
    if (request.headers.has('Origin')) return json({ error: 'Browser imports are not allowed.' }, 403);
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    try {
      const body = await readJson(request, 1024 * 1024);
      const path = new URL(request.url).pathname;
      if (path === '/rooms') {
        if (typeof body.room_id !== 'string' || !/^[a-z0-9]{1,16}$/.test(body.room_id)) return json({ error: 'Invalid room.' }, 400);
        return json(await env.ROOMS.getByName(body.room_id).importLegacy(body));
      }
      if (path === '/pool') return json(await env.POOL.getByName('global').importLegacy(body.entries));
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      if (['migration_room_conflict', 'migration_pool_conflict'].includes(error.message)) return json({ error: error.message }, 409);
      if (['invalid_json', 'invalid_legacy_room', 'invalid_legacy_pool', 'invalid_migration_target', 'invalid_room'].includes(error.message)) return json({ error: error.message }, 400);
      if (['body_too_large', 'room_state_too_large'].includes(error.message)) return json({ error: 'Import is too large.' }, 413);
      return json({ error: 'Import failed.' }, 500);
    }
  },
};
