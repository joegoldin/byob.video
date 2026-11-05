const RELOAD_KEY = 'byob_deployment_reload';
const CHECK_INTERVAL_MS = 30000;

export function watchDeployment({ build, window = globalThis.window, document = globalThis.document,
  fetch = (...args) => globalThis.fetch(...args), storage, reload = () => window.location.reload(),
  setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
  let pending, stopped = false, reloading = false;
  function check() {
    if (stopped || reloading) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetch('/build.json', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok) return;
        const next = (await response.json()).build;
        if (stopped || typeof next !== 'string' || !/^[a-f0-9]{64}$/.test(next) || next === build) return;
        // Preserve the cookie and tab ID. Remember this attempted transition
        // across reloads so a stale edge/browser asset cannot cause a loop.
        const guard = storage ?? window.sessionStorage;
        const transition = `${build}:${next}`;
        if (guard.getItem(RELOAD_KEY) === transition) return;
        guard.setItem(RELOAD_KEY, transition);
        reloading = true;
        reload();
      } catch {
        // Offline checks must not interrupt playback. Without writable session
        // storage, avoid reloading without a persistent loop guard.
      }
    })().finally(() => { pending = null; });
    return pending;
  }
  const visible = () => { if (!document.hidden) void check(); };
  const online = () => { void check(); };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('online', online);
  const timer = setInterval(() => { void check(); }, CHECK_INTERVAL_MS);
  return { check, stop() {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('online', online);
  } };
}
