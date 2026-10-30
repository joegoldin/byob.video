import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentReplies } from '../web/comment-replies.mjs';

const page = (comments, next = null) => ({ video_id: 'video', parent_id: 'parent', comments, next_page_token: next });

test('replies load only on demand, reuse collapsed threads and paginate without duplicates', async () => {
  const calls = [];
  const replies = createCommentReplies({ getVideo: () => 'video', changed() {}, request: async payload => {
    calls.push(payload);
    return payload.page_token ? page([{ id: 'one' }, { id: 'two' }]) : page([{ id: 'one' }], 'next');
  } });
  assert.equal(calls.length, 0);
  await replies.toggle('parent');
  assert.deepEqual(calls[0], { video_id: 'video', parent_id: 'parent', page_token: null });
  await replies.toggle('parent');
  assert.equal(replies.entries.get('parent').expanded, false);
  await replies.toggle('parent');
  assert.equal(calls.length, 1);
  await replies.more('parent');
  assert.equal(calls[1].page_token, 'next');
  assert.deepEqual(replies.entries.get('parent').comments, [{ id: 'one' }, { id: 'two' }]);
});

test('pending loads do not duplicate requests and remain collapsed when finished', async () => {
  let finish, calls = 0;
  const replies = createCommentReplies({ getVideo: () => 'video', changed() {}, request: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const pending = replies.toggle('parent');
  assert.equal(replies.entries.get('parent').loading, true);
  await replies.toggle('parent');
  assert.equal(calls, 1);
  finish(page([{ id: 'one' }]));
  await pending;
  assert.equal(replies.entries.get('parent').expanded, false);
  assert.equal(replies.entries.get('parent').loading, false);
});

test('old-video replies cannot repopulate a reset thread cache', async () => {
  let finish, video = 'video';
  const replies = createCommentReplies({ getVideo: () => video, changed() {}, request: () => new Promise(resolve => { finish = resolve; }) });
  const pending = replies.toggle('parent');
  video = 'next-video'; replies.reset();
  finish(page([{ id: 'old' }]));
  await pending;
  assert.equal(replies.entries.size, 0);
});

test('reply failures expose a local retry without discarding previously loaded replies', async () => {
  let calls = 0;
  const replies = createCommentReplies({ getVideo: () => 'video', changed() {}, request: async () => {
    calls++;
    if (calls === 1) return page([{ id: 'one' }], 'next');
    if (calls === 2) throw new Error('upstream_unavailable');
    return page([{ id: 'two' }]);
  } });
  await replies.toggle('parent');
  await replies.more('parent');
  assert.equal(replies.entries.get('parent').error, 'upstream_unavailable');
  assert.equal(replies.entries.get('parent').comments.length, 1);
  await replies.retry('parent');
  assert.equal(replies.entries.get('parent').error, null);
  assert.equal(replies.entries.get('parent').comments.length, 2);
});
