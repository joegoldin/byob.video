const events = new Set(['room_created', 'room_joined', 'video_added', 'video_embed_blocked', '$identify']);
const sources = new Set(['youtube', 'vimeo', 'twitch', 'direct_url', 'extension_required', 'youtube_restricted']);

export function analyticsEvent(event, id, input = {}) {
  if (!events.has(event) || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return null;
  const properties = { distinct_id: id };
  if (typeof input.room_id === 'string' && /^[a-z0-9]{1,16}$/.test(input.room_id)) properties.room_id = input.room_id;
  if (sources.has(input.source_type)) properties.source_type = input.source_type;
  if (typeof input.has_extension === 'boolean') properties.has_extension = input.has_extension;
  if (Number.isInteger(input.error_code) && input.error_code >= 0 && input.error_code < 1000) properties.error_code = input.error_code;
  if (event === '$identify') properties.$set = typeof input.has_extension === 'boolean' ? { has_extension: input.has_extension } : {};
  return { event, properties };
}

export async function sendAnalytics(env, batch, fetcher = fetch) {
  if (!env.POSTHOG_API_KEY || !batch.length || batch.length > 8) return false;
  try {
    const safeBatch = batch.map(entry => analyticsEvent(entry.event, entry.properties.distinct_id, entry.properties)).filter(Boolean);
    if (!safeBatch.length) return false;
    const host = new URL(env.POSTHOG_HOST || 'https://us.i.posthog.com');
    if (host.protocol !== 'https:' || host.username || host.password || host.search || host.hash || host.pathname !== '/') return false;
    const response = await fetcher(new URL('/batch/', host), {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: env.POSTHOG_API_KEY, batch: safeBatch }),
    });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}

export function trackAnalytics(env, context, event, id, input) {
  if (!env.POSTHOG_API_KEY) return;
  const entry = analyticsEvent(event, id, input);
  if (!entry) return;
  const batch = [entry];
  if (event === 'room_joined') batch.push(analyticsEvent('$identify', id, { has_extension: input.has_extension }));
  // Analytics is best-effort and cannot delay playback or cause idle alarms.
  context.waitUntil(sendAnalytics(env, batch));
}
