/**
 * Screen changes as an app-style navigation stack, animated with View Transitions.
 *
 * Every change goes through `navigate(update)`. The update runs inside a view transition; once
 * it has run, the caller's `direction()` says whether the screen went deeper (push), back (pop)
 * or only a sheet opened or closed, and CSS plays the matching animation (see "navigation" in
 * style.css). Without View Transitions, or with reduced motion, updates simply apply.
 */

export type Direction = 'push' | 'pop' | 'sheet';

const doc = document as Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};
const supported =
  typeof doc.startViewTransition === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
if (supported) document.documentElement.classList.add('vt');

const KINDS = ['vt-push', 'vt-pop', 'vt-sheet'];
let updating = false;

/**
 * Apply `update` with a transition. Calls made while an update is already running (a dialog's
 * close handler opening the next screen, say) join that same transition.
 */
export function navigate(update: () => void, direction: () => Direction, animate = true) {
  if (updating) return update();
  const run = () => {
    updating = true;
    try {
      update();
    } finally {
      updating = false;
    }
  };
  if (!supported || !animate || document.hidden) return run();
  const html = document.documentElement;
  const t = doc.startViewTransition!(() => {
    run();
    html.classList.remove(...KINDS);
    html.classList.add(`vt-${direction()}`);
  });
  t.finished.finally(() => html.classList.remove(...KINDS));
}
