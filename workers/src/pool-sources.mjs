import { youtubeData } from './youtube.mjs';
import { upstreamJson } from './upstream.mjs';
import { durationSeconds } from './metadata.mjs';
import { parseMediaUrl } from './media.mjs';

export const subreddits = Object.freeze(['videos', 'mealtimevideos', 'deepintoyoutube', 'listentothis']);
export const curatedPlaylists = Object.freeze([
  'PLmur3Z0Afau5t4kKbwmCsrXUiyUoZBQ5m', 'PLmur3Z0Afau4xMQrGmNI20OUu1_jBWRIo',
  'PLmur3Z0Afau6t-ab7uUZZnAtWZuLyMW9r', 'PLmur3Z0Afau4wSl9By0h8qIgOBbN9Zmhd',
  'PLEbAHi3fZpuEyBOPtr158TY-FW7P1l4Fg', 'PL8hhMHBxIcj2slXZOJHs8_lESmVDIR0U9',
  'PLDIpOnnnyGLC9-1hn4lcNlrWDF2ktOtTp', 'PLFz4Zf531DCDlhwNQLk64yJwofKHyu9jo',
  'PLGGr2yYc6y6QINtXVgc5BUw8qeb44dI48', 'PLdUGA0NFIvcCrfMeI_iuaEP0iyGPnbryJ',
  'PLcLtbK8Nf64InyudI1rnYwwRbCr08yup_', 'PLDWYWQX-Q1O6gpctyJS9SlQBIPnuXuuWQ',
]);

function videoFields(video) {
  const snippet = video.snippet ?? {}, thumbs = snippet.thumbnails ?? {};
  return { title: typeof snippet.title === 'string' ? snippet.title.slice(0, 500) : '(untitled)',
    channel: snippet.channelTitle ?? null, thumbnail_url: (thumbs.maxres ?? thumbs.high ?? thumbs.medium ?? thumbs.default)?.url ?? null,
    duration_s: durationSeconds(video.contentDetails?.duration), embeddable: video.status?.embeddable !== false };
}

export async function fetchPoolPage(job, env, options = {}) {
  if (job.kind === 'trending') {
    const result = await youtubeData('videos', { part: 'snippet,contentDetails,status', chart: 'mostPopular', regionCode: 'US', maxResults: '50' }, env, { ...options, ttl: 3600 });
    return { entries: (result.data?.items ?? []).slice(0, 50).map((video, score) => ({ ...videoFields(video), source_type: 'trending', source_detail: 'US', external_id: video.id, score })) };
  }
  if (job.kind === 'subreddit' && subreddits.includes(job.detail)) {
    try {
      const data = await upstreamJson(`https://www.reddit.com/r/${job.detail}/top.json?t=day&limit=50`, { ...options, limit: 1048576, headers: { 'User-Agent': 'byob.video/1.0 (+https://byob.video)' } });
      const entries = (data.data?.children ?? []).slice(0, 50).flatMap(post => {
        const value = post?.data;
        if (typeof value?.url !== 'string') return [];
        let parsed;
        try { parsed = parseMediaUrl(value.url.startsWith('//') ? `https:${value.url}` : value.url); } catch { return []; }
        if (parsed.source_type !== 'youtube' || !/^[\w-]{11}$/.test(parsed.source_id ?? '')) return [];
        return [{ source_type: 'subreddit', source_detail: job.detail, external_id: parsed.source_id,
          title: typeof value.title === 'string' ? value.title.slice(0, 500) : '(untitled)', channel: null, duration_s: null,
          thumbnail_url: `https://i.ytimg.com/vi/${parsed.source_id}/hqdefault.jpg`, score: value.ups ?? null }];
      });
      return { entries };
    } catch { return { entries: [] }; }
  }
  if (job.kind === 'curated' && curatedPlaylists.includes(job.detail)) {
    const params = { part: 'snippet,contentDetails', playlistId: job.detail, maxResults: '50' };
    if (job.token) params.pageToken = job.token;
    const result = await youtubeData('playlistItems', params, env, { ...options, ttl: 86400 });
    const entries = (result.data?.items ?? []).slice(0, 50).map(item => {
      const snippet = item.snippet ?? {}, thumbs = snippet.thumbnails ?? {};
      return { source_type: 'curated', source_detail: job.detail, external_id: item.contentDetails?.videoId ?? snippet.resourceId?.videoId,
        title: typeof snippet.title === 'string' ? snippet.title.slice(0, 500) : '(untitled)',
        channel: snippet.videoOwnerChannelTitle ?? snippet.channelTitle ?? null, duration_s: null,
        thumbnail_url: (thumbs.medium ?? thumbs.high ?? thumbs.default)?.url ?? null, score: null };
    });
    const token = result.data?.nextPageToken;
    return { entries, next_page_token: typeof token === 'string' && token.length <= 2048 ? token : null };
  }
  throw new Error('invalid_pool_source');
}

export async function validateCandidates(rows, env, options = {}) {
  if (!rows.length || !env.YOUTUBE_API_KEY) return rows;
  const ids = [...new Set(rows.map(row => row.external_id))].sort();
  const result = await youtubeData('videos', { part: 'snippet,contentDetails,status', id: ids.join(',') }, env, options);
  if (result.error || !Array.isArray(result.data?.items)) return rows;
  const videos = new Map(result.data.items.map(video => [video.id, video]));
  return rows.flatMap(row => {
    const video = videos.get(row.external_id);
    if (!video || video.status?.embeddable === false) return [];
    const meta = videoFields(video);
    return [{ ...row, title: row.source_type === 'subreddit' ? meta.title : row.title,
      channel: row.channel ?? meta.channel, duration_s: row.duration_s ?? meta.duration_s,
      thumbnail_url: row.thumbnail_url ?? meta.thumbnail_url }];
  });
}
