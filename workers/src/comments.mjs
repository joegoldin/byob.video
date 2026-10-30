import { youtubeData } from './youtube.mjs';
import { externalUrl } from './upstream.mjs';

const empty = () => ({ comments: [], next_page_token: null, total_count: 0 });
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function avatar(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try { return externalUrl(value).href; } catch { return null; }
}

function comment(item, replyCount = 0) {
  const snippet = item?.snippet ?? {};
  return { id: text(item?.id, 256), author: text(snippet.authorDisplayName, 300), author_avatar: avatar(snippet.authorProfileImageUrl),
    text: text(snippet.textDisplay, 10000), likes: count(snippet.likeCount), published_at: text(snippet.publishedAt, 40), reply_count: count(replyCount) };
}

export async function fetchCommentReplies(videoId, parentId, pageToken, env, options = {}) {
  if (typeof videoId !== 'string' || !/^[\w-]{1,128}$/.test(videoId) ||
      typeof parentId !== 'string' || !/^[\w.-]{1,256}$/.test(parentId) ||
      (pageToken != null && (typeof pageToken !== 'string' || pageToken.length > 2048))) return { error: 'invalid_comments_request' };
  const params = { part: 'snippet', parentId, maxResults: '20', textFormat: 'plainText' };
  if (pageToken) params.pageToken = pageToken;
  const result = await youtubeData('comments', params, env, options);
  if (['not_found', 'comments_disabled'].includes(result.error)) return { ...empty(), video_id: videoId, parent_id: parentId };
  if (result.error) return { error: result.error, video_id: videoId, parent_id: parentId };
  if (!Array.isArray(result.data.items)) return { error: 'invalid_response', video_id: videoId, parent_id: parentId };
  return { video_id: videoId, parent_id: parentId, comments: result.data.items.slice(0, 20).map(item => comment(item)),
    next_page_token: text(result.data.nextPageToken, 2048), total_count: count(result.data.pageInfo?.totalResults) };
}

export async function fetchComments(videoId, pageToken, env, options = {}) {
  if (typeof videoId !== 'string' || !/^[\w-]{1,128}$/.test(videoId) ||
      (pageToken != null && (typeof pageToken !== 'string' || pageToken.length > 2048))) return { error: 'invalid_comments_request' };
  const params = { part: 'snippet', videoId, order: 'relevance', maxResults: '20', textFormat: 'plainText' };
  if (pageToken) params.pageToken = pageToken;
  const result = await youtubeData('commentThreads', params, env, options);
  if (['not_found', 'comments_disabled'].includes(result.error)) return { ...empty(), video_id: videoId };
  if (result.error) return { error: result.error, video_id: videoId };
  if (!Array.isArray(result.data.items)) return { error: 'invalid_response', video_id: videoId };
  return {
    video_id: videoId,
    comments: result.data.items.slice(0, 20).map(item => comment(item?.snippet?.topLevelComment, item?.snippet?.totalReplyCount)),
    next_page_token: text(result.data.nextPageToken, 2048), total_count: count(result.data.pageInfo?.totalResults),
  };
}

export function commentsEvent(state, result) {
  const item = state.current_index === null ? null : state.queue[state.current_index];
  if (!result || result.error || item?.source_type !== 'youtube' || item.source_id !== result.video_id) return { state, events: [] };
  return { state, events: [['comments_updated', result]] };
}
