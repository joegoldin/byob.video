import { render } from './html.mjs';
import { votingPanel, roulettePanel } from './views.mjs';
import { mountHook } from './hooks.mjs';
import RoundTimer from '../../assets/js/hooks/round_timer.js';
import RouletteWheel from '../../assets/js/hooks/roulette_wheel.js';

export function mountRounds(element, channel) {
  let id, timer, wheel, seed;
  function destroy() {
    timer?.destroy(); wheel?.destroy();
    timer = wheel = null;
    id = seed = undefined;
  }
  return {
    destroy,
    update(round, owner) {
      const sameWheel = wheel && id === round?.id;
      if (!sameWheel) {
        destroy();
        // A viewer arriving during the reveal sees the selected winner rather
        // than restarting a full animation that would outlast finalization.
        const animate = round?.mode === 'roulette' && round.phase === 'active';
        render(element, animate ? roulettePanel(round, owner) : votingPanel(round, owner));
        id = round?.id;
        if (animate) wheel = mountHook(RouletteWheel, element.querySelector('#roulette-wheel'), channel);
        if (round) timer = mountHook(RoundTimer, element, channel);
      }
      if (!round) return;
      Object.assign(element.dataset, { expiresAt: round.expires_at, serverTime: round.server_time, phase: round.phase });
      timer?.update();
      if (round.phase !== 'active') element.querySelector('#round-timer-label')?.replaceChildren();
      if (wheel && round.phase === 'revealing' && seed !== round.seed) {
        seed = round.seed;
        const cancel = element.querySelector('[data-action="round-cancel"]');
        if (cancel) cancel.remove();
        const winner = round.candidates.find(item => item.external_id === round.winner_external_id);
        element.querySelector('#roulette-winner-text').textContent = winner?.title || 'Selected video';
        channel.emit('round:spin_land', { seed });
      }
    },
  };
}
