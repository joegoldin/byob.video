// Native proximity snapping can skip the player entirely on a large wheel or
// trackpad gesture. Catch approaches to that boundary without trapping exits.
export function detentTarget(position, anchor, delta) {
  const distance = anchor - position;
  if (Math.abs(distance) < 1 || distance * delta <= 0) return null;
  return Math.abs(delta) >= Math.abs(distance) - 80 ? anchor : null;
}

export function mountTheaterScroll(root, player, { window: win = window } = {}) {
  let timer, held = false, previous = win.scrollY;
  const active = () => root.classList.contains('theater-mode') && win.innerWidth >= 1024;
  const release = () => { held = false; previous = win.scrollY; root.dataset.theaterDetent = 'ready'; };
  release();
  function hold() {
    held = true;
    root.dataset.theaterDetent = 'held';
    clearTimeout(timer);
    timer = setTimeout(release, 180);
  }
  function wheel(event) {
    if (!active() || event.ctrlKey || event.defaultPrevented || !event.deltaY) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? win.innerHeight : 1);
    // Comments, queue and other nested scrolling surfaces keep their own input.
    for (let element = event.target; element instanceof win.Element && element !== root; element = element.parentElement) {
      if (/(auto|scroll)/.test(win.getComputedStyle(element).overflowY) &&
          element.scrollHeight > element.clientHeight &&
          (delta < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight - 1)) return;
    }
    const anchor = player.getBoundingClientRect().top + win.scrollY;
    const target = held ? anchor : detentTarget(win.scrollY, anchor, delta);
    if (target === null) return;
    event.preventDefault();
    win.scrollTo({ top: target, behavior: 'instant' });
    hold();
  }
  function scroll() {
    const position = win.scrollY;
    const anchor = player.getBoundingClientRect().top + position;
    // Wheel events inside provider iframes do not reach this window. Observe
    // the resulting page scroll too, so embeds get the same return detent.
    if (active() && Math.abs(position - anchor) >= 1 &&
        (held || (previous > anchor + 80 && position < previous && position <= anchor + 80))) {
      win.scrollTo({ top: anchor, behavior: 'instant' });
      hold();
    }
    previous = win.scrollY;
  }
  win.addEventListener('wheel', wheel, { passive: false });
  win.addEventListener('scroll', scroll);
  return () => { clearTimeout(timer); win.removeEventListener('wheel', wheel); win.removeEventListener('scroll', scroll); delete root.dataset.theaterDetent; };
}
