export const roundTiming = Object.freeze({ voting: 15000, roulette: 6500, voting_reveal: 1500, roulette_reveal: 8000 });

export function newRound(mode, userId, candidates, now) {
  if (!['voting', 'roulette'].includes(mode) || !candidates.length) throw new Error('invalid_round');
  return {
    id: crypto.randomUUID(), mode, started_by: userId, started_at: now,
    expires_at: now + roundTiming[mode], candidates,
    votes: mode === 'voting' ? Object.fromEntries(candidates.map(c => [c.external_id, []])) : {},
    seed: null, winner_external_id: null, phase: 'active',
  };
}

export function castVote(round, userId, externalId) {
  if (!round.candidates.some(c => c.external_id === externalId)) return round;
  const votes = Object.fromEntries(Object.entries(round.votes).map(([id, users]) => [id, users.filter(user => user !== userId)]));
  return { ...round, votes: { ...votes, [externalId]: [...(votes[externalId] ?? []), userId] } };
}

export function tallies(round) {
  return Object.fromEntries(Object.entries(round.votes).map(([id, users]) => [id, users.length]));
}

export function totalVoters(round) {
  return new Set(Object.values(round.votes).flat()).size;
}

// Keep this formula identical to the existing roulette animation and Elixir
// oracle: a server-selected seed must land on the same slice in every browser.
export function landingSlice(seed, count) {
  const v0 = 540 + (seed % 65536) / 65536 * 280;
  const duration = 3 + (Math.floor(seed / 65536) % 65536) / 65536 * 0.6;
  const rotation = v0 / (4 / duration) * (1 - Math.exp(-4));
  return Math.trunc((rotation % 360 + 360) % 360 / (360 / count)) % count;
}

export function resolveRound(previous, seed = crypto.getRandomValues(new Uint32Array(1))[0]) {
  const round = { ...previous, phase: 'revealing' };
  if (round.mode === 'roulette') {
    round.seed = seed;
    round.winner_external_id = round.candidates[landingSlice(seed, round.candidates.length)].external_id;
    return { round, outcome: 'winner_chosen' };
  }
  const counts = tallies(round), highest = Math.max(0, ...Object.values(counts));
  if (!highest) return { round, outcome: 'no_votes' };
  const winners = round.candidates.filter(c => counts[c.external_id] === highest);
  round.winner_external_id = winners[seed % winners.length].external_id;
  return { round, outcome: 'winner_chosen' };
}
