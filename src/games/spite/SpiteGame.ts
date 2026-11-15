import { randomSeed } from '../../core/cards';
import { type GameController, type GameHooks, type HudStat, store } from '../../core/game';
import { CardLayer, type Placement } from '../../ui/cardLayer';
import { type Cascade, runCascade } from '../../ui/cascade';
import { haptic, sfx, unlockAudio } from '../../ui/feedback';
import { settings } from '../../ui/settings';
import { ADVISOR, type Level, SKILL, chooseBuild, chooseDiscard } from './ai';
import {
  BUILD_PILES,
  DISCARD_PILES,
  type Move,
  type Player,
  type Source,
  type SpiteCard,
  type SpiteState,
  apply,
  canBuild,
  fits,
  needs,
  newGame,
  sourceCard,
} from './rules';

const SAVE_KEY = 'ninnies.spite.save.v1';
const PLAYERS = [
  { name: 'You', emoji: '🙂' },
  { name: 'Fox', emoji: '🦊' },
];
const LEVEL_NAME: Record<Level, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

interface Layout {
  W: number;
  H: number;
  cw: number;
  ch: number;
  /** Your row and the centre row: goal/draw column, then four piles. */
  colX: number[];
  wide: boolean;
  handX: number;
  handW: number;
  handY: number;
  raise: number;
  centerY: number;
  playerY: number;
  fanRoom: number;
  /** The shared row (draw pile + centre piles): x per column. */
  centerX: number[];
  centerScale: number;
  /** The opponent's miniature table across the top. */
  foe: SeatGeo;
}

/** The opponent's miniature: their goal pile then four piles, each fanning down toward you. */
interface SeatGeo {
  scale: number;
  /** Top-left of column `i` (0 = goal pile). */
  col: { x: number; y: number }[];
  fan: { dx: number; dy: number };
  badge: { x: number; y: number };
  arrow: { x: number; y: number; glyph: string };
  /** Their hand as a tight fan of card backs. */
  hand: { x: number; y: number; dx: number; scale: number };
  /** Where a hand card it's about to play is shown. */
  lift: { x: number; y: number };
}

/** Where a card is, so a tap or drop can be turned into a move. */
type Spot =
  | { at: 'hand'; index: number }
  | { at: 'goal'; player: Player }
  | { at: 'discard'; player: Player; pile: number }
  | { at: 'build'; pile: number }
  | { at: 'stock' };

interface Drag {
  pointerId: number;
  src: Source;
  id: number;
  startX: number;
  startY: number;
  base: { x: number; y: number };
  moved: boolean;
  target: { kind: 'build' | 'discard'; pile: number } | null;
}

const goalSize = () => (settings.spiteShort ? 13 : 20);

export class SpiteGame implements GameController {
  readonly id = 'spite' as const;
  readonly restartLabel = 'Restart this game';

  private state!: SpiteState;
  private layer: CardLayer;
  private L!: Layout;
  private where = new Map<number, Spot>();
  private selected: Source | null = null;
  private drag: Drag | null = null;
  private lastTap = { id: -1, at: 0 };
  private timer = 0;
  private paused = true;
  private cascade: Cascade | null = null;
  /** The opening deal is still on screen: no taps, and opponents wait. */
  private starting = false;
  /** One-off per-card delays for the next render (the opening deal). */
  private delays: Map<number, number> | null = null;
  /** A pile that just reached 12, held on the table for a moment before it's cleared away. */
  private completing: { pile: number; cards: SpiteCard[] } | null = null;
  /** The card an opponent is about to play, lifted so you can follow it. */
  private foeLift: number | null = null;
  /** Snapshots of your plays this turn; ending the turn (a discard) makes them final. */
  private history: SpiteState[] = [];

  private buildSlots: HTMLElement[] = [];
  private stockSlot: HTMLElement;
  private mySlots: { goal: HTMLElement; discards: HTMLElement[]; count: HTMLElement };
  private foeEls: { badge: HTMLElement; goal: HTMLElement; discards: HTMLElement[] };
  private arrow: HTMLElement;
  private helpEl: HTMLElement;

  constructor(
    private root: HTMLElement,
    private hooks: GameHooks,
  ) {
    root.classList.add('spite-root');
    this.layer = new CardLayer(root, { numbered: true });
    for (let i = 0; i < BUILD_PILES; i++) this.buildSlots.push(this.el('slot spite-build', { build: i }));
    this.stockSlot = this.el('slot spite-stock', { stock: 1 });
    this.mySlots = {
      goal: this.el('slot spite-goal', { goal: 0 }),
      discards: Array.from({ length: DISCARD_PILES }, (_, i) => this.el('slot spite-discard', { discard: i, player: 0 })),
      count: this.el('spite-count', {}),
    };
    const badge = this.el('spite-foe', {});
    badge.innerHTML = `<span class="emo">${PLAYERS[1].emoji}</span><b class="goal"></b><small class="level"></small>`;
    this.foeEls = {
      badge,
      goal: this.el('slot spite-goal foe', { goal: 1 }),
      discards: Array.from({ length: DISCARD_PILES }, (_, i) => this.el('slot spite-discard foe', { discard: i, player: 1 })),
    };
    this.arrow = this.el('spite-arrow', {});
    this.arrow.textContent = '▼';
    this.helpEl = this.el('spite-status', {});

    root.addEventListener('pointerdown', (e) => this.onDown(e));
    root.addEventListener('pointermove', (e) => this.onMove(e));
    root.addEventListener('pointerup', (e) => this.onUp(e));
    root.addEventListener('pointercancel', () => this.cancelDrag());
    new ResizeObserver(() => this.relayout()).observe(root);
    document.addEventListener('visibilitychange', () => (document.hidden ? this.save() : null));
  }

  // ───────────────────────── controller ─────────────────────────

  get active() {
    return Boolean(this.state);
  }

  get level(): Level {
    return this.state?.level ?? 'easy';
  }

  static saved(): string | null {
    const s = store.get<SpiteState>(SAVE_KEY);
    if (!s || s.winner !== null || s.stalemate) return null;
    return `Spite & Malice · ${LEVEL_NAME[s.level ?? 'easy']} · you ${s.seats[0].goal.length} left · ${PLAYERS[1].emoji} ${s.seats[1].goal.length}`;
  }

  /** The level of the saved (or current) game, for the start screen. */
  static savedLevel(): Level | null {
    return store.get<SpiteState>(SAVE_KEY)?.level ?? null;
  }

  status() {
    const s = this.state;
    return `Spite & Malice · ${LEVEL_NAME[this.level]} · goal cards left: you ${s.seats[0].goal.length}, ${PLAYERS[1].emoji} ${s.seats[1].goal.length}`;
  }

  newGame(level: Level = this.level, seed = randomSeed()) {
    this.stopCascade();
    clearTimeout(this.timer);
    this.state = newGame(seed, { goalSize: goalSize() });
    this.state.level = level;
    this.resetUi();
    this.save();
    this.relayout();
    this.dealIn();
    this.hooks.event?.('start');
  }

  restart() {
    this.newGame(this.level, this.state.seed);
  }

  again() {
    this.newGame(this.level);
  }

  resume(): boolean {
    const s = store.get<SpiteState>(SAVE_KEY);
    if (!s || s.winner !== null || s.stalemate) return false;
    this.state = s;
    this.resetUi();
    this.relayout();
    return true;
  }

  pause() {
    this.paused = true;
    clearTimeout(this.timer);
    this.cancelDrag();
    // Finish a held pile now so coming back can't find it half-done.
    this.completing = null;
    this.foeLift = null;
    this.save();
  }

  unpause() {
    this.paused = false;
    this.emitHud();
    this.step();
  }

  refresh() {
    if (this.state) this.render(false);
  }

  /** Take back a play made this turn. Discarding ends the turn, so that can't be undone. */
  undo() {
    const s = this.state;
    if (!s || s.turn !== 0 || this.completing || this.starting || !this.history.length) return;
    this.state = this.history.pop()!;
    this.selected = null;
    sfx.undo();
    haptic(6);
    this.save();
    this.emitHud();
    this.render();
  }

  key(e: KeyboardEvent) {
    if (e.key === 'Escape' && this.selected) {
      this.select(null);
      return true;
    }
    return false;
  }

  setVisible(on: boolean) {
    this.root.hidden = !on;
    if (on) this.relayout();
    else this.root.parentElement?.style.removeProperty('--bunny-lift');
  }

  hint() {
    const s = this.state;
    if (!s || s.turn !== 0 || s.winner !== null || this.cascade || this.starting) {
      this.hooks.toast('Wait for your turn');
      return;
    }
    const m = chooseBuild(s, 0, Math.random, ADVISOR) ?? chooseDiscard(s, 0, Math.random, ADVISOR);
    if (m.t === 'pass') {
      this.hooks.toast('Nothing to play: pass');
      return;
    }
    const src: Source = m.t === 'build' ? m.source : { from: 'hand', index: m.index };
    this.select(src);
    const card = sourceCard(s, 0, src)!;
    flash(this.layer.els.get(card.id)!, 'hinted', 1600);
    const target = m.t === 'build' ? this.buildSlots[m.pile] : this.mySlots.discards[m.pile];
    flash(target, 'hint', 1600);
    this.hooks.hint?.({ from: this.fraction(this.layer.pos(card.id)?.x ?? 0), to: this.fraction(parseFloat(target.dataset.x ?? '0')) }, 'move');
  }

  previewWin() {
    if (!this.state || this.cascade) return;
    this.pause();
    sfx.win();
    this.hooks.event?.('win');
    this.celebrate(() => {
      this.hooks.toast('Tap to return to your game');
      this.root.addEventListener(
        'pointerdown',
        () => {
          this.stopCascade();
          this.render(false);
          this.unpause();
        },
        { once: true, capture: true },
      );
    });
  }

  // ───────────────────────── flow ─────────────────────────

  /** Pause between opponent actions; slow enough to follow every card. */
  private speed() {
    return settings.spiteFast ? 450 : 850;
  }

  private step() {
    clearTimeout(this.timer);
    const s = this.state;
    if (!s || this.paused || this.cascade || this.starting || this.completing) return;
    this.emitHud();
    this.render();
    if (s.winner !== null || s.stalemate) return this.finish();
    if (s.turn !== 0) this.timer = window.setTimeout(() => this.foeMove(), this.speed());
  }

  /** One opponent action at a time: lift the card, then play it. */
  private foeMove() {
    const s = this.state;
    const p = s.turn;
    if (this.paused || p === 0 || s.winner !== null) return;
    const m = chooseBuild(s, p, Math.random, SKILL[this.level]) ?? chooseDiscard(s, p, Math.random, SKILL[this.level]);
    if (m.t === 'pass') return this.perform(p, m);
    const src: Source = m.t === 'build' ? m.source : { from: 'hand', index: m.index };
    this.foeLift = sourceCard(s, p, src)?.id ?? null;
    this.render();
    this.timer = window.setTimeout(() => {
      this.foeLift = null;
      this.perform(p, m);
    }, 420);
  }

  private perform(p: Player, m: Move) {
    const s = this.state;
    if (p === 0 && m.t === 'build') this.history.push(structuredClone(s));
    else if (p === 0) this.history = [];
    const goalBefore = s.seats[p].goal.length;
    const pileCards = m.t === 'build' ? [...s.builds[m.pile]] : [];
    const moving = m.t === 'build' ? sourceCard(s, p, m.source) : undefined;
    const { cleared, goal } = apply(s, p, m);
    this.selected = null;
    if (m.t === 'build') {
      if (p === 0) {
        sfx.move(1, 0.12);
        haptic(8);
      } else {
        sfx.drop();
      }
      if (goal) {
        if (p === 0) this.hooks.event?.('complete', this.fraction(this.L.centerX[m.pile + 1]));
        else if (goalBefore <= 4) this.hooks.event?.('stuck');
      } else if (p === 0 && cleared) {
        this.hooks.event?.('suit');
      }
      if (cleared && moving) {
        // Hold the finished pile (with its 12 on top) before sweeping it away.
        this.completing = { pile: m.pile, cards: [...pileCards, moving] };
        this.save();
        this.emitHud();
        this.render();
        window.setTimeout(() => sfx.complete(), 250);
        this.timer = window.setTimeout(() => {
          this.completing = null;
          sfx.undo();
          this.render();
          this.timer = window.setTimeout(() => this.step(), 450);
        }, 1100);
        return;
      }
    } else if (m.t === 'discard') {
      sfx.drop();
      window.setTimeout(() => sfx.deal(0), 200);
    }
    this.save();
    this.step();
  }

  private finish() {
    const s = this.state;
    store.set(SAVE_KEY, null);
    const won = s.winner === 0;
    const w = s.winner ?? 0;
    const result = {
      title: s.stalemate ? 'Stalemate' : won ? 'You won!' : `${PLAYERS[w].emoji} ${PLAYERS[w].name} wins`,
      line: `Spite & Malice · ${LEVEL_NAME[this.level]} · goal pile of ${s.options.goalSize}`,
      stats: s.seats.map((seat, i) => ({ label: i === 0 ? 'You left' : `${PLAYERS[i].emoji} left`, value: String(seat.goal.length) })),
      celebrate: won,
    };
    if (won) {
      sfx.win();
      this.hooks.event?.('win');
      this.celebrate(() => this.hooks.finished(result));
    } else {
      this.hooks.event?.('stuck');
      this.hooks.finished(result);
    }
  }

  private resetUi() {
    this.history = [];
    this.selected = null;
    this.completing = null;
    this.foeLift = null;
    this.drag = null;
  }

  private save() {
    if (this.state) store.set(SAVE_KEY, this.state);
  }

  private emitHud() {
    const s = this.state;
    if (!s) return;
    const stats: HudStat[] = s.seats.map((seat, i) => ({
      label: i === 0 ? 'You' : PLAYERS[i].emoji,
      value: String(seat.goal.length),
      hot: s.turn === i && !this.starting,
    }));
    this.hooks.hud({ stats, canUndo: s.turn === 0 && this.history.length > 0, hasUndo: true });
  }

  // ───────────────────────── input: tap or drag ─────────────────────────

  private spotAt(target: EventTarget | null): Spot | undefined {
    const t = target as HTMLElement;
    const cardEl = t.closest<HTMLElement>('.card');
    if (cardEl) return this.where.get(Number(cardEl.dataset.id));
    const slot = t.closest<HTMLElement>('[data-build],[data-discard],[data-goal],[data-stock]');
    if (!slot) return undefined;
    const d = slot.dataset;
    if (d.build !== undefined) return { at: 'build', pile: Number(d.build) };
    if (d.discard !== undefined) return { at: 'discard', player: Number(d.player) as Player, pile: Number(d.discard) };
    if (d.goal !== undefined) return { at: 'goal', player: Number(d.goal) as Player };
    return { at: 'stock' };
  }

  private onDown(e: PointerEvent) {
    unlockAudio();
    const s = this.state;
    if (!s || this.cascade || s.winner !== null || this.starting || this.drag) return;
    const spot = this.spotAt(e.target);
    if (!spot) return this.select(null);
    e.preventDefault();
    if (s.turn !== 0) {
      this.hooks.toast(`${PLAYERS[s.turn].emoji} is playing…`);
      return;
    }
    if (this.completing) return;

    // With a card selected, tapping a centre pile or your own pile plays it there.
    if (this.selected) {
      if (spot.at === 'build') return this.tryBuild(this.selected, spot.pile);
      if (spot.at === 'discard' && spot.player === 0 && this.selected.from === 'hand') {
        return this.perform(0, { t: 'discard', index: this.selected.index, pile: spot.pile });
      }
    }

    const src = this.sourceAt(spot);
    if (!src) {
      if (spot.at === 'discard' && spot.player === 0) this.hooks.toast('Pick a card from your hand first');
      return this.select(null);
    }
    // Could become a drag; decided on move or release.
    const card = sourceCard(s, 0, src)!;
    const pos = this.layer.pos(card.id) ?? { x: 0, y: 0 };
    this.drag = { pointerId: e.pointerId, src, id: card.id, startX: e.clientX, startY: e.clientY, base: { x: pos.x, y: pos.y }, moved: false, target: null };
    this.root.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 8) return;
      d.moved = true;
      this.select(d.src);
      sfx.pick();
      haptic(5);
      this.layer.els.get(d.id)!.classList.add('dragging');
    }
    this.layer.drag(d.id, d.base.x + dx, d.base.y + dy, 3000);
    // Drop target: the pile under the card's centre, with generous hit areas.
    const rect = this.root.getBoundingClientRect();
    const cx = rect.left + d.base.x + dx + this.L.cw / 2;
    const cy = rect.top + d.base.y + dy + this.L.ch / 2;
    const reach = this.L.cw * 0.35;
    const hit = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return cx > r.left - reach && cx < r.right + reach && cy > r.top - reach && cy < r.bottom + reach;
    };
    let target: Drag['target'] = null;
    this.buildSlots.forEach((el, pile) => {
      if (!target && hit(el)) target = { kind: 'build', pile };
    });
    if (!target && d.src.from === 'hand')
      this.mySlots.discards.forEach((el, pile) => {
        if (!target && hit(el)) target = { kind: 'discard', pile };
      });
    d.target = target;
    this.buildSlots.forEach((el, pile) => el.classList.toggle('hot', d.target?.kind === 'build' && d.target.pile === pile));
    this.mySlots.discards.forEach((el, pile) => el.classList.toggle('hot', d.target?.kind === 'discard' && d.target.pile === pile));
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    this.endDrag();
    if (d.moved) {
      if (d.target?.kind === 'build') return this.tryBuild(d.src, d.target.pile);
      if (d.target?.kind === 'discard' && d.src.from === 'hand') return this.perform(0, { t: 'discard', index: d.src.index, pile: d.target.pile });
      return this.render(); // snap back
    }
    this.tap(d.src, d.id);
  }

  private tap(src: Source, id: number) {
    const s = this.state;
    const card = sourceCard(s, 0, src)!;
    // Double tap: send it to the first centre pile it fits.
    const now = performance.now();
    if (this.lastTap.id === id && now - this.lastTap.at < 380) {
      this.lastTap = { id: -1, at: 0 };
      const pile = s.builds.findIndex((b) => fits(card, b));
      if (pile >= 0) return this.tryBuild(src, pile);
    }
    this.lastTap = { id, at: now };
    if (sameSource(this.selected, src)) return this.select(null);
    this.select(src);
    sfx.pick();
    haptic(5);
  }

  private endDrag() {
    const d = this.drag;
    if (!d) return;
    this.layer.els.get(d.id)?.classList.remove('dragging');
    [...this.buildSlots, ...this.mySlots.discards].forEach((el) => el.classList.remove('hot'));
    this.drag = null;
  }

  private cancelDrag() {
    if (!this.drag) return;
    this.endDrag();
    this.render();
  }

  private tryBuild(src: Source, pile: number) {
    const s = this.state;
    if (canBuild(s, 0, src, pile)) return this.perform(0, { t: 'build', source: src, pile });
    const card = sourceCard(s, 0, src)!;
    this.render();
    this.layer.wiggle([card.id]);
    sfx.invalid();
    haptic([15, 40, 15]);
    this.hooks.toast(`That pile needs ${needs(s.builds[pile])}`);
    this.hooks.event?.('invalid', this.fraction(this.L.centerX[pile + 1]));
  }

  private sourceAt(spot: Spot): Source | null {
    const s = this.state;
    if (spot.at === 'hand') return { from: 'hand', index: spot.index };
    if (spot.at === 'goal' && spot.player === 0 && s.seats[0].goal.length) return { from: 'goal' };
    if (spot.at === 'discard' && spot.player === 0 && s.seats[0].discards[spot.pile].length) return { from: 'discard', pile: spot.pile };
    return null;
  }

  private select(src: Source | null) {
    this.selected = src;
    this.render();
  }

  // ───────────────────────── layout & render ─────────────────────────

  private relayout() {
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (!W || !H) return;
    const pad = 10;
    const gap = Math.max(4, Math.round(W * 0.011));
    const wide = W > H * 1.25;
    // The goal pile (and the draw pile above it) stand apart from the four piles beside them.
    const SEP = 0.4;
    const cw = Math.floor(
      wide
        ? Math.min((W - pad * 2 - gap * 10) / (10.5 + SEP), (H - pad * 2 - gap * 4) / (3.75 * 1.4), 120)
        : Math.min((W - pad * 2 - gap * 4) / (5 + SEP), (H - pad * 2 - gap * 5) / (4.9 * 1.4), 120),
    );
    const ch = Math.round(cw * 1.4);
    const sep = Math.round(cw * SEP);
    const five = cw * 5 + gap * 4 + sep;
    const col = (i: number) => i * (cw + gap) + (i > 0 ? sep : 0);
    const left = wide ? Math.round(pad + gap) : Math.round((W - five) / 2);
    const colX = Array.from({ length: 5 }, (_, i) => left + col(i));

    // Your piles hug your hand, so it's easy to see what fits where.
    const raise = Math.round(ch * 0.16);
    const arc = Math.round(ch * 0.15);
    const fanRoom = Math.round(ch * 0.42);
    const handY = wide ? H - pad - ch - fanRoom + raise - arc : H - pad - ch - arc;
    const playerY = Math.round(wide ? handY - raise : handY - raise - Math.round(gap * 0.6) - fanRoom - ch);
    const handX = wide ? left + five + gap * 3 : pad;
    const handW = wide ? W - pad - handX : W - pad * 2;
    // Room above your piles for the Hint Bunny to peek over them.
    const bunnyRoom = wide ? 0 : Math.round(ch * 0.55);
    const top = pad + 26; // under the opponents' badges
    const bottom = playerY - gap - bunnyRoom;

    // The opponent sits across the top: a miniature of their goal pile and piles.
    const scale = Math.min(wide ? 0.55 : 0.5, (W - pad * 2) / five);
    const x0 = (W - five * scale) / 2;
    const w = cw * scale;
    const foe: SeatGeo = {
      scale,
      col: Array.from({ length: 5 }, (_, i) => ({ x: x0 + col(i) * scale, y: top })),
      fan: { dx: 0, dy: ch * scale * 0.16 },
      badge: { x: x0, y: pad },
      arrow: { x: x0 + w * 0.5, y: top + ch * scale * 1.5, glyph: '▲' },
      // Hand: a small fan of backs to the right of their piles; a card about to be played
      // pops out just below it.
      hand: { x: Math.min(W - pad - w * 2.4, x0 + five * scale + gap * 2), y: top, dx: w * 0.3, scale: scale * 0.75 },
      lift: { x: Math.min(W - pad - w * 1.25, x0 + five * scale + gap * 2 + w * 0.3), y: top + ch * scale * 0.85 },
    };
    const northBottom = top + ch * scale * 1.45;

    // The shared row sits in the middle of what's left.
    const centerScale = 1;
    const cLeft = wide ? left : (W - five) / 2;
    const centerX = Array.from({ length: 5 }, (_, i) => cLeft + col(i) * centerScale);
    const centerY = Math.round(northBottom + Math.max(gap * 2, (bottom - northBottom - ch * centerScale) / 2));

    this.L = { W, H, cw, ch, colX, wide, handX, handW, handY, raise, centerY, playerY, fanRoom, centerX, centerScale, foe };
    this.root.style.setProperty('--cw', `${cw}px`);
    this.root.style.setProperty('--ch', `${ch}px`);
    // The Hint Bunny peeks over your piles (portrait) or sits in the free corner (landscape).
    this.root.parentElement?.style.setProperty('--bunny-lift', wide ? '0px' : `${Math.round(H - playerY - 2)}px`);

    const at = (el: HTMLElement, x: number, y: number, sc = 1) => {
      el.style.transform = `translate(${x}px, ${y}px)${sc !== 1 ? ` scale(${sc})` : ''}`;
      el.dataset.x = String(x);
      el.hidden = false;
    };
    this.buildSlots.forEach((el, i) => at(el, centerX[i + 1], centerY, centerScale));
    at(this.stockSlot, centerX[0], centerY, centerScale);
    at(this.mySlots.goal, colX[0], playerY);
    this.mySlots.discards.forEach((el, i) => at(el, colX[i + 1], playerY));
    at(this.mySlots.count, colX[0] + cw - 14, playerY - 8);
    at(this.foeEls.badge, foe.badge.x, foe.badge.y);
    at(this.foeEls.goal, foe.col[0].x, foe.col[0].y, foe.scale);
    this.foeEls.discards.forEach((el, d) => at(el, foe.col[d + 1].x, foe.col[d + 1].y, foe.scale));
    at(this.helpEl, wide ? handX + handW / 2 : W / 2, playerY - gap - 2);
    if (this.state && !this.cascade) this.render(false);
  }

  private render(animate = true) {
    const s = this.state;
    if (!s) return;
    if (!this.L) this.relayout();
    if (!this.L) return;
    const L = this.L;
    const cs = L.centerScale;
    this.where.clear();
    const delays = this.delays;
    this.delays = null;
    const put = (card: SpiteCard, spot: Spot, p: Placement) => {
      this.where.set(card.id, spot);
      this.layer.sync(card);
      this.layer.place(card.id, { ...p, delay: delays?.get(card.id) ?? 0 }, animate);
      const el = this.layer.els.get(card.id)!;
      el.classList.remove('picked', 'can-play', 'done');
      delete el.dataset.as;
    };

    // The finished pile being shown off before it's swept away.
    const held = new Set(this.completing?.cards.map((c) => c.id));

    // Draw pile (finished piles get shuffled back in later): one face-down stack.
    [...s.spent, ...s.stock]
      .filter((c) => !held.has(c.id))
      .forEach((c, i) => put(c, { at: 'stock' }, { x: L.centerX[0], y: L.centerY - Math.min(i, 3), z: 10 + i, faceUp: false, scale: cs }));

    // Centre piles: a Star on top shows the value it stands for.
    s.builds.forEach((pile, b) =>
      pile.forEach((c, i) => {
        put(c, { at: 'build', pile: b }, { x: L.centerX[b + 1], y: L.centerY, z: 100 + i, faceUp: true, scale: cs });
        if (c.star && i === pile.length - 1) this.layer.els.get(c.id)!.dataset.as = String(i + 1);
      }),
    );
    if (this.completing) {
      const { pile, cards } = this.completing;
      cards.forEach((c, i) => {
        put(c, { at: 'build', pile }, { x: L.centerX[pile + 1], y: L.centerY, z: 150 + i, faceUp: true, scale: cs });
        if (i === cards.length - 1) {
          const el = this.layer.els.get(c.id)!;
          el.classList.add('done');
          if (c.star) el.dataset.as = '12';
        }
      });
    }

    // Your goal pile and personal piles.
    const me = s.seats[0];
    me.goal.forEach((c, i, a) => put(c, { at: 'goal', player: 0 }, { x: L.colX[0], y: L.playerY, z: 200 + i, faceUp: i === a.length - 1 }));
    me.discards.forEach((pile, d) => {
      const step = Math.min(L.ch * 0.22, pile.length > 1 ? L.fanRoom / (pile.length - 1) : 0);
      pile.forEach((c, i) => put(c, { at: 'discard', player: 0, pile: d }, { x: L.colX[d + 1], y: L.playerY + i * Math.max(3, step), z: 300 + i, faceUp: true }));
    });

    // The opponent's miniature, and their hand as a tight fan of backs.
    const g = L.foe;
    const foe = s.seats[1];
    foe.goal.forEach((c, i, a) => put(c, { at: 'goal', player: 1 }, { x: g.col[0].x, y: g.col[0].y, z: 200 + i, faceUp: i === a.length - 1, scale: g.scale }));
    foe.discards.forEach((pile, d) => {
      // Squeeze long piles so they stay inside the miniature.
      const k = Math.min(1, 4 / Math.max(1, pile.length - 1));
      pile.forEach((c, i) => put(c, { at: 'discard', player: 1, pile: d }, { x: g.col[d + 1].x, y: g.col[d + 1].y + i * g.fan.dy * k, z: 300 + i, faceUp: true, scale: g.scale }));
    });
    // Fanned like a hand held across the table from you: tilted outward, the ends curving up.
    const foeCards = foe.hand.length;
    foe.hand.forEach((c, i) => {
      if (c.id === this.foeLift) {
        // The hand card it's about to play, shown face up beside its miniature for a moment.
        put(c, { at: 'stock' }, { x: g.lift.x, y: g.lift.y, z: 2000, faceUp: true, scale: g.scale * 1.2 });
      } else {
        const off = foeCards > 1 ? i - (foeCards - 1) / 2 : 0;
        const rise = L.ch * g.hand.scale * 0.06;
        put(c, { at: 'stock' }, { x: g.hand.x + i * g.hand.dx, y: g.hand.y + (4 - off * off) * rise, z: 1100 + i, faceUp: false, scale: g.hand.scale, rotate: -off * 9 });
      }
    });
    const badge = this.foeEls.badge;
    badge.querySelector('.goal')!.textContent = String(foe.goal.length);
    badge.querySelector('.level')!.textContent = LEVEL_NAME[this.level];
    badge.classList.toggle('turn', s.turn === 1 && !this.starting);
    // A goal or pile card an opponent is about to play glows where it lies.
    if (this.foeLift !== null) this.layer.els.get(this.foeLift)?.classList.add('picked');

    // Your hand, fanned like cards held in a hand: a gentle arc, tilted outward.
    const hand = me.hand;
    const n = hand.length;
    const step = n > 1 ? Math.min(L.cw * 0.82, (L.handW - L.cw) / (n - 1)) : 0;
    const x0 = L.handX + (L.handW - (L.cw + step * (n - 1))) / 2;
    hand.forEach((c, i) => {
      const off = n > 1 ? i - (n - 1) / 2 : 0;
      const sel = this.selected?.from === 'hand' && this.selected.index === i;
      put(c, { at: 'hand', index: i }, {
        x: x0 + i * step,
        y: L.handY + off * off * L.ch * 0.035 - (sel ? L.raise : 0),
        z: 600 + i,
        faceUp: true,
        rotate: sel ? 0 : off * 5,
      });
    });

    // Selection: glow the card and light up where it can go.
    const yourTurn = s.turn === 0 && s.winner === null && !this.starting;
    const card = this.selected && yourTurn ? sourceCard(s, 0, this.selected) : undefined;
    if (card) this.layer.els.get(card.id)!.classList.add('picked');
    this.buildSlots.forEach((el, b) => el.classList.toggle('target', !!card && fits(card, s.builds[b])));
    this.mySlots.discards.forEach((el) => el.classList.toggle('target-discard', !!card && this.selected?.from === 'hand'));
    if (!card && yourTurn) {
      for (const src of this.playableSources()) {
        const c = sourceCard(s, 0, src);
        if (c) this.layer.els.get(c.id)!.classList.add('can-play');
      }
    }

    this.mySlots.count.textContent = String(me.goal.length);
    this.helpEl.textContent = yourTurn && this.selected?.from === 'hand' ? 'Play it, or drop it on a pile below to end your turn' : '';
    this.placeArrow();
  }

  /** A bouncing arrow points at whoever's turn it is. */
  private placeArrow() {
    const s = this.state;
    const L = this.L;
    const show = !!s && s.winner === null && !this.starting && !(s.turn === 0 && this.selected);
    this.arrow.hidden = !show;
    if (!show) return;
    if (s.turn === 0) {
      // Above your piles, pointing down at your side of the table.
      this.arrow.textContent = '▼';
      this.arrow.style.transform = `translate(${L.wide ? L.handX + L.handW / 2 : L.W / 2}px, ${L.playerY - 30}px)`;
      this.arrow.classList.remove('foe');
    } else {
      // Under the opponent's miniature, pointing up at them.
      const a = L.foe.arrow;
      this.arrow.textContent = a.glyph;
      this.arrow.style.transform = `translate(${a.x}px, ${a.y}px)`;
      this.arrow.classList.add('foe');
    }
  }

  private playableSources(): Source[] {
    const s = this.state;
    const seat = s.seats[0];
    const all: Source[] = [
      { from: 'goal' },
      ...seat.discards.map((_, pile) => ({ from: 'discard' as const, pile })),
      ...seat.hand.map((_, index) => ({ from: 'hand' as const, index })),
    ];
    return all.filter((src) => s.builds.some((_, b) => canBuild(s, 0, src, b)));
  }

  /**
   * Opening deal: goal piles go out one card at a time around the table, then the starting
   * player's hand; then play begins.
   */
  private dealIn() {
    if (!this.L) this.relayout();
    if (!this.L) return;
    const s = this.state;
    const all = [...s.stock, ...s.seats.flatMap((x) => [...x.goal, ...x.hand])];
    for (const c of all) {
      this.layer.sync(c);
      this.layer.place(c.id, { x: this.L.centerX[0], y: this.L.centerY, z: 10, faceUp: false, scale: this.L.centerScale }, false);
    }
    void this.root.offsetWidth;
    const step = s.seats.length > 2 ? 18 : 26;
    const delays = new Map<number, number>();
    let t = 0;
    for (let i = 0; i < s.options.goalSize; i++)
      for (const seat of s.seats) {
        delays.set(seat.goal[i].id, t);
        t += step;
      }
    t += 150;
    for (const c of s.seats[s.turn].hand) {
      delays.set(c.id, t);
      t += 90;
    }
    for (let k = 0; k < t; k += 120) sfx.deal(k / 1000);
    this.starting = true;
    this.delays = delays;
    this.render();
    window.setTimeout(() => {
      this.starting = false;
      this.step();
    }, t + 700);
  }

  private celebrate(onDone: () => void) {
    this.stopCascade();
    const s = this.state;
    const cards = [...s.builds.flat(), ...s.seats.flatMap((x) => [...x.goal, ...x.discards.flat(), ...x.hand]), ...s.spent];
    const order = cards.map((card) => {
      const p = this.layer.pos(card.id) ?? { x: this.L.centerX[2], y: this.L.centerY };
      return { card: { ...card, rank: card.star ? 13 : card.rank }, x: p.x, y: p.y };
    });
    this.cascade = runCascade(this.root, order, { cw: this.L.cw, ch: this.L.ch }, 'letters', onDone);
  }

  private stopCascade() {
    this.cascade?.clear();
    this.cascade = null;
  }

  private fraction(x: number) {
    return (x + this.L.cw / 2) / this.L.W;
  }

  private el(cls: string, data: Record<string, number>) {
    const e = document.createElement('div');
    e.className = cls;
    for (const [k, v] of Object.entries(data)) e.dataset[k] = String(v);
    this.root.appendChild(e);
    return e;
  }
}

const sameSource = (a: Source | null, b: Source) =>
  !!a && a.from === b.from && (a.from === 'hand' ? a.index === (b as typeof a).index : a.from === 'discard' ? a.pile === (b as typeof a).pile : true);

function flash(el: HTMLElement, cls: string, ms: number) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), ms);
}
