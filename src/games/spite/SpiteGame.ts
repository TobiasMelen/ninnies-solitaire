import { randomSeed } from '../../core/cards';
import { type GameController, type GameHooks, store } from '../../core/game';
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
const FOE = { name: 'Fox', emoji: '🦊' };

interface Layout {
  W: number;
  H: number;
  cw: number;
  ch: number;
  /** x of the five columns: goal/stock + four piles (centred, or left half in landscape). */
  colX: number[];
  /** Landscape: the hand sits beside your piles instead of below them. */
  wide: boolean;
  handX: number;
  handW: number;
  oppY: number;
  oppScale: number;
  oppFan: number;
  centerY: number;
  playerY: number;
  fan: number;
  handY: number;
  raise: number;
}

/** Where a card is, so a tap can be turned into a move. */
type Spot =
  | { at: 'hand'; index: number }
  | { at: 'goal'; player: Player }
  | { at: 'discard'; player: Player; pile: number; top: boolean }
  | { at: 'build'; pile: number }
  | { at: 'stock' };

const options = () => ({ goalSize: settings.spiteShort ? 13 : 20 });

export class SpiteGame implements GameController {
  readonly id = 'spite' as const;
  readonly restartLabel = 'Restart this game';

  private state!: SpiteState;
  private layer: CardLayer;
  private L!: Layout;
  private where = new Map<number, Spot>();
  private selected: Source | null = null;
  private lastTap = { id: -1, at: 0 };
  private timer = 0;
  private paused = true;
  private cascade: Cascade | null = null;

  private buildSlots: HTMLElement[] = [];
  private discardSlots: HTMLElement[][] = [[], []];
  private goalSlots: HTMLElement[] = [];
  private stockSlot: HTMLElement;
  private goalBadges: HTMLElement[] = [];
  private stockBadge: HTMLElement;
  private statusEl: HTMLElement;
  private foeBadge: HTMLElement;

  constructor(
    private root: HTMLElement,
    private hooks: GameHooks,
  ) {
    root.classList.add('spite-root');
    this.layer = new CardLayer(root, { numbered: true });
    for (let i = 0; i < BUILD_PILES; i++) this.buildSlots.push(this.slot('slot spite-build', { build: i }));
    for (const p of [0, 1] as Player[]) {
      for (let i = 0; i < DISCARD_PILES; i++) this.discardSlots[p].push(this.slot(`slot spite-discard${p ? ' foe' : ''}`, { discard: i, player: p }));
      this.goalSlots.push(this.slot(`slot spite-goal${p ? ' foe' : ''}`, { goal: p }));
      this.goalBadges.push(this.slot('spite-count', {}));
    }
    this.stockSlot = this.slot('slot spite-stock', { stock: 1 });
    this.stockBadge = this.slot('spite-count stock', {});
    this.statusEl = this.slot('spite-status', {});
    this.foeBadge = this.slot('spite-foe', {});
    this.foeBadge.innerHTML = `<span class="emo">${FOE.emoji}</span><small class="hand"></small>`;

    root.addEventListener('pointerdown', (e) => this.onDown(e));
    new ResizeObserver(() => this.relayout()).observe(root);
    document.addEventListener('visibilitychange', () => (document.hidden ? this.save() : null));
  }

  // ───────────────────────── controller ─────────────────────────

  get active() {
    return Boolean(this.state);
  }

  static saved(): string | null {
    const s = store.get<SpiteState>(SAVE_KEY);
    if (!s || s.winner !== null || s.stalemate) return null;
    return `Spite & Malice · you ${s.seats[0].goal.length} left · ${FOE.emoji} ${s.seats[1].goal.length}`;
  }

  status() {
    const s = this.state;
    return `Spite & Malice · goal cards left: you ${s.seats[0].goal.length}, ${FOE.emoji} ${s.seats[1].goal.length}`;
  }

  newGame(seed = randomSeed()) {
    this.stopCascade();
    clearTimeout(this.timer);
    this.state = newGame(seed, options());
    this.selected = null;
    this.save();
    this.dealIn();
    this.hooks.event?.('start');
    this.step();
  }

  restart() {
    this.newGame(this.state.seed);
  }

  again() {
    this.newGame();
  }

  resume(): boolean {
    const s = store.get<SpiteState>(SAVE_KEY);
    if (!s || s.winner !== null || s.stalemate) return false;
    this.state = s;
    this.selected = null;
    this.relayout();
    return true;
  }

  pause() {
    this.paused = true;
    clearTimeout(this.timer);
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
    /* No undo in a two-player game. */
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
    if (!s || s.turn !== 0 || s.winner !== null || this.cascade) {
      this.hooks.toast(`Wait for your turn`);
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
    const target = m.t === 'build' ? this.buildSlots[m.pile] : this.discardSlots[0][m.pile];
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

  private speed() {
    return settings.spiteFast ? 380 : 750;
  }

  private step() {
    clearTimeout(this.timer);
    const s = this.state;
    if (!s || this.paused || this.cascade) return;
    this.emitHud();
    this.render();
    if (s.winner !== null || s.stalemate) return this.finish();
    if (s.turn === 1) this.timer = window.setTimeout(() => this.foeMove(), this.speed());
  }

  /** One opponent action at a time, so each play can be followed. */
  private foeMove() {
    const s = this.state;
    if (this.paused || s.turn !== 1 || s.winner !== null) return;
    const m = chooseBuild(s, 1, Math.random, OPPONENT) ?? chooseDiscard(s, 1, Math.random, OPPONENT);
    this.perform(1, m);
  }

  private perform(p: Player, m: Move) {
    const s = this.state;
    const goalBefore = s.seats[p].goal.length;
    const { cleared, goal } = apply(s, p, m);
    this.selected = null;
    if (m.t === 'build') {
      if (p === 0) sfx.move(1, 0.12);
      else sfx.drop();
      haptic(p === 0 ? 8 : 0);
      if (goal) {
        if (p === 0) this.hooks.event?.('complete', this.fraction(this.L.colX[m.pile + 1]));
        else if (goalBefore <= 4) this.hooks.event?.('stuck');
        flash(this.goalBadges[p], 'bump', 600);
      } else if (p === 0 && cleared) {
        this.hooks.event?.('suit');
      }
      if (cleared) sfx.complete();
    } else if (m.t === 'discard') {
      sfx.drop();
      // Turn passes; the next player's draw arrives with the next render.
      window.setTimeout(() => sfx.deal(0), 200);
    }
    this.save();
    this.step();
  }

  private finish() {
    const s = this.state;
    store.set(SAVE_KEY, null);
    const won = s.winner === 0;
    const result = {
      title: s.stalemate ? 'Stalemate' : won ? 'You won!' : `${FOE.emoji} ${FOE.name} wins`,
      line: `Spite & Malice · goal pile of ${s.options.goalSize}`,
      stats: [
        { label: 'You left', value: String(s.seats[0].goal.length) },
        { label: `${FOE.emoji} left`, value: String(s.seats[1].goal.length) },
      ],
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

  private save() {
    if (this.state) store.set(SAVE_KEY, this.state);
  }

  private emitHud() {
    const s = this.state;
    if (!s) return;
    this.hooks.hud({
      stats: [
        { label: 'You', value: String(s.seats[0].goal.length), hot: s.turn === 0 },
        { label: FOE.emoji, value: String(s.seats[1].goal.length), hot: s.turn === 1 },
        { label: 'Stock', value: String(s.stock.length) },
      ],
      canUndo: false,
      hasUndo: false,
    });
  }

  // ───────────────────────── input ─────────────────────────

  private onDown(e: PointerEvent) {
    unlockAudio();
    const s = this.state;
    if (!s || this.cascade || s.winner !== null) return;
    const t = e.target as HTMLElement;
    const cardEl = t.closest<HTMLElement>('.card');
    const slotEl = t.closest<HTMLElement>('[data-build],[data-discard],[data-goal],[data-stock]');
    const spot: Spot | undefined = cardEl ? this.where.get(Number(cardEl.dataset.id)) : slotEl ? this.slotSpot(slotEl) : undefined;
    if (!spot) return this.select(null);
    e.preventDefault();
    if (s.turn !== 0) {
      this.hooks.toast(`${FOE.emoji} is playing…`);
      return;
    }

    // Targets first: with a card selected, a tap on a centre pile or own personal pile plays it.
    if (this.selected) {
      if (spot.at === 'build') return this.tryBuild(this.selected, spot.pile);
      if (spot.at === 'discard' && spot.player === 0 && this.selected.from === 'hand') {
        return this.perform(0, { t: 'discard', index: this.selected.index, pile: spot.pile });
      }
    }

    const src = this.sourceAt(spot);
    if (!src) {
      if (spot.at === 'discard' && spot.player === 0 && !this.selected) this.hooks.toast('Pick a card from your hand first');
      return this.select(null);
    }
    const card = sourceCard(s, 0, src)!;
    // Double tap: send it to the first centre pile it fits.
    const now = performance.now();
    if (this.lastTap.id === card.id && now - this.lastTap.at < 380) {
      this.lastTap = { id: -1, at: 0 };
      const pile = s.builds.findIndex((b) => fits(card, b));
      if (pile >= 0) return this.tryBuild(src, pile);
    }
    this.lastTap = { id: card.id, at: now };
    if (sameSource(this.selected, src)) return this.select(null);
    this.select(src);
    sfx.pick();
    haptic(5);
  }

  private tryBuild(src: Source, pile: number) {
    const s = this.state;
    if (canBuild(s, 0, src, pile)) return this.perform(0, { t: 'build', source: src, pile });
    const card = sourceCard(s, 0, src)!;
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

  private slotSpot(el: HTMLElement): Spot | undefined {
    const d = el.dataset;
    if (d.build !== undefined) return { at: 'build', pile: Number(d.build) };
    if (d.discard !== undefined) return { at: 'discard', player: Number(d.player) as Player, pile: Number(d.discard), top: true };
    if (d.goal !== undefined) return { at: 'goal', player: Number(d.goal) as Player };
    if (d.stock !== undefined) return { at: 'stock' };
    return undefined;
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
    const gap = Math.max(5, Math.round(W * 0.012));
    const wide = W > H * 1.25;
    const oppScale = 0.6;
    // Portrait stacks four rows (Fox, centre, your piles, hand); landscape puts the hand beside
    // your piles, so it fits ten cards across and three rows plus fans.
    const cw = Math.floor(
      wide
        ? Math.min((W - pad * 2 - gap * 10) / 10.6, (H - pad * 2 - gap * 4) / (3.75 * 1.4), 120)
        : Math.min((W - pad * 2 - gap * 4) / 5, (H - pad * 2 - gap * 5) / (4.9 * 1.4), 120),
    );
    const ch = Math.round(cw * 1.4);
    const five = cw * 5 + gap * 4;
    const left = wide ? Math.round(pad + gap) : Math.round((W - five) / 2);
    const colX = Array.from({ length: 5 }, (_, i) => left + i * (cw + gap));
    const oppRow = ch * oppScale * 1.75;
    const oppY = pad;
    const centerY = Math.round(oppY + oppRow + gap * 1.5);
    const playerY = Math.round(centerY + ch + gap * 1.5);
    const raise = Math.round(ch * 0.18);
    const handY = wide ? playerY + raise : H - pad - ch;
    const fanRoom = wide ? H - pad - playerY - ch : Math.max(0, handY - raise - gap - playerY - ch);
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
      oppY,
      oppScale,
      oppFan: ch * oppScale * 0.18,
      centerY,
      playerY,
      fan: Math.min(ch * 0.24, fanRoom / 6),
      handY,
      raise,
    };
    this.root.style.setProperty('--cw', `${cw}px`);
    this.root.style.setProperty('--ch', `${ch}px`);
    // The Hint Bunny peeks over the hand instead of covering it (portrait), or sits in the
    // free corner under the centre row (landscape).
    this.root.parentElement?.style.setProperty('--bunny-lift', wide ? '0px' : `${Math.round(H - handY + raise * 0.4)}px`);

    const at = (el: HTMLElement, x: number, y: number, scale = 1) => {
      el.style.transform = `translate(${x}px, ${y}px)${scale !== 1 ? ` scale(${scale})` : ''}`;
      el.dataset.x = String(x);
    };
    const ox = (i: number) => colX[i] + (cw * (1 - oppScale)) / 2;
    this.buildSlots.forEach((el, i) => at(el, colX[i + 1], centerY));
    at(this.stockSlot, colX[0], centerY);
    at(this.goalSlots[0], colX[0], playerY);
    at(this.goalSlots[1], ox(0), oppY, oppScale);
    this.discardSlots[0].forEach((el, i) => at(el, colX[i + 1], playerY));
    this.discardSlots[1].forEach((el, i) => at(el, ox(i + 1), oppY, oppScale));
    at(this.goalBadges[0], colX[0] + cw - 14, playerY - 8);
    at(this.goalBadges[1], ox(0) + cw * oppScale - 14, oppY - 4);
    at(this.stockBadge, colX[0] + cw - 14, centerY - 8);
    at(this.foeBadge, wide ? colX[4] + cw + gap * 2 : colX[0] - 2, wide ? oppY + 4 : oppY + ch * oppScale + 6);
    at(this.statusEl, wide ? handX + handW / 2 : W / 2, wide ? playerY - gap * 0.6 : playerY - gap * 0.75 - 2);
    if (this.state && !this.cascade) this.render(false);
  }

  private render(animate = true) {
    const s = this.state;
    if (!s) return;
    if (!this.L) this.relayout();
    if (!this.L) return;
    const L = this.L;
    this.where.clear();
    const put = (card: SpiteCard, spot: Spot, p: Placement) => {
      this.where.set(card.id, spot);
      this.layer.sync(card);
      this.layer.place(card.id, p, animate);
      const el = this.layer.els.get(card.id)!;
      el.classList.remove('picked', 'can-play');
      delete el.dataset.as;
    };
    const ox = (i: number) => L.colX[i] + (L.cw * (1 - L.oppScale)) / 2;

    // Stock and spent cards: a single face-down pile.
    [...s.spent, ...s.stock].forEach((c, i) => put(c, { at: 'stock' }, { x: L.colX[0], y: L.centerY - Math.min(i, 3), z: 10 + i, faceUp: false }));

    // Centre piles: stars show the value they stand for.
    s.builds.forEach((pile, b) =>
      pile.forEach((c, i) => {
        put(c, { at: 'build', pile: b }, { x: L.colX[b + 1], y: L.centerY, z: 100 + i, faceUp: true });
        if (c.star && i === pile.length - 1) this.layer.els.get(c.id)!.dataset.as = String(i + 1);
      }),
    );

    // Goal piles.
    s.seats[0].goal.forEach((c, i, a) => put(c, { at: 'goal', player: 0 }, { x: L.colX[0], y: L.playerY - Math.min(a.length - 1 - i, 0), z: 200 + i, faceUp: i === a.length - 1 }));
    s.seats[1].goal.forEach((c, i, a) =>
      put(c, { at: 'goal', player: 1 }, { x: ox(0), y: L.oppY, z: 200 + i, faceUp: i === a.length - 1, scale: L.oppScale }),
    );

    // Personal piles, fanned so every card shows.
    for (const p of [0, 1] as Player[]) {
      s.seats[p].discards.forEach((pile, d) => {
        const n = pile.length;
        const room = L.wide ? L.H - 10 - L.playerY - L.ch : L.handY - L.raise - 8 - L.playerY - L.ch;
        const step = p === 0 ? Math.min(L.ch * 0.24, n > 1 ? room / (n - 1) : L.fan) : L.oppFan;
        pile.forEach((c, i) => {
          const x = p === 0 ? L.colX[d + 1] : ox(d + 1);
          const y = (p === 0 ? L.playerY : L.oppY) + i * Math.max(4, step);
          put(c, { at: 'discard', player: p, pile: d, top: i === n - 1 }, { x, y, z: 300 + i, faceUp: true, scale: p === 0 ? 1 : L.oppScale });
        });
      });
    }

    // Opponent's hand: just a count by their badge, cards tucked away behind the stock.
    s.seats[1].hand.forEach((c) => put(c, { at: 'stock' }, { x: L.colX[0], y: L.centerY, z: 5, faceUp: false }));
    this.foeBadge.querySelector('.hand')!.textContent = `${s.seats[1].hand.length} in hand`;

    // Your hand.
    const hand = s.seats[0].hand;
    const step = hand.length > 1 ? Math.min(L.cw + 8, (L.handW - L.cw) / (hand.length - 1)) : 0;
    const x0 = L.handX + (L.handW - (L.cw + step * (hand.length - 1))) / 2;
    hand.forEach((c, i) => {
      const sel = this.selected?.from === 'hand' && this.selected.index === i;
      put(c, { at: 'hand', index: i }, { x: x0 + i * step, y: L.handY - (sel ? L.raise : 0), z: 600 + i, faceUp: true });
    });

    // Selection: lift/glow the card and light up where it can go.
    const yourTurn = s.turn === 0 && s.winner === null;
    const card = this.selected && yourTurn ? sourceCard(s, 0, this.selected) : undefined;
    if (card) this.layer.els.get(card.id)!.classList.add('picked');
    this.buildSlots.forEach((el, b) => el.classList.toggle('target', !!card && fits(card, s.builds[b])));
    this.discardSlots[0].forEach((el) => el.classList.toggle('target-discard', !!card && this.selected?.from === 'hand'));
    // Without a selection, quietly mark what can be played at all.
    if (!card && yourTurn) {
      for (const src of this.playableSources()) {
        const c = sourceCard(s, 0, src);
        if (c) this.layer.els.get(c.id)!.classList.add('can-play');
      }
    }

    this.goalBadges[0].textContent = String(s.seats[0].goal.length);
    this.goalBadges[1].textContent = String(s.seats[1].goal.length);
    this.stockBadge.textContent = String(s.stock.length);
    this.foeBadge.classList.toggle('turn', s.turn === 1);
    this.statusEl.textContent =
      s.winner !== null ? '' : s.turn === 1 ? `${FOE.emoji} is playing…` : this.selected?.from === 'hand' ? 'Play it, or put it on a pile below to end your turn' : 'Your turn';
    this.statusEl.classList.toggle('mine', s.turn === 0);
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

  private dealIn() {
    if (!this.L) this.relayout();
    if (!this.L) return;
    const all = [...this.state.stock, ...this.state.seats.flatMap((x) => [...x.goal, ...x.hand])];
    for (const c of all) {
      this.layer.sync(c);
      this.layer.place(c.id, { x: this.L.colX[0], y: this.L.centerY, z: 10, faceUp: false }, false);
    }
    void this.root.offsetWidth;
    for (let i = 0; i < 12; i++) sfx.deal(i * 0.05);
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

  private slot(cls: string, data: Record<string, number>) {
    const el = document.createElement('div');
    el.className = cls;
    for (const [k, v] of Object.entries(data)) el.dataset[k] = String(v);
    this.root.appendChild(el);
    return el;
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
