import { randomSeed } from '../../core/cards';
import { type GameController, type GameHooks, type HudStat, store } from '../../core/game';
import { CardLayer, type Placement } from '../../ui/cardLayer';
import { type Cascade, runCascade } from '../../ui/cascade';
import { haptic, sfx, unlockAudio } from '../../ui/feedback';
import { settings } from '../../ui/settings';
import { ADVISOR, OPPONENT, chooseBuild, chooseDiscard } from './ai';
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
  { name: 'Owl', emoji: '🦉' },
  { name: 'Bear', emoji: '🐻' },
];

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
  /** Opponents' miniature tables, side by side across the top. */
  mini: { scale: number; x: number[]; y: number; colStep: number; sep: number; fan: number };
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

const goalSize = (players: number) => (players === 2 ? (settings.spiteShort ? 13 : 20) : settings.spiteShort ? 10 : 15);

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

  private buildSlots: HTMLElement[] = [];
  private stockSlot: HTMLElement;
  private mySlots: { goal: HTMLElement; discards: HTMLElement[]; count: HTMLElement };
  private seatEls: { badge: HTMLElement; goal: HTMLElement; discards: HTMLElement[] }[] = [];
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
    for (let p = 1; p < PLAYERS.length; p++) {
      const badge = this.el('spite-foe', {});
      badge.innerHTML = `<span class="emo">${PLAYERS[p].emoji}</span><b class="goal"></b><small class="hand"></small>`;
      this.seatEls[p] = {
        badge,
        goal: this.el('slot spite-goal foe', { goal: p }),
        discards: Array.from({ length: DISCARD_PILES }, (_, i) => this.el('slot spite-discard foe', { discard: i, player: p })),
      };
    }
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

  get players() {
    return this.state?.seats.length ?? 2;
  }

  static saved(): string | null {
    const s = store.get<SpiteState>(SAVE_KEY);
    if (!s || s.winner !== null || s.stalemate) return null;
    const foes = s.seats.slice(1).map((seat, i) => `${PLAYERS[i + 1].emoji} ${seat.goal.length}`).join(' ');
    return `Spite & Malice · you ${s.seats[0].goal.length} left · ${foes}`;
  }

  status() {
    const s = this.state;
    return `Spite & Malice · goal cards left: you ${s.seats[0].goal.length}, ${s.seats
      .slice(1)
      .map((seat, i) => `${PLAYERS[i + 1].emoji} ${seat.goal.length}`)
      .join(', ')}`;
  }

  newGame(players = this.players, seed = randomSeed()) {
    this.stopCascade();
    clearTimeout(this.timer);
    this.state = newGame(seed, { goalSize: goalSize(players), players });
    this.resetUi();
    this.save();
    this.relayout();
    this.dealIn();
    this.hooks.event?.('start');
  }

  restart() {
    this.newGame(this.players, this.state.seed);
  }

  again() {
    this.newGame(this.players);
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

  undo() {
    /* No undo in a multiplayer game. */
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
    const m = chooseBuild(s, p, Math.random, OPPONENT) ?? chooseDiscard(s, p, Math.random, OPPONENT);
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
        if (p === 0) this.hooks.event?.('complete', this.fraction(this.L.colX[m.pile + 1]));
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
      line: `Spite & Malice · ${s.seats.length} players · goal pile of ${s.options.goalSize}`,
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
    this.hooks.hud({ stats, canUndo: false, hasUndo: false });
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
    if (d.discard !== undefined) return { at: 'discard', player: Number(d.player), pile: Number(d.discard) };
    if (d.goal !== undefined) return { at: 'goal', player: Number(d.goal) };
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
    this.hooks.event?.('invalid', this.fraction(this.L.colX[pile + 1]));
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
    const foes = Math.max(1, (this.state?.seats.length ?? 2) - 1);
    // The goal pile (and the draw pile above it) stand apart from the four piles beside them.
    const SEP = 0.4;
    // Budget in card heights: opponents' strip (~0.9), centre (1), your piles (1 + fans) and,
    // in portrait, your hand below.
    const cw = Math.floor(
      wide
        ? Math.min((W - pad * 2 - gap * 10) / (10.5 + SEP), (H - pad * 2 - gap * 4) / (3.75 * 1.4), 120)
        : Math.min((W - pad * 2 - gap * 4) / (5 + SEP), (H - pad * 2 - gap * 5) / (4.9 * 1.4), 120),
    );
    const ch = Math.round(cw * 1.4);
    const sep = Math.round(cw * SEP);
    const five = cw * 5 + gap * 4 + sep;
    const left = wide ? Math.round(pad + gap) : Math.round((W - five) / 2);
    const colX = Array.from({ length: 5 }, (_, i) => left + i * (cw + gap) + (i > 0 ? sep : 0));

    // Opponents: a miniature of each one's goal + piles, side by side across the top.
    const slotW = (W - pad * 2 - gap * 3 * (foes - 1)) / foes;
    const scale = Math.min(0.55, slotW / five);
    const miniW = five * scale;
    const miniY = pad + 26;
    const miniX = Array.from({ length: foes }, (_, i) => pad + i * (slotW + gap * 3) + (slotW - miniW) / 2);
    const miniBottom = miniY + ch * scale * 1.45;

    // Your piles sit just above your hand; the shared piles in the middle of what's left.
    const raise = Math.round(ch * 0.16);
    const fanRoom = Math.round(ch * (wide ? 0.45 : 0.5));
    // The fanned hand dips at its ends; keep the outer cards on screen.
    const arc = Math.round(ch * 0.15);
    const handY = wide ? H - pad - ch - fanRoom + raise - arc : H - pad - ch - arc;
    const playerY = Math.round(wide ? handY - raise : handY - raise - gap - fanRoom - ch);
    const centerY = Math.round(miniBottom + Math.max(gap * 2, (playerY - miniBottom - ch) / 2));
    const handX = wide ? left + five + gap * 3 : pad;
    const handW = wide ? W - pad - handX : W - pad * 2;

    this.L = {
      W,
      H,
      cw,
      ch,
      colX,
      wide,
      handX,
      handW,
      handY,
      raise,
      centerY,
      playerY,
      fanRoom,
      mini: { scale, x: miniX, y: miniY, colStep: (cw + gap) * scale, sep: sep * scale, fan: ch * scale * 0.16 },
    };
    this.root.style.setProperty('--cw', `${cw}px`);
    this.root.style.setProperty('--ch', `${ch}px`);
    // The Hint Bunny peeks over the hand (portrait) or sits in the free corner (landscape).
    this.root.parentElement?.style.setProperty('--bunny-lift', wide ? '0px' : `${Math.round(H - handY + raise * 0.4)}px`);

    const at = (el: HTMLElement, x: number, y: number, sc = 1) => {
      el.style.transform = `translate(${x}px, ${y}px)${sc !== 1 ? ` scale(${sc})` : ''}`;
      el.dataset.x = String(x);
      el.hidden = false;
    };
    this.buildSlots.forEach((el, i) => at(el, colX[i + 1], centerY));
    at(this.stockSlot, colX[0], centerY);
    at(this.mySlots.goal, colX[0], playerY);
    this.mySlots.discards.forEach((el, i) => at(el, colX[i + 1], playerY));
    at(this.mySlots.count, colX[0] + cw - 14, playerY - 8);
    for (let p = 1; p < PLAYERS.length; p++) {
      const seat = this.seatEls[p];
      const i = p - 1;
      const show = i < foes;
      if (!show) {
        seat.badge.hidden = seat.goal.hidden = true;
        seat.discards.forEach((el) => (el.hidden = true));
        continue;
      }
      at(seat.badge, miniX[i], pad);
      at(seat.goal, miniX[i], miniY, scale);
      seat.discards.forEach((el, d) => at(el, miniX[i] + (d + 1) * (cw + gap) * scale + sep * scale, miniY, scale));
    }
    at(this.helpEl, wide ? handX + handW / 2 : W / 2, playerY - gap - 2);
    if (this.state && !this.cascade) this.render(false);
  }

  /** x offset of column `i` inside an opponent's miniature. */
  private miniCol(i: number) {
    const m = this.L.mini;
    return i * m.colStep + (i > 0 ? m.sep : 0);
  }

  private render(animate = true) {
    const s = this.state;
    if (!s) return;
    if (!this.L) this.relayout();
    if (!this.L) return;
    const L = this.L;
    const m = L.mini;
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
      .forEach((c, i) => put(c, { at: 'stock' }, { x: L.colX[0], y: L.centerY - Math.min(i, 3), z: 10 + i, faceUp: false }));

    // Centre piles: a Star on top shows the value it stands for.
    s.builds.forEach((pile, b) =>
      pile.forEach((c, i) => {
        put(c, { at: 'build', pile: b }, { x: L.colX[b + 1], y: L.centerY, z: 100 + i, faceUp: true });
        if (c.star && i === pile.length - 1) this.layer.els.get(c.id)!.dataset.as = String(i + 1);
      }),
    );
    if (this.completing) {
      const { pile, cards } = this.completing;
      cards.forEach((c, i) => {
        put(c, { at: 'build', pile }, { x: L.colX[pile + 1], y: L.centerY, z: 150 + i, faceUp: true });
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

    // Opponents' miniatures; their hands are tucked away under the draw pile.
    s.seats.forEach((seat, p) => {
      if (p === 0) return;
      const x0 = m.x[p - 1];
      seat.goal.forEach((c, i, a) => put(c, { at: 'goal', player: p }, { x: x0, y: m.y, z: 200 + i, faceUp: i === a.length - 1, scale: m.scale }));
      seat.discards.forEach((pile, d) => {
        const step = Math.max(2, Math.min(m.fan, (L.ch * m.scale * 0.45) / Math.max(1, pile.length - 1)));
        pile.forEach((c, i) => put(c, { at: 'discard', player: p, pile: d }, { x: x0 + this.miniCol(d + 1), y: m.y + i * step, z: 300 + i, faceUp: true, scale: m.scale }));
      });
      seat.hand.forEach((c) => {
        if (c.id === this.foeLift) {
          // The hand card it's about to play, shown face up beside its miniature for a moment.
          put(c, { at: 'stock' }, { x: Math.min(L.W - L.cw * m.scale * 1.2 - 6, x0 + this.miniCol(4) + L.cw * m.scale * 1.25), y: m.y, z: 2000, faceUp: true, scale: m.scale * 1.15 });
        } else {
          put(c, { at: 'stock' }, { x: L.colX[0], y: L.centerY, z: 5, faceUp: false });
        }
      });
      const badge = this.seatEls[p].badge;
      badge.querySelector('.goal')!.textContent = String(seat.goal.length);
      badge.querySelector('.hand')!.textContent = `✋${seat.hand.length}`;
      badge.classList.toggle('turn', s.turn === p && !this.starting);
    });
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
      this.arrow.textContent = '▲';
      this.arrow.style.transform = `translate(${L.mini.x[s.turn - 1] + 16}px, ${L.mini.y + L.ch * L.mini.scale * 1.45}px)`;
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
      this.layer.place(c.id, { x: this.L.colX[0], y: this.L.centerY, z: 10, faceUp: false }, false);
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
      const p = this.layer.pos(card.id) ?? { x: this.L.colX[2], y: this.L.centerY };
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
