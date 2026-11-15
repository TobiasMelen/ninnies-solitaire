import photoUrl from '../assets/bunny/bunny.webp';

/**
 * Hint Bunny: a companion peeking over the bottom edge of the table. It never talks; it reacts
 * with gestures and game-show style pop-up stamps (◯, ✕, !, ?, sparkles…), and it gives hints by
 * hopping under the card to move and then under where it should go.
 */

export type BunnyEvent =
  | 'start'
  | 'move'
  | 'reveal'
  | 'suit'
  | 'complete'
  | 'deal'
  | 'undo'
  | 'invalid'
  | 'stuck'
  | 'win';

/** Inline SVG for the two signature game-show stamps; everything else is an emoji sticker. */
const MARU = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="34" fill="none" stroke="#fff" stroke-width="26"/><circle cx="50" cy="50" r="34" fill="none" stroke="#e8352b" stroke-width="15"/></svg>`;
const BATSU = `<svg viewBox="0 0 100 100"><path d="M22 22 78 78M78 22 22 78" stroke="#fff" stroke-width="28" stroke-linecap="round"/><path d="M22 22 78 78M78 22 22 78" stroke="#2d6fe0" stroke-width="16" stroke-linecap="round"/></svg>`;

type Pop = { icon: string; big?: boolean; burst?: boolean };

const POPS: Record<BunnyEvent | 'tap' | 'hint' | 'hintTarget' | 'hintDeal', Pop[]> = {
  start: [{ icon: '✨' }, { icon: '🎵' }],
  move: [{ icon: '🎵' }, { icon: '👍' }],
  reveal: [{ icon: '❗' }, { icon: '👀' }],
  suit: [{ icon: MARU }],
  complete: [{ icon: MARU, big: true, burst: true }],
  deal: [{ icon: '🃏' }],
  undo: [{ icon: '❓' }],
  invalid: [{ icon: BATSU }],
  stuck: [{ icon: '💧' }],
  win: [{ icon: '👑', big: true, burst: true }],
  tap: [{ icon: '💖' }],
  hint: [{ icon: '💡' }],
  hintTarget: [{ icon: MARU }],
  hintDeal: [{ icon: '👆' }],
};

/** How often each event gets a pop-up; the rest just get a look and an ear twitch. */
const CHANCE: Record<BunnyEvent, number> = {
  start: 0.8,
  move: 0.1,
  reveal: 0.45,
  suit: 0.4,
  complete: 1,
  deal: 0.35,
  undo: 0.6,
  invalid: 0.8,
  stuck: 1,
  win: 1,
};

const GESTURE: Record<BunnyEvent, string> = {
  start: 'hop',
  move: 'twitch',
  reveal: 'perk',
  suit: 'nod',
  complete: 'hop',
  deal: 'twitch',
  undo: 'tilt',
  invalid: 'shake',
  stuck: 'sad',
  win: 'party',
};

const IMPORTANT = new Set<string>(['complete', 'stuck', 'win', 'tap', 'hint', 'hintTarget', 'hintDeal', 'invalid']);
const IDLE_MS = 40_000;
const QUIET_MS = 4_000;

export interface HintTarget {
  /** 0–1 across the board: the card to move, and where it goes (or the stock for "deal"). */
  from: number;
  to?: number;
}

export class Bunny {
  private el: HTMLElement;
  private popEl: HTMLElement;
  private enabled = false;
  private lastPop = 0;
  private timers = new Set<number>();
  private idleTimer = 0;
  private moodTimer = 0;
  private popTimer = 0;
  private busyUntil = 0;
  /** Asked for when the bunny is tapped; returns where the hint is, or null when there's none. */
  onAskHint: () => void = () => {};

  constructor(private host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'bunny';
    this.el.setAttribute('role', 'button');
    this.el.setAttribute('aria-label', 'Hint Bunny: tap for a hint');
    // A real rabbit photo (see assets/bunny/CREDITS.txt); gestures are done with motion.
    this.el.innerHTML = `<div class="bunny-pop" aria-hidden="true"></div><div class="bunny-body"><img src="${photoUrl}" alt="" draggable="false"></div>`;
    this.el.classList.add('facing-right'); // at home in the corner it looks toward the table
    host.appendChild(this.el);
    this.popEl = this.el.querySelector('.bunny-pop')!;
    // Its own taps must not start anything on the table underneath.
    this.el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (!this.enabled) return;
      this.resetIdle();
      this.onAskHint();
    });
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.el.classList.toggle('on', on);
    clearTimeout(this.idleTimer);
    if (on) {
      this.resetIdle();
    } else {
      this.goHome();
    }
  }

  get on() {
    return this.enabled;
  }

  /** React to something on the table. `x` is where it happened, 0–1 across the board. */
  react(event: BunnyEvent, x?: number) {
    if (!this.enabled) return;
    this.resetIdle();
    // Don't interrupt a hint walk with small reactions.
    if (performance.now() < this.busyUntil && !IMPORTANT.has(event)) return;
    if (x !== undefined) this.face(x);
    this.gesture(GESTURE[event], event === 'win' ? 6000 : 900);
    if (Math.random() < CHANCE[event]) this.pop(event);
  }

  /** Walk over to the card to move, point at it, then hop to where it goes. */
  hint(target: HintTarget | null, kind: 'move' | 'deal' | 'none') {
    if (!this.enabled) return;
    this.resetIdle();
    this.clearTimers();
    if (kind === 'none' || !target) {
      this.goHome();
      this.gesture('sad', 1400);
      this.pop('stuck');
      return;
    }
    this.busyUntil = performance.now() + 3200;
    this.walkTo(target.from);
    this.later(380, () => {
      this.gesture('perk', 700);
      this.pop(kind === 'deal' ? 'hintDeal' : 'hint');
    });
    if (kind === 'move' && target.to !== undefined) {
      const to = target.to;
      this.later(1250, () => {
        this.walkTo(to);
        this.later(380, () => {
          this.gesture('nod', 700);
          this.pop('hintTarget');
        });
      });
    }
    this.later(3200, () => this.goHome());
  }

  private pop(kind: keyof typeof POPS) {
    const now = performance.now();
    if (!IMPORTANT.has(kind) && now - this.lastPop < QUIET_MS) return;
    this.lastPop = now;
    const options = POPS[kind];
    const p = options[Math.floor(Math.random() * options.length)];
    this.popEl.className = `bunny-pop${p.big ? ' big' : ''}${p.burst ? ' burst' : ''}`;
    this.popEl.innerHTML = `<span class="pop-icon">${p.icon}</span>`;
    void this.popEl.offsetWidth; // restart the stamp animation
    this.popEl.classList.add('show');
    clearTimeout(this.popTimer);
    this.popTimer = window.setTimeout(() => this.popEl.classList.remove('show'), p.big ? 2200 : 1300);
  }

  private gesture(name: string, ms: number) {
    const all = ['hop', 'twitch', 'perk', 'nod', 'tilt', 'shake', 'sad', 'party'];
    this.el.classList.remove(...all);
    void this.el.offsetWidth;
    this.el.classList.add(name);
    clearTimeout(this.moodTimer);
    this.moodTimer = window.setTimeout(() => this.el.classList.remove(name), ms);
  }

  /** Hop along the bottom edge until centred under `x` (0–1 across the board). */
  private walkTo(x: number) {
    const w = this.el.offsetWidth;
    const hostW = this.host.clientWidth;
    const left = parseFloat(getComputedStyle(this.el).left) || 0;
    const dx = Math.max(0, Math.min(hostW - w, x * hostW - w / 2)) - left;
    this.el.style.setProperty('--walk', `${dx}px`);
    this.el.classList.toggle('facing-right', dx > 0);
    this.el.classList.add('walking');
    this.later(360, () => this.el.classList.remove('walking'));
  }

  private goHome() {
    this.el.style.setProperty('--walk', '0px');
    this.el.classList.add('facing-right');
    this.busyUntil = 0;
  }

  /** Turn toward where the action is (the photo looks left by default). */
  private face(x: number) {
    const rect = this.el.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    this.el.classList.toggle('facing-right', host.left + x * host.width > rect.left + rect.width / 2);
  }

  private resetIdle() {
    clearTimeout(this.idleTimer);
    // Never offers hints on its own: while the player thinks it just fidgets quietly.
    this.idleTimer = window.setTimeout(() => {
      if (!this.enabled || document.hidden) return;
      this.gesture('twitch', 900);
      this.resetIdle();
    }, IDLE_MS);
  }

  private later(ms: number, fn: () => void) {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  private clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }
}
