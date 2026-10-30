import test from 'node:test';
import assert from 'node:assert/strict';
import { externalUrl, boundedFetch } from '../src/upstream.mjs';
import { durationSeconds, openGraph, fetchMetadata } from '../src/metadata.mjs';

const video = { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', source_type: 'youtube', source_id: 'dQw4w9WgXcQ' };

test('upstream URL policy blocks literal internal targets, credentials and unsafe protocols', () => {
  for (const url of ['http://127.0.0.1/x', 'http://2130706433/x', 'http://[::1]/x', 'http://localhost./x', 'https://host.local/x', 'file:///etc/passwd', 'https://user:password@example.com/x', 'https://example.com:8080/x']) assert.throws(() => externalUrl(url));
  assert.equal(externalUrl('https://example.com/page').hostname, 'example.com');
});

test('redirects are bounded/revalidated and do not forward credentials to another origin', async () => {
  let count = 0;
  const fetcher = async (_url, options) => {
    count++;
    if (count === 1) return new Response(null, { status: 302, headers: { Location: 'https://other.example.com/page' } });
    assert.equal(options.headers.has('Authorization'), false);
    assert.equal(options.headers.has('X-Private-Key'), false);
    assert.equal(options.headers.get('Accept'), 'text/html');
    return new Response('ok');
  };
  assert.equal((await boundedFetch('https://example.com', { fetcher, headers: { Authorization: 'test-only', 'X-Private-Key': 'test-only', Accept: 'text/html' } })).text, 'ok');
  await assert.rejects(boundedFetch('https://example.com', { fetcher: async () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } }) }), /blocked_upstream/);
  await assert.rejects(boundedFetch('https://example.com', { fetcher: async () => new Response(null, { status: 302, headers: { Location: '/again' } }) }), /upstream_redirect/);
});

test('upstream responses have byte, media-type and deadline limits', async () => {
  await assert.rejects(boundedFetch('https://example.com', { fetcher: async () => new Response('☃☃☃'), limit: 8 }), /upstream_too_large/);
  await assert.rejects(boundedFetch('https://example.com', { fetcher: async () => new Response('video', { headers: { 'Content-Type': 'video/mp4' } }), types: ['text/html'] }), /upstream_content_type/);
  await assert.rejects(boundedFetch('https://example.com', { timeout: 10, fetcher: (_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response('late')), 100);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }) }), /timeout/i);
});

test('OpenGraph extraction supports attribute order/quoting, entity decoding and relative images', () => {
  assert.deepEqual(openGraph(`<meta content='A &amp; B &#x1f37b;' property='og:title'><meta property="og:image" content="/cover.jpg"><title>Fallback</title>`, 'https://example.com/watch'), {
    title: 'A & B 🍻', thumbnail_url: 'https://example.com/cover.jpg', author_name: null,
  });
  assert.equal(openGraph('<title> A &lt; B </title>', 'https://example.com').title, 'A < B');
  assert.equal(openGraph('<meta property="og:image" content="javascript:alert(1)">', 'https://example.com').thumbnail_url, null);
  assert.equal(durationSeconds('P1DT2H3M4S'), 93784);
  assert.equal(durationSeconds('invalid'), null);
});

test('YouTube metadata uses the API when configured and falls back to oEmbed on failure', async () => {
  const full = await fetchMetadata(video, { YOUTUBE_API_KEY: 'test-only' }, { fetcher: async url => {
    assert.equal(new URL(url).hostname, 'www.googleapis.com');
    return Response.json({ items: [{ snippet: { title: 'Title', channelTitle: 'Channel', publishedAt: '2026-10-01T00:00:00Z', thumbnails: { high: { url: 'https://i.ytimg.com/cover.jpg' } } }, contentDetails: { duration: 'PT3M20S' }, status: { embeddable: true } }] });
  } });
  assert.equal(full.duration, 200);
  assert.equal(full.title, 'Title');
  let calls = 0;
  const fallback = await fetchMetadata(video, { YOUTUBE_API_KEY: 'test-only' }, { fetcher: async () => ++calls === 1 ? new Response('quota', { status: 403 }) : Response.json({ title: 'Fallback', thumbnail_url: 'https://i.ytimg.com/cover.jpg' }) });
  assert.equal(calls, 2);
  assert.equal(fallback.title, 'Fallback');
});

test('Vimeo strips unsupported query parameters; direct media never gets downloaded for metadata', async () => {
  const vimeo = await fetchMetadata({ url: 'https://vimeo.com/123?unknown=value', source_type: 'vimeo' }, {}, { fetcher: async url => {
    assert.equal(new URL(url).searchParams.get('url'), 'https://vimeo.com/123');
    return Response.json({ title: 'Vimeo', duration: 42 });
  } });
  assert.equal(vimeo.duration, 42);
  let directFetches = 0;
  const direct = await fetchMetadata({ url: 'https://example.com/movie.mp4', source_type: 'direct_url' }, {}, { fetcher: async () => { directFetches++; return new Response('video'); } });
  assert.equal(direct, null);
  assert.equal(directFetches, 0);
});

test('hashed cache keys contain no URL credentials and repeated requests reuse metadata', async () => {
  const entries = new Map();
  const cache = { match: async key => entries.get(key)?.clone(), put: async (key, response) => { assert.match(key, /^https:\/\/metadata\.byob\.invalid\/[0-9a-f]{64}$/); entries.set(key, response); } };
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ title: 'Cached' }); };
  assert.equal((await fetchMetadata(video, {}, { fetcher, cache })).title, 'Cached');
  assert.equal((await fetchMetadata(video, {}, { fetcher, cache })).title, 'Cached');
  assert.equal(calls, 1);
});
