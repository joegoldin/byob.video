import { upstreamJson } from './upstream.mjs';
import { defaultSponsorSettings } from './room-state.mjs';

export async function fetchSponsor(videoId, { fetcher = fetch, cache = globalThis.caches?.default } = {}) {
  if (typeof videoId !== 'string' || !/^[\w-]{1,128}$/.test(videoId)) return null;
  const url = new URL('https://sponsor.ajay.app/api/skipSegments');
  url.search = new URLSearchParams({ videoID: videoId, categories: JSON.stringify(Object.keys(defaultSponsorSettings)) });
  const cached = cache ? await cache.match(url.href) : null;
  if (cached) return cached.json();
  let result = null;
  try {
    const data = await upstreamJson(url.href, { fetcher, limit: 262144 });
    if (Array.isArray(data)) {
      const segments = data.filter(value => value && Array.isArray(value.segment) && value.segment.length === 2 &&
        value.segment.every(time => typeof time === 'number' && Number.isFinite(time) && time >= 0) &&
        value.segment[1] > value.segment[0] && Object.hasOwn(defaultSponsorSettings, value.category)).slice(0, 2000).map(value => ({
        segment: value.segment, category: value.category,
        action_type: typeof value.actionType === 'string' ? value.actionType.slice(0, 30) : 'skip',
        uuid: typeof value.UUID === 'string' ? value.UUID.slice(0, 128) : null,
        video_duration: typeof value.videoDuration === 'number' && Number.isFinite(value.videoDuration) && value.videoDuration > 0 ? value.videoDuration : 0,
      }));
      result = { segments, duration: Math.max(0, ...segments.map(value => value.video_duration)), video_id: videoId };
    }
  } catch { /* Missing or unavailable segments must not delay playback. */ }
  if (cache) await cache.put(url.href, Response.json(result, { headers: { 'Cache-Control': `public, max-age=${result ? 3600 : 60}` } }));
  return result;
}

export function applySponsor(state, result) {
  const current = state.current_index === null ? null : state.queue[state.current_index];
  if (!result || current?.source_type !== 'youtube' || current.source_id !== result.video_id) return { state, events: [] };
  return { state: { ...state, sponsor_segments: result.segments }, events: [['sponsor_segments', result]] };
}
