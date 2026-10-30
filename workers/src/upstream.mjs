export function externalUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('invalid_upstream_url'); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) || !host.includes('.') ||
      host.includes(':') || host.endsWith('.') || /^[\d.]+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) throw new Error('blocked_upstream');
  return url;
}

export async function boundedFetch(input, { fetcher = fetch, limit = 262144, timeout = 8000, headers = {}, types, allowErrorStatus = false } = {}) {
  let url = externalUrl(input);
  const signal = AbortSignal.timeout(timeout);
  let requestHeaders = new Headers(headers);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url.href, { redirect: 'manual', signal, headers: requestHeaders });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('Location');
      if (!location || redirects === 3) throw new Error('upstream_redirect');
      const target = externalUrl(new URL(location, url).href);
      if (target.origin !== url.origin) {
        const publicHeaders = new Headers();
        for (const name of ['Accept', 'User-Agent']) if (requestHeaders.has(name)) publicHeaders.set(name, requestHeaders.get(name));
        requestHeaders = publicHeaders;
      }
      url = target;
      continue;
    }
    if (!response.ok && !allowErrorStatus) { await response.body?.cancel(); throw new Error('upstream_status'); }
    const contentType = response.headers.get('Content-Type');
    if (types && contentType && !types.some(type => contentType.toLowerCase().startsWith(type))) { await response.body?.cancel(); throw new Error('upstream_content_type'); }
    if (Number(response.headers.get('Content-Length')) > limit) { await response.body?.cancel(); throw new Error('upstream_too_large'); }
    if (!response.body) return { text: '', url: url.href, headers: response.headers, status: response.status };
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) { await reader.cancel(); throw new Error('upstream_too_large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { text: new TextDecoder().decode(bytes), url: url.href, headers: response.headers, status: response.status };
  }
}

export async function upstreamJson(url, options = {}) {
  const response = await boundedFetch(url, { ...options, limit: options.limit ?? 65536 });
  const data = JSON.parse(response.text);
  if (!data || typeof data !== 'object') throw new Error('invalid_upstream_json');
  return data;
}
