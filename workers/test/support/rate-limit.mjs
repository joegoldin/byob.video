import assert from 'node:assert/strict';

export async function assertReadRateLimit(read, { limit, period }, now = Date.now) {
  const started = now();
  // Fixed windows align to the wall clock. A burst can straddle two windows,
  // so limit + 1 requests is insufficient even when enforcement is correct.
  for (let attempt = 0; attempt < 2 * limit + 1; attempt++) {
    const response = await read();
    assert.ok(now() - started < period * 1000, 'Rate-limit burst must finish within one period to span at most two fixed windows');
    if (response.status === 429) {
      assert.equal(response.body.error, 'Rate limited. Slow down.', 'The rejection must come from rate limiting, not capacity or another guard');
      return;
    }
    assert.equal(response.status, 200, 'Rate-limit probe must otherwise be an authenticated successful read');
  }
  assert.fail(`Authenticated reads did not enforce the configured limit (${limit}/${period}s) across a ${2 * limit + 1}-request burst`);
}
