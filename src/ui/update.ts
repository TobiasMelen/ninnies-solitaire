/**
 * Live updates. Every deploy publishes version.json with its commit (see vite.config.ts). The
 * app checks it on start, when it comes back to the foreground and every few minutes. When a
 * newer build is out it reloads at a quiet moment (in the background, or with nothing being
 * dragged, no dialog open and no touches for a few seconds) and comes back to the same screen.
 * Games save after every move, so a game in progress carries on exactly where it was.
 */
import type { GameId } from '../core/game';

export type Spot = { screen: 'home' } | { screen: 'game'; id: GameId };

const RESUME_KEY = 'ninnies.resumeAfterUpdate';
/** The build last reloaded for, so a reload that didn't pick it up isn't retried in a loop. */
const TRIED_KEY = 'ninnies.updateTried';
const CHECK_MS = 5 * 60_000;
const QUIET_MS = 3_000;

interface Options {
  /** Where the player is, or null while it isn't a good moment (dragging, a dialog open). */
  spot(): Spot | null;
  /** Save anything not yet saved; called just before reloading. */
  save(): void;
}

/** The spot to come back to after an update reload, if this load is one. */
export function takeResumeSpot(): Spot | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);
    const saved = raw ? (JSON.parse(raw) as Spot & { at: number }) : null;
    // Only straight after the reload, not if the tab is restored much later.
    return saved && Date.now() - saved.at < 30_000 ? saved : null;
  } catch {
    return null;
  }
}

export function watchForUpdates(opts: Options) {
  if (__COMMIT__ === 'dev') return;
  let lastInput = performance.now();
  let pending = false;
  let target = '';
  let quietTimer = 0;
  for (const type of ['pointerdown', 'pointermove', 'keydown'] as const)
    window.addEventListener(type, () => (lastInput = performance.now()), { capture: true, passive: true });

  const apply = () => {
    const spot = opts.spot();
    if (!spot) return false;
    opts.save();
    try {
      sessionStorage.setItem(TRIED_KEY, target);
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({ ...spot, at: Date.now() }));
    } catch {
      /* comes back to the menu instead */
    }
    location.reload();
    return true;
  };

  // Wait for a pause in play; while the app is hidden there's no need to wait.
  const tryApply = () => {
    clearTimeout(quietTimer);
    if (document.hidden || performance.now() - lastInput > QUIET_MS) {
      if (apply()) return;
    }
    quietTimer = window.setTimeout(tryApply, 1_000);
  };

  const check = async () => {
    if (pending) return;
    try {
      // The service worker leaves version.json alone; the query also skips any HTTP cache.
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { commit } = (await res.json()) as { commit?: string };
      if (!commit || commit === __COMMIT__) return;
      if (sessionStorage.getItem(TRIED_KEY) === commit) return;
      pending = true;
      target = commit;
      // Make sure the new service worker is in place before the reload.
      await navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
      tryApply();
    } catch {
      /* offline: try again later */
    }
  };

  check();
  window.setInterval(() => !document.hidden && check(), CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && pending) tryApply();
    else if (!document.hidden) check();
  });
}
