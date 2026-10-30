import test from 'node:test';
import assert from 'node:assert/strict';
import { apiToken, matchesKey, readJson, requestError } from '../src/http.mjs';

test('API credentials preserve bearer precedence and query compatibility', async () => {
  const request = new Request('https://example.test/api?api_key=query-value', { headers: { Authorization: 'Bearer header-value ' } });
  assert.equal(apiToken(request), 'header-value');
  assert.equal(apiToken(new Request('https://example.test/?api_key=query-value')), 'query-value');
  assert.equal(await matchesKey('correct', 'correct'), true);
  assert.equal(await matchesKey('correct', 'incorrect'), false);
  assert.equal(await matchesKey('correct', ''), false);
  assert.equal(await matchesKey('correct', 'x'.repeat(257)), false);
});

test('request JSON bounds streamed bytes and rejects scalar/array/malformed payloads', async () => {
  const request = body => new Request('https://example.test/', { method: 'POST', body });
  assert.deepEqual(await readJson(request('{"position":12}')), { position: 12 });
  assert.deepEqual(await readJson(request('')), {});
  for (const body of ['null', '[]', '1', '{broken']) await assert.rejects(readJson(request(body)), /invalid_json/);
  await assert.rejects(readJson(request('"☃☃☃"'), 8), /body_too_large/);
  assert.equal(requestError(new Error('body_too_large')).status, 413);
});

test('unexpected exceptions do not expose implementation details or credentials', async () => {
  const response = requestError(new Error('sensitive-internal-details'));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error.' });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
