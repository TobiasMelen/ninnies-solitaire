import { randomSeed } from '../../core/cards';
import { type GameHooks, type HudStat, store } from '../../core/game';
import { TableGame } from '../../core/tableGame';
import { CardLayer, type Placement } from '../../ui/cardLayer';
import { haptic, sfx, unlockAudio } from '../../ui/feedback';
import { flash } from '../../ui/fx';
import { settings } from '../../ui/settings';
import { ADVISOR, type Level, SKILL, bestPileFor, chooseBuild, chooseDiscard } from './ai';
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
/** Each difficulty is a different animal: Bear is easy, Fox medium, Owl hard. */
export const FOES: Record<Level, { name: string; emoji: string }> = {
  easy: { name: 'Bear', emoji: '🐻' },
  medium: { name: 'Fox', emoji: '🦊' },
  hard: { name: 'Owl', emoji: '🦉' },
};

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

/**
 * The opponent mirrors you across the table: their hand (fanned backs) along the top edge with
 * their avatar beside it, then their goal pile (with its count) and four piles.
 */
interface SeatGeo {
  scale: number;
  /** Top-left of column `i` (0 = goal pile). */
  col: { x: number; y: number }[];
  fan: { dx: number; dy: number };
  avatar: { x: number; y: number };
  count: { x: number; y: number };
  arrow: { x: number; y: number };
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

export class SpiteGame extends TableGame<SpiteState> {
  readonly id = 'spite' as const;
  readonly restartLabel = 'Restart this game';

  private layer: CardLayer;
  private L!: Layout;
  private where = new Map<number, Spot>();
  private selected: Source | null = null;
  private drag: Drag | null = null;
  private lastTap = { id: -1, at: 0 };
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
  private foeEls: { avatar: HTMLElement; count: HTMLElement; goal: HTMLElement; discards: HTMLElement[] };
  private arrow: HTMLElement;
  private helpEl: HTMLElement;

  constructor(root: HTMLElement, hooks: GameHooks) {
    super(root, hooks, SAVE_KEY);
    root.classList.add('spite-root');
    this.layer = new CardLayer(root, { numbered: true });
    for (let i = 0; i < BUILD_PILES; i++) this.buildSlots.push(this.el('slot spite-build', { build: i }));
    this.stockSlot = this.el('slot spite-stock', { stock: 1 });
    this.mySlots = {
      goal: this.el('slot spite-goal', { goal: 0 }),
      discards: Array.from({ length: DISCARD_PILES }, (_, i) => this.el('slot spite-discard', { discard: i, player: 0 })),
      count: this.el('spite-count', {}),
    };
    this.foeEls = {
      avatar: this.el('spite-avatar', {}),
      count: this.el('spite-count', {}),
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
  }

  // ───────────────────────── controller ─────────────────────────

  get level(): Level {
    return this.state?.level ?? 'easy';
  }

  static saved(): string | null {
    const s = store.get<SpiteState>(SAVE_KEY);
    if (!s || s.winner !== null || s.stalemate) return null;
    return `Spite & Malice · you ${s.seats[0].goal.length} left · ${FOES[s.level ?? 'easy'].emoji} ${s.seats[1].goal.length}`;
  }

  /** The level of the saved (or current) game, for the start screen. */
  static savedLevel(): Level | null {
    return store.get<SpiteState>(SAVE_KEY)?.level ?? null;
  }

  get foe() {
    return FOES[this.level];
  }

  status() {
    const s = this.state;
    return `Spite & Malice · goal cards left: you ${s.seats[0].goal.length}, ${this.foe.emoji} ${s.seats[1].goal.length}`;
  }

  newGame(level: Level = this.level, seed = randomSeed()) {
    this.stopCascade();
    this.cancelAll();
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

  // ───────────────────────── flow ─────────────────────────

  /** Pause between opponent actions; slow enough to follow every card. */
  private speed() {
    return settings.spiteFast ? 450 : 850;
  }

  protected isFinished(s: SpiteState) {
    return s.winner !== null || s.stalemate;
  }

  protected onResume() {
    this.resetUi();
  }

  /** Pausing mid-moment: finish it now so the game resumes cleanly from the state alone. */
  protected settle() {
    this.cancelDrag();
    this.completing = null; // the rules already cleared the finished pile
    this.foeLift = null; // the opponent re-decides on resume
    this.starting = false;
  }

  protected step() {
    this.cancel('next');
    const s = this.state;
    if (!s || this.paused || this.cascade || this.starting || this.completing) return;
    this.emitHud();
    this.render();
    if (s.winner !== null || s.stalemate) return this.finish();
    if (s.turn !== 0) this.after('next', this.speed(), () => this.foeMove());
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
    sfx.pick();
    this.render();
    this.after('next', 420, () => {
      this.foeLift = null;
      this.perform(p, m);
    });
  }

  private perform(p: Player, m: Move) {
    const s = this.state;
    if (p === 0 && m.t === 'build') this.history.push(structuredClone(s));
    else if (p === 0) this.history = [];
    const goalBefore = s.seats[p].goal.length;
    const pileCards = m.t === 'build' ? [...s.builds[m.pile]] : [];
    const moving = m.t === 'build' ? sourceCard(s, p, m.source) : undefined;
    const hands = s.seats.map((x) => x.hand.length);
    const fromHand = m.t === 'discard' || (m.t === 'build' && m.source.from === 'hand');
    const { cleared, goal } = apply(s, p, m);
    this.selected = null;
    // Cards drawn by this move: a refill after playing out the hand, or the next player's draw.
    const drawer = s.turn;
    const drawn = s.seats[drawer].hand.length - hands[drawer] + (drawer === p && fromHand ? 1 : 0);
    if (drawn > 0) sfx.draw(drawn, m.t === 'build' ? 0.3 : 0.35);
    if (m.t === 'build') {
      if (p === 0) {
        sfx.move(1, 0.12);
        haptic(8);
      } else {
        sfx.move(1, 0.14);
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
        this.after('chime', 250, () => sfx.complete());
        this.after('hold', 1100, () => {
          this.completing = null;
          sfx.undo();
          this.render();
          this.after('next', 450, () => this.step());
        });
        return;
      }
    } else if (m.t === 'discard') {
      sfx.drop();
    }
    this.save();
    this.step();
  }

  private finish() {
    const s = this.state;
    this.clearSave();
    const won = s.winner === 0;
    const result = {
      title: s.stalemate ? 'Stalemate' : won ? 'You won!' : `${this.foe.emoji} ${this.foe.name} wins`,
      line: `Spite & Malice · goal pile of ${s.options.goalSize}`,
      stats: s.seats.map((seat, i) => ({ label: i === 0 ? 'You left' : `${this.foe.emoji} left`, value: String(seat.goal.length) })),
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

  protected emitHud() {
    const s = this.state;
    if (!s) return;
    const stats: HudStat[] = s.seats.map((seat, i) => ({
      label: i === 0 ? 'You' : this.foe.emoji,
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
      this.hooks.toast(`${this.foe.emoji} is playing…`);
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
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone; the tap still works without capture */
    }
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
      // A card that fits more than one pile (a ★ fits them all) goes where it helps most.
      const fitting = s.builds.flatMap((b, i) => (fits(card, b) ? [i] : []));
      const pile = fitting.length > 1 ? (bestPileFor(s, 0, src) ?? fitting[0]) : fitting[0];
      if (pile !== undefined) return this.tryBuild(src, pile);
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

  protected relayout() {
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
    const bottom = playerY - gap - bunnyRoom;

    // The opponent mirrors you: their hand along the top edge, then their goal pile and piles.
    // Portrait has room for these at (nearly) full size; landscape keeps them smaller.
    const handStrip = Math.round(ch * (wide ? 0.32 : 0.42));
    const oppY = pad + handStrip;
    const roomForRow = bottom - oppY - gap * 3 - ch;
    const scale = wide ? Math.min(0.55, (W - pad * 2) / five) : Math.max(0.5, Math.min(1, roomForRow / (ch * 1.38)));
    const x0 = (W - five * scale) / 2;
    const w = cw * scale;
    const handScale = wide ? scale * 0.8 : 0.5;
    const hw = cw * handScale;
    const fanW = hw * (1 + 4 * 0.42);
    const fanX = (W - fanW) / 2;
    const foe: SeatGeo = {
      scale,
      col: Array.from({ length: 5 }, (_, i) => ({ x: x0 + col(i) * scale, y: oppY })),
      fan: { dx: 0, dy: ch * scale * 0.18 },
      // Beside the hand fan in portrait; left of their (narrower) row in landscape.
      avatar: wide ? { x: x0 - 48, y: oppY } : { x: fanX - 46, y: pad },
      count: { x: x0 + w - 14, y: oppY - 8 },
      arrow: wide ? { x: x0 - 29, y: oppY + 42 } : { x: fanX - 27, y: pad + 40 },
      // Their hand peeks in from the top edge, like cards held across the table.
      hand: { x: fanX, y: pad + handStrip - ch * handScale - 4, dx: hw * 0.42, scale: handScale },
      // A hand card about to be played drops out of the fan first.
      lift: { x: W / 2 - w / 2, y: oppY + ch * scale * 0.15 },
    };
    const northBottom = oppY + ch * scale * 1.38;

    // The shared row sits in the middle of what's left.
    const centerScale = 1;
    const cLeft = wide ? left : (W - five) / 2;
    const centerX = Array.from({ length: 5 }, (_, i) => cLeft + col(i) * centerScale);
    // Centred between the opponent's row and yours, so drags from your side stay short.
    const centerY = Math.round(northBottom + Math.max(gap * 2, (playerY - northBottom - ch) / 2));

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
    at(this.foeEls.avatar, foe.avatar.x, foe.avatar.y);
    at(this.foeEls.count, foe.count.x, foe.count.y);
    at(this.foeEls.goal, foe.col[0].x, foe.col[0].y, foe.scale);
    this.foeEls.discards.forEach((el, d) => at(el, foe.col[d + 1].x, foe.col[d + 1].y, foe.scale));
    at(this.helpEl, wide ? handX + handW / 2 : W / 2, playerY - gap - 2);
    if (this.state && !this.cascade) this.render(false);
  }

  protected render(animate = true) {
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
        const dip = L.ch * g.hand.scale * 0.05;
        put(c, { at: 'stock' }, { x: g.hand.x + i * g.hand.dx, y: g.hand.y - off * off * dip, z: 1100 + i, faceUp: false, scale: g.hand.scale, rotate: -off * 8 });
      }
    });
    this.foeEls.avatar.textContent = this.foe.emoji;
    this.foeEls.avatar.classList.toggle('turn', s.turn === 1 && !this.starting);
    this.foeEls.count.textContent = String(foe.goal.length);
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
      this.arrow.textContent = '▲';
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
    this.after('deal', t + 700, () => {
      this.starting = false;
      this.step();
    });
  }

  protected cascadeCards() {
    const s = this.state;
    const cards = [...s.builds.flat(), ...s.seats.flatMap((x) => [...x.goal, ...x.discards.flat(), ...x.hand]), ...s.spent];
    return cards.map((card) => {
      const p = this.layer.pos(card.id) ?? { x: this.L.centerX[2], y: this.L.centerY };
      return { card, x: p.x, y: p.y };
    });
  }

  protected cardSize() {
    return { cw: this.L.cw, ch: this.L.ch };
  }

  /** The cascade draws this game's own numbered deck. */
  protected cascadeCourts() {
    return 'numbered';
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

