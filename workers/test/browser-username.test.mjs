import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsernamePreference } from '../web/username.mjs';

function fixture({ name, cookie = { value: '' }, hostname = 'byob.video', blocked = false, migrated = false } = {}) {
  const values = new Map(name === undefined ? [] : [['watchparty_username', name]]), writes = [];
  if (migrated) values.set('byob_username_cookie_migrated', '1');
  const document = { get cookie() { return cookie.value; }, set cookie(value) { writes.push(value); cookie.value = value.split(';')[0]; } };
  const window = { location: { hostname, protocol: 'https:' }, get localStorage() {
    if (blocked) throw new Error('storage denied');
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  } };
  return { values, writes, cookie, preference: createUsernamePreference({ window, document, random: () => 0 }) };
}

test('new visitors get a stable friendly legacy-style name rather than a numbered guest', () => {
  const f = fixture();
  assert.equal(f.preference.read(), 'SwiftHawk01');
  assert.equal(f.preference.read(), 'SwiftHawk01');
  assert.equal(f.values.get('watchparty_username'), 'SwiftHawk01');
  assert.match(f.writes.at(-1), /Max-Age=31536000/);
  assert.match(f.writes.at(-1), /Domain=byob\.video/);
  assert.match(f.writes.at(-1), /Secure/);
});

test('legacy custom and generated names migrate without being replaced', () => {
  for (const name of ['jor', 'NeatEagle13', 'Guest f42a', 'A name <3']) {
    const f = fixture({ name });
    assert.equal(f.preference.read(), name);
    assert.equal(decodeURIComponent(f.cookie.value.split('=')[1]), name);
  }
});

test('the shared preference restores across production hosts and survives cleared or unavailable localStorage', () => {
  const first = fixture({ name: 'My preferred name' });
  assert.equal(first.preference.read(), 'My preferred name');
  const www = fixture({ name: 'Stale name', cookie: first.cookie, hostname: 'www.byob.video', migrated: true });
  assert.equal(www.preference.read(), 'My preferred name', 'shared preference must beat stale origin-local storage');
  assert.equal(www.values.get('watchparty_username'), 'My preferred name');
  www.preference.save('New name 🦦');
  const restored = fixture({ cookie: first.cookie, blocked: true });
  assert.equal(restored.preference.read(), 'New name 🦦');
});

test('invalid stored values cannot prevent a usable name and development cookies stay host-scoped', () => {
  const f = fixture({ name: ' '.repeat(5), cookie: { value: 'byob_username=%zz' }, hostname: 'localhost' });
  assert.equal(f.preference.read(), 'SwiftHawk01');
  assert.doesNotMatch(f.writes.at(-1), /Domain=/);
  assert.throws(() => f.preference.save('x'.repeat(31)), /invalid_username/);
  assert.throws(() => f.preference.save('   '), /invalid_username/);
  f.preference.save('  Trimmed name  ');
  assert.equal(f.preference.read(), 'Trimmed name');
});

test('first-time cookie migration cannot overwrite an existing legacy custom name on the other host', () => {
  const f = fixture({ name: 'Legacy custom name', cookie: { value: 'byob_username=SwiftHawk01' } });
  assert.equal(f.preference.read(), 'Legacy custom name');
  assert.equal(f.values.get('byob_username_cookie_migrated'), '1');
  f.cookie.value = 'byob_username=Changed%20elsewhere';
  assert.equal(f.preference.read(), 'Changed elsewhere', 'after migration the shared preference follows later renames');
});
