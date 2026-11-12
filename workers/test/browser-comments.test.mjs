import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentsRenderer } from '../web/comments-panel.mjs';

const page = { comments: Array.from({ length: 20 }, (_, id) => ({ id: String(id), text: `Comment ${id}`, likes: 0 })) };

function panelFixture() {
  let list = { scrollTop: 0 };
  let writes = 0;
  return {
    scrollTop: 0,
    querySelector: () => list,
    set innerHTML(value) { writes++; list = { scrollTop: 0 }; this.scrollTop = 0; },
    get writes() { return writes; },
  };
}

test('unchanged room updates do not replace the comments scrollbox', () => {
  const update = createCommentsRenderer();
  const panel = panelFixture();
  update(panel, 'first', page);
  const list = panel.querySelector('[data-comments-list]');
  list.scrollTop = 240;
  update(panel, 'first', page);
  assert.equal(panel.querySelector('[data-comments-list]'), list);
  assert.equal(panel.writes, 1);
});

test('comments and replies updates preserve nested and expanded panel scroll offsets', () => {
  const update = createCommentsRenderer();
  const panel = panelFixture();
  update(panel, 'first', page);
  panel.querySelector('[data-comments-list]').scrollTop = 240;
  panel.scrollTop = 80;
  update(panel, 'first', { ...page, total_count: 25 });
  assert.equal(panel.querySelector('[data-comments-list]').scrollTop, 240);
  assert.equal(panel.scrollTop, 80);
  update(panel, 'second', page);
  assert.equal(panel.querySelector('[data-comments-list]').scrollTop, 0);
  assert.equal(panel.scrollTop, 0);
});
