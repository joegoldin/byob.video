import { boundedFetch, upstreamJson, externalUrl } from './upstream.mjs';
import { youtubeData } from './youtube.mjs';

function text(value, limit = 500) { return typeof value === 'string' ? value.slice(0, limit) : null; }
function imageUrl(value, base) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try { return externalUrl(new URL(value, base).href).href; } catch { return null; }
}

export function durationSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  return match ? Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0) : null;
}

function entities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, code) => {
    if (!code.startsWith('#')) return named[code.toLowerCase()] ?? original;
    const number = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '\uFFFD';
  });
}

export function openGraph(html, base) {
  const meta = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = {};
    for (const attribute of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[attribute[1].toLowerCase()] = attribute[2] ?? attribute[3] ?? attribute[4];
    const name = attrs.property ?? attrs.name;
    if (['og:title', 'twitter:title', 'og:image', 'twitter:image'].includes(name) && typeof attrs.content === 'string') meta[name] = entities(attrs.content);
  }
  const fallback = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  return {
    title: text(meta['og:title'] ?? meta['twitter:title'] ?? (fallback ? entities(fallback).trim() : null)),
    thumbnail_url: imageUrl(meta['og:image'] ?? meta['twitter:image'], base), author_name: null,
  };
}

async function loadMetadata(item, env, fetcher, cache) {
  if (item.source_type === 'direct_url') return null;
  if (item.source_type === 'youtube' && env.YOUTUBE_API_KEY && item.source_id) {
    try {
      const result = await youtubeData('videos', { part: 'snippet,contentDetails,status', id: item.source_id }, env, { fetcher, cache, ttl: 86400 });
      const video = result.data?.items?.[0];
      if (video?.snippet) {
        const thumbs = video.snippet.thumbnails ?? {};
        return { title: text(video.snippet.title), author_name: text(video.snippet.channelTitle),
          thumbnail_url: imageUrl((thumbs.maxres ?? thumbs.high ?? thumbs.medium ?? thumbs.default)?.url, item.url),
          duration: durationSeconds(video.contentDetails?.duration), published_at: text(video.snippet.publishedAt, 40),
          embeddable: video.status?.embeddable !== false, source_type: 'youtube' };
      }
    } catch { /* A missing quota or unavailable API must still allow oEmbed. */ }
  }
  if (['youtube', 'vimeo'].includes(item.source_type)) {
    const url = new URL(item.source_type === 'youtube' ? 'https://www.youtube.com/oembed' : 'https://vimeo.com/api/oembed.json');
    const media = new URL(item.url);
    if (item.source_type === 'vimeo') { media.search = ''; media.hash = ''; }
    url.search = new URLSearchParams({ url: media.href, format: 'json' });
    const data = await upstreamJson(url.href, { fetcher });
    return { title: text(data.title), thumbnail_url: imageUrl(data.thumbnail_url, item.url), author_name: text(data.author_name),
      duration: typeof data.duration === 'number' && Number.isFinite(data.duration) && data.duration > 0 ? data.duration : null,
      source_type: item.source_type };
  }
  const response = await boundedFetch(item.url, { fetcher, headers: { Accept: 'text/html,application/xhtml+xml' }, types: ['text/html', 'application/xhtml+xml'] });
  return openGraph(response.text, response.url);
}

export async function fetchMetadata(item, env, { fetcher = fetch, cache = globalThis.caches?.default } = {}) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${item.source_type}:${env.YOUTUBE_API_KEY ? 'api' : 'public'}:${item.url}`));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const key = `https://metadata.byob.invalid/${hash}`;
  const cached = cache ? await cache.match(key) : null;
  if (cached) return cached.json();
  let result = null;
  try { result = await loadMetadata(item, env, fetcher, cache); } catch { /* Metadata failure never interrupts shared playback. */ }
  if (cache) await cache.put(key, Response.json(result, { headers: { 'Cache-Control': `public, max-age=${result ? 86400 : 60}` } }));
  return result;
}
