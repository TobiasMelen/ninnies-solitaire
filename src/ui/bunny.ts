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

const POPS: Record<BunnyEvent | 'tap' | 'idle' | 'hint' | 'hintTarget' | 'hintDeal', Pop[]> = {
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
  idle: [{ icon: '💡' }],
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

/** Placeholder art until a photo set is chosen; the art slot is swappable. */
const DRAWN = `
<svg viewBox="0 0 120 116" aria-hidden="true">
  <g class="ear ear-l">
    <ellipse cx="44" cy="36" rx="12.5" ry="31" fill="#fbf6ee" stroke="#3b2f27" stroke-width="3"/>
    <ellipse cx="44" cy="40" rx="6" ry="21" fill="#f5b3c1"/>
  </g>
  <g class="ear ear-r">
    <ellipse cx="78" cy="36" rx="12.5" ry="31" fill="#fbf6ee" stroke="#3b2f27" stroke-width="3"/>
    <ellipse cx="78" cy="40" rx="6" ry="21" fill="#f5b3c1"/>
  </g>
  <ellipse cx="61" cy="84" rx="41" ry="33" fill="#fbf6ee" stroke="#3b2f27" stroke-width="3"/>
  <ellipse cx="37" cy="93" rx="7.5" ry="4.5" fill="#f5a3b5" opacity="0.65"/>
  <ellipse cx="85" cy="93" rx="7.5" ry="4.5" fill="#f5a3b5" opacity="0.65"/>
  <g class="eyes">
    <g class="gaze">
      <ellipse cx="47" cy="80" rx="5.6" ry="6.6" fill="#2b211b"/>
      <circle cx="49" cy="77.6" r="1.9" fill="#fff"/>
      <ellipse cx="75" cy="80" rx="5.6" ry="6.6" fill="#2b211b"/>
      <circle cx="77" cy="77.6" r="1.9" fill="#fff"/>
    </g>
  </g>
  <path d="M57.5 89.5 h7 l-3.5 4 z" fill="#ef8ea3" stroke="#3b2f27" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M55 96 q3 3.5 6 0 q3 3.5 6 0" fill="none" stroke="#3b2f27" stroke-width="2" stroke-linecap="round"/>
  <ellipse cx="38" cy="114" rx="13" ry="8" fill="#fbf6ee" stroke="#3b2f27" stroke-width="3"/>
  <ellipse cx="84" cy="114" rx="13" ry="8" fill="#fbf6ee" stroke="#3b2f27" stroke-width="3"/>
</svg>`;

export interface HintTarget {
  /** 0–1 across the board: the card to move, and where it goes (or the stock for "deal"). */
  from: number;
  to?: number;
}

export class Bunny {
  private el: HTMLElement;
  private popEl: HTMLElement;
  private gaze: SVGGElement | null;
  private enabled = false;
  private lastPop = 0;
  private timers = new Set<number>();
  private idleTimer = 0;
  private blinkTimer = 0;
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
    this.el.innerHTML = `<div class="bunny-pop" aria-hidden="true"></div><div class="bunny-body">${DRAWN}</div>`;
    host.appendChild(this.el);
    this.popEl = this.el.querySelector('.bunny-pop')!;
    this.gaze = this.el.querySelector('.gaze');
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
    clearTimeout(this.blinkTimer);
    clearTimeout(this.idleTimer);
    if (on) {
      this.scheduleBlink();
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
    if (x !== undefined) this.look(x);
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
    this.el.classList.toggle('facing-left', dx < 0);
    this.el.classList.add('walking');
    this.later(360, () => this.el.classList.remove('walking'));
    this.look(x);
  }

  private goHome() {
    this.el.style.setProperty('--walk', '0px');
    this.el.classList.remove('facing-left');
    this.busyUntil = 0;
  }

  /** Point the eyes toward where the action is, then drift back to the player. */
  private look(x: number) {
    if (!this.gaze) return;
    const rect = this.el.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    const dx = Math.max(-1, Math.min(1, (host.left + x * host.width - (rect.left + rect.width / 2)) / (host.width / 2)));
    this.gaze.style.transform = `translate(${dx * 3.5}px, -2.5px)`;
    this.later(1600, () => this.gaze && (this.gaze.style.transform = ''));
  }

  private scheduleBlink() {
    this.blinkTimer = window.setTimeout(
      () => {
        this.el.classList.add('blink');
        window.setTimeout(() => this.el.classList.remove('blink'), 140);
        if (this.enabled) this.scheduleBlink();
      },
      2500 + Math.random() * 4000,
    );
  }

  private resetIdle() {
    clearTimeout(this.idleTimer);
    this.el.classList.remove('waiting');
    this.idleTimer = window.setTimeout(() => {
      if (!this.enabled || document.hidden) return;
      // A glowing bulb invites a tap for a hint.
      this.el.classList.add('waiting');
      this.gesture('perk', 900);
      this.pop('idle');
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
