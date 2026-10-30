import { boundedFetch } from './upstream.mjs';

const pending = new Map();
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function read(cache, key) {
  try { return cache ? await (await cache.match(key))?.json() : null; }
  catch { return null; }
}
async function write(cache, key, value, ttl) {
  try { if (cache) await cache.put(key, Response.json(value, { headers: { 'Cache-Control': `public, max-age=${ttl}` } })); }
  catch { /* The cache is an optimization, not a prerequisite for provider access. */ }
}

export async function youtubeData(resource, params, env, { fetcher = fetch, cache = globalThis.caches?.default, ttl = 900, now = Date.now() } = {}) {
  if (!env.YOUTUBE_API_KEY) return { error: 'not_configured' };
  if (!['videos', 'commentThreads', 'comments', 'playlistItems', 'playlists'].includes(resource)) throw new Error('invalid_youtube_resource');
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  url.search = new URLSearchParams({ ...params, key: env.YOUTUBE_API_KEY });
  // Register before hashing/cache awaits so even fast responses coalesce.
  const requestKey = url.href;
  if (pending.has(requestKey)) return pending.get(requestKey);
  if (pending.size >= 128) return { error: 'busy' };
  const request = (async () => {
    const key = `https://youtube.byob.invalid/data/${await hash(url.href)}`;
    const cached = await read(cache, key);
    if (cached) return cached;
    const day = new Date(now).toISOString().slice(0, 10);
    const untilMidnight = Math.max(1, Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86400000 - now) / 1000));
    const quotaKey = `https://youtube.byob.invalid/quota/${await hash(env.YOUTUBE_API_KEY)}/${day}`;
    if (await read(cache, quotaKey)) return { error: 'quota_exhausted' };
    try {
      const response = await boundedFetch(url.href, { fetcher, allowErrorStatus: true, limit: 1048576 });
      const data = JSON.parse(response.text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'invalid_response' };
      if (response.status === 200) {
        const result = { data };
        await write(cache, key, result, ttl);
        return result;
      }
      const reasons = Array.isArray(data.error?.errors) ? data.error.errors.map(error => error?.reason) : [];
      let error = 'upstream_unavailable';
      if (reasons.includes('quotaExceeded') || reasons.includes('dailyLimitExceeded')) {
        error = 'quota_exhausted';
        await write(cache, quotaKey, true, untilMidnight);
      } else if (response.status === 404) error = 'not_found';
      else if (reasons.includes('commentsDisabled')) error = 'comments_disabled';
      const result = { error };
      await write(cache, key, result, error === 'quota_exhausted' ? Math.min(60, untilMidnight) : 60);
      return result;
    } catch { return { error: 'upstream_unavailable' }; }
  })();
  pending.set(requestKey, request);
  try { return await request; } finally { pending.delete(requestKey); }
}
