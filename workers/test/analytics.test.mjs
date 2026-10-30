import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsEvent, sendAnalytics, trackAnalytics } from '../src/analytics.mjs';

const id = '12345678-1234-4234-8234-123456789abc';

test('analytics allowlists event names, identifiers and legacy nonsensitive properties', () => {
  const event = analyticsEvent('video_embed_blocked', id, { room_id: 'oldroom1', source_type: 'youtube_restricted', error_code: 150,
    url: 'private-url', title: 'private-title', username: 'private-name', api_key: 'private-key', token: 'private-ticket' });
  assert.deepEqual(event, { event: 'video_embed_blocked', properties: { distinct_id: id, room_id: 'oldroom1', source_type: 'youtube_restricted', error_code: 150 } });
  assert.equal(analyticsEvent('arbitrary-event', id), null);
  assert.equal(analyticsEvent('room_joined', 'someone@example.com'), null);
  assert.deepEqual(analyticsEvent('$identify', id, { has_extension: true }).properties.$set, { has_extension: true });
});

test('analytics sanitizes again at the network boundary and refuses redirects or plaintext hosts', async () => {
  const env = { POSTHOG_API_KEY: 'fixture-project-key' };
  let sent;
  const fetcher = async (url, options) => { sent = { url: String(url), ...options }; return new Response('{}'); };
  assert.equal(await sendAnalytics(env, [{ event: 'video_added', properties: { distinct_id: id, source_type: 'youtube', url: 'private-url', api_key: 'room-key' } }], fetcher), true);
  assert.equal(sent.url, 'https://us.i.posthog.com/batch/');
  assert.equal(sent.redirect, 'manual');
  let redirects = 0;
  assert.equal(await sendAnalytics(env, [analyticsEvent('room_joined', id)], async () => { redirects++; return new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } }); }), false);
  assert.equal(redirects, 1);
  assert.deepEqual(JSON.parse(sent.body), { api_key: 'fixture-project-key', batch: [{ event: 'video_added', properties: { distinct_id: id, source_type: 'youtube' } }] });
  sent = null;
  assert.equal(await sendAnalytics({ ...env, POSTHOG_HOST: 'http://example.com' }, [analyticsEvent('room_joined', id)], fetcher), false);
  assert.equal(sent, null);
});

test('unconfigured analytics makes no network calls and service failure never escapes', async () => {
  let called = false;
  assert.equal(await sendAnalytics({}, [analyticsEvent('room_joined', id)], async () => { called = true; }), false);
  trackAnalytics({}, {}, 'room_created', id, { room_id: 'oldroom1' });
  assert.equal(called, false);
  assert.equal(await sendAnalytics({ POSTHOG_API_KEY: 'fixture-project-key' }, [analyticsEvent('room_joined', id)], async () => { throw new Error('Unavailable'); }), false);
});
