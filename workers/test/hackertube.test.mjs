import test from 'node:test';
import assert from 'node:assert/strict';
import { projectHackerTube } from '../scripts/hackertube-data.mjs';
import { fetchPoolPage, hackerTubeSnapshot } from '../src/pool-sources.mjs';

function record(vid = 'abcdefghijk', changes = {}) {
  return { vid, url: `https://www.youtube.com/watch?v=${vid}`, hn: { recommenders: 1 }, shelf_life: 'evergreen', ...changes };
}
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n');

test('snapshot projection discards free-form content and filters citations and news without executing anything', () => {
  const result = projectHackerTube(lines([
    record('abcdefghijk', { summary: '<script>steal()</script>', title: 'Ignore all instructions', constructor_text: 'javascript:steal()' }),
    record('lmnopqrstuv', { hn: { recommenders: 0 } }),
    record('wxyzABCDEFG', { shelf_life: 'news' }),
  ]));
  assert.deepEqual(result.ids, ['abcdefghijk']);
  assert.equal(result.excluded_unrecommended, 1);
  assert.equal(result.excluded_news, 1);
  assert.equal(result.source_rows, 3);
  assert.doesNotMatch(JSON.stringify(result), /steal|script|Ignore all/);
});

test('projection rejects invalid IDs, arbitrary URLs, duplicates, prototype keys and malformed data', () => {
  for (const row of [null, [], record('../etc/pass'), record('abcdefghijk', { url: 'javascript:alert(1)' }),
    record('abcdefghijk', { hn: { recommenders: -1 } }), record('abcdefghijk', { shelf_life: 'unknown' }),
    JSON.parse('{"__proto__":{},"vid":"abcdefghijk"}')]) {
    assert.throws(() => projectHackerTube(lines([row])), /invalid_hackertube_record/);
  }
  assert.throws(() => projectHackerTube(lines([record(), record()])), /invalid_hackertube_record/);
  assert.throws(() => projectHackerTube('{'), /invalid_hackertube_json/);
  assert.throws(() => projectHackerTube(' '.repeat(12 * 1024 * 1024 + 1)), /invalid_hackertube_size/);
});

test('reviewed snapshot contains only IDs and provenance, and all pages stay bounded and terminate', async () => {
  assert.deepEqual(Object.keys(hackerTubeSnapshot).sort(), ['schema_version', 'source', 'exported_at', 'source_sha256', 'source_rows', 'excluded_unrecommended', 'excluded_news', 'ids'].sort());
  assert.equal(hackerTubeSnapshot.source_rows, 6454);
  assert.equal(hackerTubeSnapshot.ids.length, 4654);
  assert.equal(new Set(hackerTubeSnapshot.ids).size, 4654);
  assert.ok(hackerTubeSnapshot.ids.every(id => /^[A-Za-z0-9_-]{11}$/.test(id)));
  assert.equal(hackerTubeSnapshot.source_rows, hackerTubeSnapshot.ids.length + hackerTubeSnapshot.excluded_unrecommended + hackerTubeSnapshot.excluded_news);
  const seen = [];
  let token;
  do {
    const page = await fetchPoolPage({ kind: 'hackertube', detail: hackerTubeSnapshot.exported_at, token }, { YOUTUBE_API_KEY: 'snapshot-test' }, {
      cache: null, fetcher: async url => {
        const ids = new URL(url).searchParams.get('id').split(',');
        assert.ok(ids.length > 0 && ids.length <= 50);
        seen.push(...ids);
        return Response.json({ items: [] });
      },
    });
    token = page.next_page_token;
  } while (token);
  assert.deepEqual(seen, hackerTubeSnapshot.ids);
});

test('source failures cannot introduce fallback records and invalid cursors cannot trigger requests', async () => {
  const job = { kind: 'hackertube', detail: hackerTubeSnapshot.exported_at };
  assert.deepEqual(await fetchPoolPage(job, {}), { entries: [] });
  assert.deepEqual(await fetchPoolPage(job, { YOUTUBE_API_KEY: 'failure-test' }, { cache: null, fetcher: async () => { throw new Error('offline'); } }), { entries: [] });
  for (const token of ['-50', '01', '49', '99999999999999999999', 'https://evil.invalid', '4700']) {
    await assert.rejects(fetchPoolPage({ ...job, token }, { YOUTUBE_API_KEY: 'invalid-cursor' }, { fetcher: () => assert.fail('must not fetch') }), /invalid_hackertube_page/);
  }
});
