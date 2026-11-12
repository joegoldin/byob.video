import { render } from './html.mjs';
import { commentsPanel } from './views.mjs';

export function createCommentsRenderer() {
  let previousPanel, previousVideo, previousMarkup;
  return (panel, video, page, options) => {
    const content = commentsPanel(page, options);
    const markup = String(content);
    const sameVideo = panel === previousPanel && video === previousVideo;
    // Room snapshots should not replace an unchanged scrollbox (or its focused controls).
    if (sameVideo && markup === previousMarkup) return;
    const scrollTop = sameVideo ? panel.scrollTop : 0;
    const listTop = sameVideo ? panel.querySelector('[data-comments-list]')?.scrollTop || 0 : 0;
    render(panel, content);
    const list = panel.querySelector('[data-comments-list]');
    if (list) list.scrollTop = listTop;
    panel.scrollTop = scrollTop;
    previousPanel = panel;
    previousVideo = video;
    previousMarkup = markup;
  };
}
