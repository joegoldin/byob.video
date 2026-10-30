import test from 'node:test';
import assert from 'node:assert/strict';
import { html, render, mediaUrl, duration } from '../web/html.mjs';

test('HTML templates escape untrusted text and attributes while composing trusted fragments', () => {
  const title = '"><img src=x onerror=alert(1)>';
  const result = html`<a title="${title}">${[html`<b>${'A&B'}</b>`, title]}${null}${false}</a>`;
  assert.equal(String(result), '<a title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"><b>A&amp;B</b>&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</a>');
  const element = {};
  render(element, result);
  assert.equal(element.innerHTML, String(result));
  assert.throws(() => render(element, { value: '<script>alert(1)</script>' }), /escaped HTML/);
});

test('media links exclude executable schemes and credentials', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,evil', 'https://user:secret@example.com', '/relative', null]) assert.equal(mediaUrl(value), '');
  assert.equal(mediaUrl('https://example.com/video.mp4'), 'https://example.com/video.mp4');
  assert.equal(duration(3661), '1:01:01');
  assert.equal(duration(61.9), '1:01');
  assert.equal(duration(null), '');
});
