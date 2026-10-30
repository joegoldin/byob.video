export function createCommentReplies({ request, getVideo, changed }) {
  const entries = new Map();
  let epoch = 0;
  async function load(parentId, more = false) {
    const video = getVideo();
    if (!video) return;
    const entry = entries.get(parentId) || { comments: [], expanded: true, loaded: false };
    if (entry.loading || (more && !entry.next_page_token)) return;
    entries.set(parentId, entry);
    entry.loading = true;
    entry.error = null;
    const started = epoch;
    changed();
    try {
      const result = await request({ video_id: video, parent_id: parentId, page_token: more ? entry.next_page_token : null });
      if (started !== epoch || video !== getVideo() || result.stale) return;
      if (result.video_id !== video || result.parent_id !== parentId) throw new Error('Replies did not match this comment.');
      if (result.error) throw new Error(result.error);
      const existing = more ? entry.comments : [];
      const ids = new Set(existing.map(comment => comment.id));
      entry.comments = [...existing, ...result.comments.filter(comment => !ids.has(comment.id))];
      entry.next_page_token = result.next_page_token;
      entry.loaded = true;
    } catch (error) {
      if (started === epoch && video === getVideo()) entry.error = error.message;
    } finally {
      if (started === epoch && video === getVideo()) { entry.loading = false; changed(); }
    }
  }
  return {
    entries,
    reset() { epoch++; entries.clear(); },
    async toggle(parentId) {
      const entry = entries.get(parentId);
      if (entry) {
        entry.expanded = !entry.expanded;
        changed();
        if (!entry.expanded || entry.loaded || entry.loading) return;
      }
      await load(parentId);
    },
    more(parentId) { return load(parentId, true); },
    retry(parentId) { return load(parentId, !!entries.get(parentId)?.next_page_token); },
  };
}
