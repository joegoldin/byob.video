import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaUrl, youtubePlaylist } from '../src/media.mjs';

test('DNS case and root-dot aliases cannot bypass self-reference and DRM checks', () => {
  for (const url of ['https://BYOB.VIDEO./room/a', 'https://www.byob.video./', 'https://PREVIEW.EXAMPLE.TEST./room/a']) {
    assert.throws(() => parseMediaUrl(url, ['Preview.Example.Test.']), error => error.code === 'self_reference');
  }
  assert.throws(() => parseMediaUrl('https://www.netflix.com./watch/1'), error => error.code === 'drm_site');
  assert.equal(parseMediaUrl('https://byob.video.example.test/video.webm').source_type, 'direct_url');
});

test('provider root-dot aliases retain source and playlist recognition', () => {
  assert.equal(parseMediaUrl('https://YOUTU.BE./dQw4w9WgXcQ').source_type, 'youtube');
  assert.equal(parseMediaUrl('https://player.vimeo.com./video/123').source_id, '123');
  assert.equal(youtubePlaylist('https://www.youtube.com./watch?v=video&list=PLfixture').id, 'PLfixture');
});
