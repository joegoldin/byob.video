import { createHash } from 'node:crypto';

export const hackerTubeExport = Object.freeze({
  exported_at: '2026-10-31',
  sha256: '4a63125d00076015eb04edf0eb65f9524410bb60f88c3b67d61e767a19389b1e',
  rows: 6454,
});

export function projectHackerTube(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 12 * 1024 * 1024) throw new Error('invalid_hackertube_size');
  const ids = [], seen = new Set();
  let excluded_unrecommended = 0, excluded_news = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 65536) throw new Error('invalid_hackertube_record');
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('invalid_hackertube_json'); }
    if (!row || Array.isArray(row) || typeof row !== 'object' ||
        ['__proto__', 'constructor', 'prototype'].some(key => Object.hasOwn(row, key)) ||
        typeof row.vid !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(row.vid) ||
        row.url !== `https://www.youtube.com/watch?v=${row.vid}` || seen.has(row.vid) ||
        !Number.isSafeInteger(row.hn?.recommenders) || row.hn.recommenders < 0 ||
        !['evergreen', 'dated', 'news'].includes(row.shelf_life)) throw new Error('invalid_hackertube_record');
    seen.add(row.vid);
    if (row.hn.recommenders === 0) excluded_unrecommended++;
    else if (row.shelf_life === 'news') excluded_news++;
    else ids.push(row.vid);
  }
  // Never carry model-written text, arbitrary URLs or instructions into the app.
  return { schema_version: 1, source: 'https://hackertube.org/data', exported_at: hackerTubeExport.exported_at,
    source_sha256: createHash('sha256').update(text).digest('hex'), source_rows: seen.size,
    excluded_unrecommended, excluded_news, ids };
}
