const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const vimeoHosts = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
const twitchHosts = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);
const drmHosts = {
  'netflix.com': 'Netflix', 'disneyplus.com': 'Disney+', 'max.com': 'Max',
  'hbomax.com': 'Max', 'hulu.com': 'Hulu', 'primevideo.com': 'Prime Video',
  'tv.apple.com': 'Apple TV+', 'peacocktv.com': 'Peacock', 'paramountplus.com': 'Paramount+',
};

export class MediaError extends Error {
  constructor(code, service) {
    super(service ? `${code}: ${service}` : code);
    this.code = code;
    this.service = service;
  }
}

export function normalizeUrl(input) {
  if (typeof input !== 'string') throw new MediaError('invalid_url');
  const value = input.trim();
  return /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(value) ? `https://${value}` : value;
}

function httpUrl(input) {
  let url;
  try { url = new URL(normalizeUrl(input)); } catch { throw new MediaError('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new MediaError('invalid_url');
  return url;
}

export function canonicalHost(host) { return host.toLowerCase().replace(/\.+$/, ''); }

export function parseMediaUrl(input, selfHosts = []) {
  const url = httpUrl(input), host = canonicalHost(url.hostname), path = url.pathname;
  if (['byob.video', 'www.byob.video', ...selfHosts.filter(Boolean).map(canonicalHost)].includes(host)) throw new MediaError('self_reference');
  for (const [domain, service] of Object.entries(drmHosts)) {
    if (host === domain || host.endsWith(`.${domain}`)) throw new MediaError('drm_site', service);
  }
  let source_type = 'extension_required', source_id = null, is_live = false;
  if (youtubeHosts.has(host)) {
    source_type = 'youtube';
    if (host === 'youtu.be') source_id = path.slice(1) || null;
    else if (path === '/watch') source_id = url.searchParams.get('v');
    else source_id = path.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1] ?? null;
    is_live = path.startsWith('/live/');
  } else if (vimeoHosts.has(host)) {
    source_type = 'vimeo';
    source_id = path.match(/\/(?:video\/)?(\d+)/)?.[1] ?? null;
  } else if (twitchHosts.has(host)) {
    source_type = 'twitch';
    is_live = !path.startsWith('/videos/');
    source_id = (is_live ? path.slice(1) : path.slice('/videos/'.length)).split('/')[0] || null;
  } else if (/\.(mp4|webm|ogg|mov|mkv|avi|m4v)$/i.test(path)) {
    source_type = 'direct_url';
  }
  return { id: crypto.randomUUID(), url: normalizeUrl(input), source_type, source_id, is_live };
}

export function youtubePlaylist(input) {
  let url;
  try { url = httpUrl(input); } catch { return null; }
  const id = url.searchParams.get('list');
  return youtubeHosts.has(canonicalHost(url.hostname)) && /^(PL|UU|FL|OL)/.test(id ?? '')
    ? { id, focus: url.searchParams.get('v') } : null;
}

export function extractUrl(text) {
  if (typeof text !== 'string') return null;
  const matches = text.match(/https?:\/\/\S+?(?=https?:\/\/|\s|$)/g);
  return matches?.at(-1)?.replace(/[,.;:)\]}>"']+$/, '') ?? null;
}
