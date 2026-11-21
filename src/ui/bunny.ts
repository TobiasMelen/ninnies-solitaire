/**
 * Hint Bunny: a companion peeking over the bottom edge of the table. It never talks; it reacts
 * with photo poses, motion gestures and pop-up stamps (stars, hearts and rainbows for good things,
 * broken hearts for bad ones), and it gives hints by hopping under the card to move and then under
 * where it should go.
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
  | 'win'
  | 'scare';

/** Photo poses (assets/bunny/<pose>.webp, all cropped to the same box so swaps don't jump). */
type Pose =
  | 'idle'
  | 'idle2'
  | 'idle3'
  | 'idle4'
  | 'idle5'
  | 'happy'
  | 'sad'
  | 'thinking'
  | 'angry'
  | 'bored'
  | 'idea'
  | 'proud'
  | 'aside'
  | 'shock'
  | 'love'
  | 'sleep';

const POSE_URLS = import.meta.glob<string>('../assets/bunny/*.webp', { eager: true, query: '?url', import: 'default' });
const poseUrl = (p: Pose) => POSE_URLS[`../assets/bunny/${p}.webp`];

/** A pose that has no photo yet stands in with the nearest one that does (idle always exists). */
const FALLBACK: Record<Pose, Pose> = {
  idle: 'idle',
  idle2: 'idle',
  idle3: 'idle',
  idle4: 'idle',
  idle5: 'idle',
  happy: 'idle',
  sad: 'idle',
  thinking: 'idle',
  angry: 'sad',
  bored: 'idle',
  idea: 'thinking',
  proud: 'happy',
  aside: 'idle',
  shock: 'angry',
  love: 'happy',
  sleep: 'bored',
};
const resolvePose = (p: Pose): Pose => (poseUrl(p) ? p : p === 'idle' ? p : resolvePose(FALLBACK[p]));

type Pop = { icon: string; big?: boolean; burst?: boolean };

/** Icons only, no words: stars, hearts and rainbows when it goes well, broken hearts when it doesn't. */
const POPS: Record<BunnyEvent | 'tap' | 'hint' | 'hintTarget' | 'hintDeal', Pop[]> = {
  start: [{ icon: '✨' }, { icon: '🌟' }],
  move: [{ icon: '⭐' }, { icon: '💫' }],
  reveal: [{ icon: '✨' }, { icon: '👀' }],
  suit: [{ icon: '💖' }, { icon: '💕' }],
  complete: [{ icon: '🌈', big: true, burst: true }],
  deal: [{ icon: '🃏' }],
  undo: [{ icon: '🙈' }],
  invalid: [{ icon: '💔' }],
  stuck: [{ icon: '😵' }, { icon: '💧' }, { icon: '😿' }],
  win: [{ icon: '🏆', big: true, burst: true }, { icon: '🌈', big: true, burst: true }],
  scare: [{ icon: '😱', big: true }],
  tap: [{ icon: '💕' }],
  hint: [{ icon: '💡' }],
  hintTarget: [{ icon: '⭐' }, { icon: '🌟' }],
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
  scare: 1,
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
  scare: 'shake',
};

/**
 * The photos that suit each moment; one is picked at random (back to idle when the gesture
 * ends), so the same kind of move doesn't always get the same face.
 */
const POSES: Record<BunnyEvent | 'idle' | 'tap' | 'hint' | 'hintTarget' | 'shrug', Pose[]> = {
  idle: ['idle', 'idle', 'idle2', 'idle3', 'idle4', 'idle5'],
  start: ['love', 'happy'],
  move: ['aside', 'aside', 'idle', 'thinking'],
  reveal: ['aside', 'shock', 'idea'],
  suit: ['happy', 'love', 'proud'],
  complete: ['proud', 'happy', 'love'],
  deal: ['aside', 'thinking', 'idle'],
  undo: ['sad', 'thinking'],
  invalid: ['angry', 'sad', 'shock'],
  stuck: ['sad', 'bored'],
  win: ['happy', 'proud', 'love'],
  scare: ['shock', 'angry'],
  tap: ['thinking', 'love'],
  hint: ['idea', 'thinking'],
  hintTarget: ['happy', 'proud'],
  shrug: ['sad', 'thinking'],
};

const IMPORTANT = new Set<string>(['complete', 'stuck', 'win', 'scare', 'tap', 'hint', 'hintTarget', 'hintDeal', 'invalid']);
/** Left alone, it gets bored, and a while later falls asleep (until anything happens). */
const IDLE_SHIFT_MS = 12_000;
const BORED_MS = 40_000;
const SLEEP_MS = 120_000;
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
  private resting = false;
  private shown: Pose = 'idle';
  private moodTimer = 0;
  private popTimer = 0;
  private busyUntil = 0;
  private poses = new Map<Pose, HTMLImageElement>();
  /** Where it sits when not hinting: an offset from its corner, moved aside when cards are in the way. */
  private homeDx = 0;
  /** Asked for when the bunny is tapped; returns where the hint is, or null when there's none. */
  onAskHint: () => void = () => {};

  constructor(private host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'bunny';
    this.el.setAttribute('role', 'button');
    this.el.setAttribute('aria-label', 'Hint Bunny: tap for a hint');
    // Photo poses (see assets/bunny/CREDITS.txt), all stacked and preloaded so a mood change is a
    // crossfade; gestures are done with motion on top.
    this.el.innerHTML = `<div class="bunny-pop" aria-hidden="true"></div><div class="bunny-body"></div>`;
    const body = this.el.querySelector('.bunny-body')!;
    for (const p of Object.keys(FALLBACK) as Pose[]) {
      const url = poseUrl(p);
      if (!url) continue;
      const img = document.createElement('img');
      img.className = `bunny-pose pose-${p}`;
      img.src = url;
      img.alt = '';
      img.draggable = false;
      body.appendChild(img);
      this.poses.set(p, img);
    }
    this.setPose(this.pick('idle'));
    // Sitting quietly, it shifts between its idle poses now and then.
    window.setInterval(() => {
      if (this.enabled && !this.resting && !document.hidden && POSES.idle.includes(this.shown)) this.setPose(this.pick('idle'));
    }, IDLE_SHIFT_MS);
    this.el.classList.add('facing-right'); // at home in the corner, side glances go toward the table
    host.appendChild(this.el);
    this.popEl = this.el.querySelector('.bunny-pop')!;
    // Its own taps must not start anything on the table underneath.
    this.el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (!this.enabled) return;
      this.resetIdle();
      this.gesture('nod', 900, this.pick('tap')); // a hint (or a shrug) takes over in a moment
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

  /**
   * Keep clear of cards: find the spot along the bottom nearest its corner where no cards reach
   * down into it. If there's none it ducks, leaving just its ears showing.
   */
  avoid(spans: { x0: number; x1: number; y: number }[]) {
    const hostW = this.host.clientWidth;
    const hostH = this.host.clientHeight;
    const w = this.el.offsetWidth;
    if (!hostW || !w) return;
    // Top of its visible body when sitting (it sits 12% below its box; see .bunny.on).
    const top = this.el.offsetTop + this.el.offsetHeight * 0.12;
    const corner = this.el.offsetLeft;
    const blocked = spans.filter((sp) => sp.y * hostH > top + 6).map((sp) => [sp.x0 * hostW, sp.x1 * hostW]);
    const fits = (x: number) => x >= corner - 1 && x + w <= hostW + 1 && blocked.every(([a, b]) => x + w <= a || x >= b);
    const spots = [corner, ...blocked.flatMap(([a, b]) => [b + 2, a - w - 2])].filter(fits);
    const best = spots.length ? spots.reduce((a, b) => (Math.abs(b - corner) < Math.abs(a - corner) ? b : a)) : null;
    this.el.classList.toggle('ducked', best === null);
    const dx = best === null ? 0 : Math.round(best - corner);
    if (dx === this.homeDx) return;
    this.homeDx = dx;
    if (performance.now() >= this.busyUntil) this.goHome();
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
    this.gesture(GESTURE[event], event === 'win' ? 6000 : event === 'scare' ? 1600 : 900, this.pick(event));
    if (Math.random() < CHANCE[event]) this.pop(event);
  }

  /** Walk over to the card to move, point at it, then hop to where it goes. */
  hint(target: HintTarget | null, kind: 'move' | 'deal' | 'none') {
    if (!this.enabled) return;
    this.resetIdle();
    this.clearTimers();
    if (kind === 'none' || !target) {
      this.goHome();
      this.gesture('sad', 1400, this.pick('shrug'));
      this.pop('stuck');
      return;
    }
    this.busyUntil = performance.now() + 3200;
    this.walkTo(target.from);
    this.later(380, () => {
      this.gesture('perk', 1000, this.pick('hint'));
      this.pop(kind === 'deal' ? 'hintDeal' : 'hint');
    });
    if (kind === 'move' && target.to !== undefined) {
      const to = target.to;
      this.later(1250, () => {
        this.walkTo(to);
        this.later(380, () => {
          this.gesture('nod', 1200, this.pick('hintTarget'));
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

  /** Play a motion gesture in a pose for `ms`, then settle back to idle. */
  private gesture(name: string, ms: number, pose: Pose = 'idle') {
    const all = ['hop', 'twitch', 'perk', 'nod', 'tilt', 'shake', 'sad', 'party'];
    this.el.classList.remove(...all);
    void this.el.offsetWidth;
    this.el.classList.add(name);
    this.setPose(pose);
    clearTimeout(this.moodTimer);
    this.moodTimer = window.setTimeout(() => {
      this.el.classList.remove(name);
      this.setPose(this.pick('idle'));
    }, ms);
  }

  /** A random fitting pose for the moment, if possible not the one already showing. */
  private pick(moment: keyof typeof POSES): Pose {
    const fresh = POSES[moment].filter((p) => resolvePose(p) !== this.shown);
    const from = fresh.length ? fresh : POSES[moment];
    return from[Math.floor(Math.random() * from.length)];
  }

  private setPose(pose: Pose) {
    const shown = resolvePose(pose);
    this.shown = shown;
    this.poses.forEach((img, p) => img.classList.toggle('shown', p === shown));
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
    this.el.style.setProperty('--walk', `${this.homeDx}px`);
    this.el.classList.add('facing-right');
    this.busyUntil = 0;
  }

  /** Turn toward where the action is (only shows in the side-glance pose, which looks right as shot). */
  private face(x: number) {
    const rect = this.el.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    this.el.classList.toggle('facing-right', host.left + x * host.width > rect.left + rect.width / 2);
  }

  private resetIdle() {
    clearTimeout(this.idleTimer);
    if (this.resting) {
      this.resting = false;
      this.setPose(this.pick('idle'));
    }
    // Never offers hints on its own: while the player thinks it just gets bored, then dozes off.
    this.idleTimer = window.setTimeout(() => {
      if (!this.enabled || document.hidden) return;
      this.rest('bored');
      this.idleTimer = window.setTimeout(() => this.enabled && this.rest('sleep'), SLEEP_MS - BORED_MS);
    }, BORED_MS);
  }

  /** Hold a pose until something happens. */
  private rest(pose: Pose) {
    clearTimeout(this.moodTimer);
    this.resting = true;
    this.setPose(pose);
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
