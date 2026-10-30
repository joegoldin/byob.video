import { newRound, castVote, resolveRound, tallies, roundTiming } from './round.mjs';
import { roundSnapshot, logActivity } from './room-state.mjs';
import { parseMediaUrl } from './media.mjs';
import { enqueue } from './queue.mjs';

function activity(result, action, userId, detail, now) {
  const state = logActivity(result.state, action, userId, detail, now);
  if (state !== result.state) result.events.push(['activity_log_entry', state.activity_log[0]]);
  return { ...result, state };
}

export function startRound(state, mode, userId, candidates, now) {
  if (state.round) throw new Error('round_active');
  if (!['voting', 'roulette'].includes(mode)) throw new Error('invalid_round');
  if (!candidates.length) throw new Error('no_candidates');
  const round = newRound(mode, userId, candidates.slice(0, mode === 'voting' ? 5 : 12), now);
  return activity({ state: { ...state, round }, events: [['round_started', roundSnapshot(round, now)]] }, mode === 'voting' ? 'vote_started' : 'roulette_started', userId, null, now);
}

function reveal(state, now, seed) {
  const result = resolveRound(state.round, seed);
  if (result.outcome === 'no_votes') return activity({ state: { ...state, round: null }, events: [['round_cancelled', { reason: 'no_votes' }]] }, 'round_cancelled', null, 'no votes cast', now);
  const round = { ...result.round, finalize_at: now + roundTiming[`${result.round.mode}_reveal`] };
  const payload = { mode: round.mode, winner_external_id: round.winner_external_id };
  if (round.mode === 'voting') payload.tallies = tallies(round);
  else payload.seed = round.seed;
  return { state: { ...state, round }, events: [['round_revealed', payload]] };
}

export function voteRound(state, userId, roundId, externalId, now, seed) {
  const round = state.round;
  if (!round || round.id !== roundId || round.phase !== 'active' || round.mode !== 'voting' || now >= round.expires_at) throw new Error('invalid_round');
  const updated = castVote(round, userId, externalId);
  const next = { ...state, round: updated };
  const present = Object.entries(state.users).filter(([, user]) => user.connected && !user.is_extension).map(([id]) => id);
  const voters = new Set(Object.values(updated.votes).flat());
  if (present.length && present.every(id => voters.has(id))) return reveal(next, now, seed);
  return { state: next, events: [['round_updated', roundSnapshot(updated, now)]] };
}

export function cancelRound(state, userId, roundId, now) {
  if (!state.round || state.round.id !== roundId || state.round.started_by !== userId || state.round.phase !== 'active') throw new Error('not_authorized');
  return activity({ state: { ...state, round: null }, events: [['round_cancelled', { reason: 'cancelled_by_starter' }]] }, 'round_cancelled', userId, 'cancelled', now);
}

export function advanceRound(state, now, seed) {
  const round = state.round;
  if (!round) return { state, events: [] };
  if (round.phase === 'active') return now >= round.expires_at ? reveal(state, now, seed) : { state, events: [] };
  if (round.finalize_at == null || now < round.finalize_at) return { state, events: [] };
  const candidate = round.candidates.find(value => value.external_id === round.winner_external_id);
  if (!candidate) return { state: { ...state, round: null }, events: [['round_finalized', {}]] };
  const item = { ...parseMediaUrl(`https://www.youtube.com/watch?v=${encodeURIComponent(candidate.external_id)}`),
    title: candidate.title, thumbnail_url: candidate.thumbnail_url, duration: candidate.duration_s ?? null, published_at: null,
    added_by: round.started_by, added_by_name: state.users[round.started_by]?.username ?? null, added_at: new Date(now).toISOString() };
  let result = enqueue({ ...state, round: null }, [item], 'queue', now);
  const count = round.votes[candidate.external_id]?.length ?? 0;
  const title = candidate.title ?? item.url;
  result = activity(result, round.mode === 'voting' ? 'vote_winner' : 'roulette_winner', null,
    round.mode === 'voting' ? `${title} (${count} vote${count === 1 ? '' : 's'})` : title, now);
  result.events.push(['round_finalized', {}]);
  return { ...result, metadata_item: item, picked_external_id: candidate.external_id };
}
