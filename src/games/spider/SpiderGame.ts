import { t, tn } from '../../i18n';
import { type Card, randomSeed } from '../../core/cards';
import { type GameController, type GameHooks, INTRO_MS, fmtTime, store } from '../../core/game';
import { CardLayer, MOVE_MS, MOVE_MS_REDUCED, type Placement } from '../../ui/cardLayer';
import { type Cascade, type CascadeCard, runCascade } from '../../ui/cascade';
import { haptic, sfx, unlockAudio } from '../../ui/feedback';
import { flash } from '../../ui/fx';
import { settings } from '../../ui/settings';
import {
  type Action,
  COLUMNS,
  type SpiderState,
  type SuitCount,
  applyAction,
  bestTarget,
  canMove,
  canPickUp,
  completeRuns,
  dealBlocked,
  findMoves,
  isWon,
  newGame,
  positionKey,
  replay,
  runStart,
} from './rules';
import { type Step, moveCost, plan } from './hint';

export interface Stats {
  played: Record<SuitCount, number>;
  won: Record<SuitCount, number>;
  bestMs: Partial<Record<SuitCount, number>>;
}

interface Layout {
  W: number;
  H: number;
  cw: number;
  ch: number;
  colX: number[];
  topY: number;
  tableTop: number;
  bottom: number;
  stockX: number;
  stockStep: number;
  foundX: number;
  foundStep: number;
}

interface Fan {
  /** y offset of each card from the top of its column */
  offs: number[];
  /** spacing for the next card dropped on the column */
  next: number;
}

type Gap = 'down' | 'locked' | 'run';

type Where = { pile: 'col'; col: number; index: number } | { pile: 'stock' } | { pile: 'found' };

interface Drag {
  pointerId: number;
  from: number;
  index: number;
  ids: number[];
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  moved: boolean;
  /** Smoothed positions so the tail of a dragged run trails the lead card. */
  trail: { x: number; y: number }[];
  base: { x: number; y: number }[];
  hover: number | null;
  /** Columns this run may legally land on, worked out once at pick-up. */
  legal: number[];
  boardLeft: number;
  raf: number;
}

interface Save {
  seed: number;
  suitCount: SuitCount;
  actions: Action[];
  ms: number;
  counted: boolean;
}

const SAVE_KEY = 'ninnies.spider.save.v1';
const STATS_KEY = 'ninnies.spider.stats.v1';
const DRAG_SLOP = 7;
const DOUBLE_TAP_MS = 380;


const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
/** How much a move may cost (in the planner's points, about two suited links) before it counts as a mistake. */
const MISTAKE = 25;

export class SpiderGame implements GameController {
  readonly id = 'spider' as const;
  readonly restartLabel = 'menu.restartDeal' as const;

  private state!: SpiderState;
  private actions: Action[] = [];
  private counted = false;
  private layer: CardLayer;
  private L!: Layout;
  private fans: Fan[] = [];
  private where = new Map<number, Where>();
  private drag: Drag | null = null;
  private pending: { timer: number } | null = null;
  private msBefore = 0;
  private clockStart: number | null = null;
  private stuckNotified = -1;
  private hintLine: { key: string; steps: Step[] } | null = null;
  /** The rest of the hinted line, valid once the player has made the hinted move. */
  private hintAfter: { key: string; steps: Step[] } | null = null;
  private hintTimer = 0;
  private cascade: Cascade | null = null;
  private paused = false;
  /** While previewing the win cascade, the real game is parked here. */
  private preview: { real: SpiderState } | null = null;
  private stuckTimer = 0;
  private lastTap: { id: number; at: number } | null = null;

  private colSlots: HTMLElement[] = [];
  private markers: HTMLElement[] = [];
  private foundSlot: HTMLElement;
  private stockSlot: HTMLElement;
  private stockBadge: HTMLElement;

  constructor(
    private board: HTMLElement,
    private hooks: GameHooks,
  ) {
    this.layer = new CardLayer(board);
    this.layer.setCourts(settings.courts);
    this.foundSlot = this.el('slot found-slot');
    for (let i = 0; i < COLUMNS; i++) {
      this.colSlots.push(this.el('slot col-slot'));
      this.markers.push(this.el('marker'));
    }
    this.stockSlot = this.el('slot stock-slot');
    this.stockSlot.setAttribute('role', 'button');
    this.stockSlot.setAttribute('aria-label', t('spider.dealRow'));
    this.stockBadge = this.el('stock-badge');

    this.bindInput();
    // The observer also reports the first size one frame after a new game has laid out (and
    // started dealing); only a real size change may re-lay out, or it snaps the deal into place.
    new ResizeObserver(() => {
      if (this.L && board.clientWidth === this.L.W && board.clientHeight === this.L.H) return;
      this.relayout();
    }).observe(board);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stopClock();
        this.save();
      } else if (!this.paused && this.state && this.actions.length && !isWon(this.state)) {
        this.startClock();
      }
    });
    setInterval(() => this.emitHud(), 1000);
  }

  /** The saved, unfinished game if there is one. */
  static saved(): { suitCount: SuitCount; moves: number; ms: number } | null {
    const data = store.get<Save>(SAVE_KEY);
    if (!data || !data.actions.length) return null;
    try {
      const s = replay(data.seed, data.suitCount, data.actions);
      return isWon(s) ? null : { suitCount: s.suitCount, moves: s.moves, ms: data.ms };
    } catch {
      return null;
    }
  }

  // ───────────────────────── public API ─────────────────────────

  get suitCount() {
    return this.state.suitCount;
  }

  get active() {
    return Boolean(this.state);
  }

  again() {
    this.newGame(this.state.suitCount);
  }

  status() {
    return t('spider.status', { suits: tn('spider.suits', this.state.suitCount), moves: tn('moves', this.state.moves), time: fmtTime(this.elapsed()) });
  }

  key(e: KeyboardEvent) {
    if (e.key === 'd' || e.key === ' ') {
      this.deal();
      return true;
    }
    return false;
  }

  setVisible(on: boolean) {
    this.board.hidden = !on;
    if (on) this.relayout();
  }

  /** Load the saved game. Returns false if there is none to continue. */
  resume(): boolean {
    return this.restore();
  }

  /** Stop the clock while the player is away from the table (menus). */
  pause() {
    if (!this.state) return;
    this.endPreview();
    this.paused = true;
    this.flush();
    this.cancelDrag();
    this.stopClock();
    this.save();
  }

  unpause() {
    this.paused = false;
    if (this.state && this.actions.length && !isWon(this.state)) this.startClock();
    this.emitHud();
  }

  newGame(suitCount: SuitCount, seed = randomSeed()) {
    this.endPreview();
    this.flush();
    this.stopCelebration();
    this.state = newGame(seed, suitCount);
    this.actions = [];
    this.counted = false;
    this.msBefore = 0;
    this.clockStart = null;
    this.stuckNotified = -1;
    this.save();
    this.dealIn();
    this.hooks.event?.('start');
    this.emitHud();
  }

  restart() {
    this.newGame(this.state.suitCount, this.state.seed);
  }

  undo() {
    if (this.celebrating) return;
    if (this.preview) return this.endPreview();
    this.flush();
    this.cancelDrag();
    if (!this.actions.length) return;
    this.stopCelebration();
    this.actions.pop();
    this.state = replay(this.state.seed, this.state.suitCount, this.actions);
    this.stuckNotified = -1;
    this.render();
    sfx.undo();
    this.hooks.event?.('undo');
    haptic(6);
    this.save();
    this.emitHud();
  }

  deal() {
    if (this.celebrating) return;
    if (this.preview) return this.endPreview();
    this.flush();
    const blocked = dealBlocked(this.state, settings.dealWithEmpty);
    if (blocked === 'empty-stock') {
      this.hooks.toast(t('spider.noMoreCards'));
      return;
    }
    if (blocked === 'empty-column') {
      this.hooks.toast(t('spider.fillEmpty'));
      sfx.invalid();
      haptic([18, 50, 18]);
      this.hooks.event?.('invalid', 1);
      this.colSlots.forEach((s, i) => !this.state.columns[i].length && flash(s, 'attention'));
      return;
    }
    const before = structuredClone(this.state);
    const ids = this.commit({ t: 'deal' });
    this.hooks.event?.('deal', 1);
    this.judge(before, { t: 'deal' }, 1);
    const step = this.fast ? 20 : 55;
    ids.forEach((_, i) => sfx.deal((i * step) / 1000));
    haptic(10);
    this.render({ delay: (id) => Math.max(0, ids.indexOf(id)) * step });
    this.settleLater(ids.length * step + MOVE_MS - 20);
  }

  hint() {
    if (this.celebrating) return;
    if (this.preview) return this.endPreview();
    this.flush();
    this.clearHint();
    const mv = this.nextHint();
    if (!mv) {
      this.hooks.toast(t('noMovesLeft'));
      this.hooks.hint?.(null, 'none');
      return;
    }
    if (mv.t === 'deal') {
      flash(this.stockSlot, 'hint');
      this.hooks.toast(t('spider.timeToDeal'));
      this.hooks.hint?.({ from: (this.L.stockX + this.L.cw / 2) / this.L.W }, 'deal');
      return;
    }
    const ids = this.state.columns[mv.from].slice(mv.index).map((c) => c.id);
    ids.forEach((id) => this.layer.els.get(id)!.classList.add('hinted'));
    this.showMarker(mv.to, 'hint');
    haptic(6);
    this.hooks.hint?.({ from: this.colFraction(mv.from), to: this.colFraction(mv.to) }, 'move');
    // Long enough for the Hint Bunny to hop from the card to its destination.
    this.hintTimer = window.setTimeout(() => this.clearHint(), 2600);
  }

  /**
   * The planner's advice for this position. Its line of moves is kept, so while the player
   * follows it each next hint continues the same plan instead of starting over.
   */
  private nextHint(): Step | null {
    const keyOf = (st: SpiderState) => `${positionKey(st)}/${st.stock.length}/${settings.dealWithEmpty}`;
    const key = keyOf(this.state);
    if (this.hintLine?.key !== key) {
      this.hintLine = this.hintAfter?.key === key ? this.hintAfter : { key, steps: plan(this.state, settings.dealWithEmpty) };
    }
    this.hintAfter = null;
    const [first, ...rest] = this.hintLine.steps;
    if (!first) return null;
    if (rest.length) {
      const next = structuredClone(this.state);
      const turned = applyAction(next, first).length + completeRuns(next).filter((c) => c.flipped !== null).length;
      // New cards change everything, so the rest of the line only holds if none appeared.
      if (first.t === 'move' && !turned) this.hintAfter = { key: keyOf(next), steps: rest };
    }
    return first;
  }

  /** Called when settings change. */
  refresh() {
    if (!this.state) return;
    this.layer.setCourts(settings.courts);
    this.render({ animate: false });
    this.checkStuck();
  }

  stats(): Stats {
    return (
      store.get<Stats>(STATS_KEY) ?? {
        played: { 1: 0, 2: 0, 4: 0 },
        won: { 1: 0, 2: 0, 4: 0 },
        bestMs: {},
      }
    );
  }

  // ───────────────────────── flow ─────────────────────────

  private get fast() {
    return reducedMotion.matches;
  }

  private commit(a: Action): number[] {
    this.clearHint();
    clearTimeout(this.stuckTimer);
    this.actions.push(a);
    const changed = applyAction(this.state, a);
    if (!this.counted) {
      this.counted = true;
      const st = this.stats();
      st.played[this.state.suitCount]++;
      store.set(STATS_KEY, st);
    }
    this.startClock();
    this.save();
    this.emitHud();
    return changed;
  }

  private move(from: number, index: number, to: number, fromDrag: boolean) {
    const ids = this.state.columns[from].slice(index).map((c) => c.id);
    const destTop = this.state.columns[to].at(-1);
    const sameSuit = destTop?.suit === this.state.columns[from][index].suit;
    // Cards look settled at ~65% of the slide (the easing front-loads the motion).
    const landAt = ((this.fast ? MOVE_MS_REDUCED : MOVE_MS) * 0.65) / 1000;
    if (fromDrag) sfx.drop();
    else sfx.move(ids.length, landAt);
    haptic(8);
    const before = structuredClone(this.state);
    const flipped = this.commit({ t: 'move', from, index, to });
    if (flipped.length) sfx.flip(fromDrag ? 0.1 : landAt + 0.05);
    this.render({ delay: (id) => (fromDrag ? 0 : Math.max(0, ids.indexOf(id)) * 18) });
    this.hooks.event?.(flipped.length ? 'reveal' : sameSuit ? 'suit' : 'move', this.colFraction(to));
    this.settleLater(fromDrag ? 200 : MOVE_MS - 20 + ids.length * 18);
    if (!flipped.length) this.judge(before, { t: 'move', from, index, to }, this.colFraction(to));
  }

  /**
   * After the move has landed, the Hint Bunny looks it over and frowns at one that threw away
   * something better (breaking up a run for nothing, filling an empty column, dealing with good
   * moves still on the table). Hinted moves are never frowned at.
   */
  private judge(before: SpiderState, a: Step, x: number) {
    const moves = this.actions.length;
    window.setTimeout(() => {
      if (this.actions.length !== moves || this.celebrating) return;
      if (moveCost(before, a) <= MISTAKE) return;
      this.hooks.event?.('blunder', x);
      this.hooks.offerUndo?.();
    }, 450);
  }

  /** Completed runs fly off after the move has visibly landed. */
  private settleLater(ms: number) {
    this.flushTimerOnly();
    this.pending = { timer: window.setTimeout(() => this.settle(), this.fast ? 60 : ms) };
  }

  private flushTimerOnly() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  /** Apply any pending completion immediately (input arrived before the animation finished). */
  private flush() {
    if (this.pending) {
      this.flushTimerOnly();
      this.settle();
    }
  }

  private settle() {
    this.pending = null;
    const done = completeRuns(this.state);
    if (done.length) {
      const order = new Map<number, number>();
      done.forEach((d, k) => d.ids.forEach((id, i) => order.set(id, k * 400 + i * 35)));
      this.render({ delay: (id) => order.get(id) ?? 0 });
      sfx.complete();
      this.hooks.event?.('complete', this.colFraction(done[0].col));
      haptic([10, 40, 10]);
      if (done.some((d) => d.flipped !== null)) sfx.flip(0.5);
      this.save();
      this.emitHud();
    }
    if (isWon(this.state)) {
      window.setTimeout(() => this.win(), this.fast ? 200 : 900);
    } else {
      this.checkStuck();
    }
  }

  /** Give the player a moment to look at the settled table before telling them they're stuck. */
  private checkStuck() {
    clearTimeout(this.stuckTimer);
    const at = this.actions.length;
    this.stuckTimer = window.setTimeout(() => {
      if (this.actions.length === at && !this.drag && !this.pending) this.checkStuckNow();
    }, 3000);
  }

  private checkStuckNow() {
    if (!settings.noMovesAlert || isWon(this.state)) return;
    if (this.stuckNotified === this.actions.length) return;
    if (findMoves(this.state).length) return;
    // Being able to deal means the game isn't stuck; Hint points at the stock in that case.
    if (!dealBlocked(this.state, settings.dealWithEmpty)) return;
    this.stuckNotified = this.actions.length;
    this.hooks.stuck();
  }

  private win() {
    this.stopClock();
    const ms = this.elapsed();
    const st = this.stats();
    const s = this.state.suitCount;
    st.won[s]++;
    const prev = st.bestMs[s];
    const best = prev === undefined || ms < prev;
    if (best) st.bestMs[s] = ms;
    store.set(STATS_KEY, st);
    sfx.win();
    haptic([20, 60, 20, 60, 40]);
    this.hooks.event?.('win');
    this.save();
    const result = {
      title: t('win.won'),
      line: `${tn('spider.suits', s)} · ${tn('moves', this.state.moves)} · ${fmtTime(ms)}${best ? t('newBest') : ''}`,
      stats: [
        { label: t('stat.score'), value: String(this.state.score) },
        { label: t('stat.won'), value: `${st.won[s]}/${st.played[s]}` },
        { label: t('stat.best'), value: st.bestMs[s] !== undefined ? fmtTime(st.bestMs[s]!) : '–' },
      ],
      celebrate: true,
    };
    this.celebrate(() => this.hooks.finished(result));
  }

  // ───────────────────────── persistence & clock ─────────────────────────

  private elapsed() {
    return this.msBefore + (this.clockStart === null ? 0 : performance.now() - this.clockStart);
  }

  private startClock() {
    if (this.clockStart === null && !isWon(this.state)) this.clockStart = performance.now();
  }

  private stopClock() {
    this.msBefore = this.elapsed();
    this.clockStart = null;
  }

  private save() {
    const state = this.preview?.real ?? this.state;
    const data: Save = {
      seed: state.seed,
      suitCount: state.suitCount,
      actions: this.actions,
      ms: Math.round(this.elapsed()),
      counted: this.counted,
    };
    store.set(SAVE_KEY, data);
  }

  private restore(): boolean {
    const data = store.get<Save>(SAVE_KEY);
    if (!data) return false;
    try {
      this.state = replay(data.seed, data.suitCount, data.actions);
    } catch {
      return false;
    }
    if (isWon(this.state)) return false;
    this.actions = data.actions;
    this.counted = data.counted;
    this.msBefore = data.ms;
    this.relayout();
    this.emitHud();
    window.setTimeout(() => this.checkStuck(), 600);
    return true;
  }

  private emitHud() {
    if (!this.state) return;
    this.hooks.hud({
      stats: [
        { label: t('stat.score'), value: String(this.state.score) },
        { label: t('stat.moves'), value: String(this.state.moves) },
        { label: t('stat.time'), value: fmtTime(this.elapsed()) },
      ],
      canUndo: this.actions.length > 0 && !this.celebrating,
      hasUndo: true,
    });
  }

  // ───────────────────────── layout & render ─────────────────────────

  private relayout() {
    const W = this.board.clientWidth;
    const H = this.board.clientHeight;
    if (!W || !H) return;
    const gap = Math.round(Math.min(14, Math.max(2, W * 0.008)));
    const pad = Math.max(gap, 6);
    // Fit 10 columns across, but leave enough height for a header row plus ~10 fanned cards.
    const cw = Math.floor(Math.min((W - pad * 2 - gap * 9) / 10, (H - 20) / 6.4, 118));
    const ch = Math.round(cw * 1.4);
    const left = Math.round((W - (cw * 10 + gap * 9)) / 2);
    const colX = Array.from({ length: COLUMNS }, (_, i) => left + i * (cw + gap));
    const topY = pad;
    this.L = {
      W,
      H,
      cw,
      ch,
      colX,
      topY,
      tableTop: topY + ch + Math.max(gap * 2, 10),
      bottom: H - pad,
      stockX: colX[9],
      stockStep: Math.max(4, Math.round(cw * 0.2)),
      foundX: colX[0],
      foundStep: Math.round(cw * 0.42),
    };
    this.board.style.setProperty('--cw', `${cw}px`);
    this.board.style.setProperty('--ch', `${ch}px`);

    const at = (el: HTMLElement, x: number, y: number) => (el.style.transform = `translate(${x}px, ${y}px)`);
    this.colSlots.forEach((s, i) => at(s, colX[i], this.L.tableTop));
    at(this.foundSlot, this.L.foundX, topY);
    this.foundSlot.style.width = `${cw + this.L.foundStep * 7}px`;
    at(this.stockSlot, this.L.stockX - this.L.stockStep * 4, topY);
    this.stockSlot.style.width = `${cw + this.L.stockStep * 4}px`;

    if (this.state && !this.celebrating) {
      this.cancelDrag();
      this.render({ animate: false });
    }
  }

  /**
   * Spacing per column. When a column would run past the bottom, it collapses in order of
   * importance: face-down cards first, then face-up cards that can't move (down to a sliver
   * that still shows the rank), and only then the movable run the player is working with.
   */
  private computeFans() {
    const { ch, tableTop, bottom } = this.L;
    const avail = bottom - tableTop - ch;
    // [kind, minimum] in the order things give way.
    const squeeze: [Gap, number][] = [
      ['down', ch * 0.045],
      ['locked', ch * 0.14],
      ['run', ch * 0.2],
      ['locked', ch * 0.07],
      ['run', ch * 0.12],
      ['down', ch * 0.015],
      ['locked', ch * 0.03],
      ['run', ch * 0.05],
    ];
    this.fans = this.state.columns.map((col) => {
      const rs = runStart(col);
      // The gap after card i depends on what card i is.
      const kinds: Gap[] = col.slice(0, -1).map((c, i) => (!c.faceUp ? 'down' : i < rs ? 'locked' : 'run'));
      const gap: Record<Gap, number> = { down: ch * 0.12, locked: ch * 0.3, run: ch * 0.3 };
      const count = (k: Gap) => kinds.filter((x) => x === k).length;
      const need = () => kinds.reduce((n, k) => n + gap[k], 0);
      for (const [k, min] of squeeze) {
        const over = need() - avail;
        if (over <= 0) break;
        const n = count(k);
        if (n) gap[k] = Math.max(min, gap[k] - over / n);
      }
      const offs = [0];
      kinds.forEach((k, i) => offs.push(offs[i] + gap[k]));
      return { offs, next: Math.min(gap.run, ch * 0.3) };
    });
  }

  private cardY(col: number, index: number) {
    return Math.round(this.L.tableTop + (this.fans[col].offs[index] ?? 0));
  }

  private render(opts: { animate?: boolean; delay?: (id: number) => number } = {}) {
    if (!this.L) this.relayout();
    if (!this.L) return;
    // Reduced motion still animates (cards must visibly travel), just quicker; see style.css.
    const animate = opts.animate ?? true;
    const s = this.state;
    const L = this.L;
    this.computeFans();
    this.where.clear();
    const put = (id: number, p: Placement) => this.layer.place(id, { ...p, delay: opts.delay?.(id) ?? 0 }, animate);

    const groups = Math.ceil(s.stock.length / 10);
    s.stock.forEach((card, k) => {
      this.layer.sync(card);
      this.where.set(card.id, { pile: 'stock' });
      const g = Math.floor(k / 10);
      put(card.id, { x: L.stockX - (groups - 1 - g) * L.stockStep, y: L.topY, z: 10 + k, faceUp: false });
    });

    s.foundations.forEach((pile, f) =>
      pile.forEach((card, j) => {
        this.layer.sync(card);
        this.where.set(card.id, { pile: 'found' });
        put(card.id, { x: L.foundX + f * L.foundStep, y: L.topY, z: 100 + f * 13 + j, faceUp: true });
      }),
    );

    const locked = settings.dimLocked ? lockedCards(s.columns) : new Set<number>();
    this.layer.els.forEach((el, id) => el.classList.toggle('locked', locked.has(id)));

    s.columns.forEach((col, c) =>
      col.forEach((card, i) => {
        this.layer.sync(card);
        this.where.set(card.id, { pile: 'col', col: c, index: i });
        put(card.id, { x: L.colX[c], y: this.cardY(c, i), z: 300 + i, faceUp: card.faceUp });
      }),
    );

    this.stockBadge.textContent = String(groups);
    this.stockBadge.hidden = groups === 0;
    this.stockBadge.style.transform = `translate(${L.stockX + L.cw - 24}px, ${L.topY + L.ch - 16}px)`;
    this.stockSlot.classList.toggle('empty', groups === 0);
    this.colSlots.forEach((slot, i) => slot.classList.toggle('empty', !s.columns[i].length));
    this.board.classList.toggle('can-deal', !dealBlocked(s, settings.dealWithEmpty));
    // Tell the Hint Bunny how far down each column reaches, so it can sit out of the way.
    this.hooks.occupied?.(
      s.columns.map((col, c) => ({
        x0: L.colX[c] / L.W,
        x1: (L.colX[c] + L.cw) / L.W,
        y: (col.length ? this.cardY(c, col.length - 1) + L.ch : L.tableTop) / L.H,
      })),
    );
  }

  /** Deal-in animation for a fresh game: everything starts on the stock. */
  private dealIn() {
    if (!this.L) this.relayout();
    const s = this.state;
    const all = [...s.stock, ...s.columns.flat()];
    for (const card of all) {
      this.layer.sync(card);
      this.layer.place(card.id, { x: this.L.stockX, y: this.L.topY, z: 10, faceUp: false }, false);
    }
    void this.board.offsetWidth;
    const step = this.fast ? 8 : 22;
    const order = new Map<number, number>();
    s.columns.forEach((col, c) => col.forEach((card, r) => order.set(card.id, INTRO_MS + (r * COLUMNS + c) * step)));
    this.render({ delay: (id) => order.get(id) ?? 0 });
    if (step) for (let i = 0; i < 54; i += 3) sfx.deal((INTRO_MS + i * step) / 1000);
  }

  // ───────────────────────── input ─────────────────────────

  private bindInput() {
    const b = this.board;
    b.addEventListener('pointerdown', (e) => this.onDown(e));
    b.addEventListener('pointermove', (e) => this.onMove(e));
    b.addEventListener('pointerup', (e) => this.onUp(e));
    b.addEventListener('pointercancel', () => this.cancelDrag());
    b.addEventListener('lostpointercapture', (e) => this.drag?.pointerId === e.pointerId && this.cancelDrag());
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onDown(e: PointerEvent) {
    unlockAudio();
    if (this.celebrating) return this.cascade!.skip();
    if (this.preview) return this.endPreview();
    if (this.drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const target = e.target as HTMLElement;

    if (target.closest('.stock-slot, .stock-badge')) return this.deal();
    const cardEl = target.closest<HTMLElement>('.card');
    if (!cardEl) return;
    const id = Number(cardEl.dataset.id);
    const w = this.where.get(id);
    if (!w) return;
    if (w.pile === 'stock') return this.deal();
    if (w.pile !== 'col') return;

    this.flush();
    // The completion may have just changed the board under the finger.
    const now = this.where.get(id);
    if (!now || now.pile !== 'col') return;

    if (!canPickUp(this.state, now.col, now.index)) {
      const card = this.state.columns[now.col][now.index];
      this.layer.wiggle([id]);
      haptic(15);
      if (card.faceUp) this.hooks.toast(t('spider.sameSuitOnly'));
      return;
    }

    const ids = this.state.columns[now.col].slice(now.index).map((c) => c.id);
    const base = ids.map((i) => {
      const p = this.layer.pos(i)!;
      return { x: p.x, y: p.y };
    });
    this.drag = {
      pointerId: e.pointerId,
      from: now.col,
      index: now.index,
      ids,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      dy: 0,
      moved: false,
      trail: base.map((p) => ({ ...p })),
      base,
      hover: null,
      legal: Array.from({ length: COLUMNS }, (_, to) => to).filter((to) => canMove(this.state, now.col, now.index, to)),
      boardLeft: this.board.getBoundingClientRect().left,
      raf: 0,
    };
    this.clearHint();
    ids.forEach((i) => this.layer.els.get(i)!.classList.add('lifted'));
    this.board.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    d.dx = e.clientX - d.startX;
    d.dy = e.clientY - d.startY;
    if (!d.moved) {
      if (Math.hypot(d.dx, d.dy) < DRAG_SLOP) return;
      d.moved = true;
      d.ids.forEach((i) => this.layer.els.get(i)!.classList.add('dragging'));
      this.board.classList.add('is-dragging');
      sfx.pick();
      haptic(5);
      if (settings.showTargets) {
        for (let to = 0; to < COLUMNS; to++) if (canMove(this.state, d.from, d.index, to)) this.showMarker(to, 'target');
      }
      const tick = () => {
        if (this.drag !== d) return;
        this.dragFrame(d);
        d.raf = requestAnimationFrame(tick);
      };
      d.raf = requestAnimationFrame(tick);
    }
  }

  private dragFrame(d: Drag) {
    d.ids.forEach((id, k) => {
      const tx = d.base[k].x + d.dx;
      const ty = d.base[k].y + d.dy;
      const t = d.trail[k];
      if (k === 0) {
        t.x = tx;
        t.y = ty;
      } else {
        // Each following card eases toward its slot under the one above it.
        const prev = d.trail[k - 1];
        const gx = prev.x + (d.base[k].x - d.base[k - 1].x);
        const gy = prev.y + (d.base[k].y - d.base[k - 1].y);
        t.x += (gx - t.x) * 0.55;
        t.y += (gy - t.y) * 0.55;
      }
      this.layer.drag(id, t.x, t.y, 2000 + k);
    });

    // Forgiving drop: snap to the nearest legal column within about a card's width of either
    // the dragged card or the finger, so a near miss next to an illegal column still lands.
    const cardX = d.trail[0].x + this.L.cw / 2;
    const fingerX = d.startX + d.dx - d.boardLeft;
    const reach = this.L.cw * 1.1;
    let next: number | null = null;
    let best = Infinity;
    for (const to of d.legal) {
      const center = this.L.colX[to] + this.L.cw / 2;
      const dist = Math.min(Math.abs(center - cardX), Math.abs(center - fingerX));
      if (dist < reach && dist < best) {
        best = dist;
        next = to;
      }
    }
    if (next !== d.hover) {
      if (d.hover !== null) this.markers[d.hover].classList.remove('hot');
      if (next !== null) {
        this.showMarker(next, 'target');
        this.markers[next].classList.add('hot');
        haptic(4);
      }
      d.hover = next;
    }
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    // Work out the drop spot from where it was let go (a quick flick can beat the next frame).
    if (d.moved) {
      d.dx = e.clientX - d.startX;
      d.dy = e.clientY - d.startY;
      this.dragFrame(d);
    }
    this.endDrag();
    if (d.moved) {
      if (d.hover !== null) return this.move(d.from, d.index, d.hover, true);
      this.render(); // snap back
      return;
    }
    // A tap: send the run to its best spot. By default that takes a double tap on the same card.
    if (!settings.tapToMove) return this.render();
    const tapped = d.ids[0];
    const now = performance.now();
    const second = this.lastTap?.id === tapped && now - this.lastTap.at < DOUBLE_TAP_MS;
    if (!settings.singleTap && !second) {
      this.lastTap = { id: tapped, at: now };
      this.render();
      // A short glow says "tap again to send it".
      for (const id of d.ids) flash(this.layer.els.get(id)!, 'tapped', DOUBLE_TAP_MS);
      return;
    }
    this.lastTap = null;
    const to = bestTarget(this.state, d.from, d.index);
    if (to === null) {
      this.render();
      this.layer.wiggle(d.ids);
      sfx.invalid();
      this.hooks.event?.('invalid', this.colFraction(d.from));
      haptic([15, 40, 15]);
      return;
    }
    this.move(d.from, d.index, to, false);
  }

  private endDrag() {
    const d = this.drag;
    if (!d) return;
    cancelAnimationFrame(d.raf);
    d.ids.forEach((i) => this.layer.els.get(i)!.classList.remove('lifted', 'dragging'));
    this.board.classList.remove('is-dragging');
    this.markers.forEach((m) => m.classList.remove('show', 'hot', 'target'));
    this.drag = null;
  }

  private cancelDrag() {
    if (!this.drag) return;
    this.endDrag();
    this.render();
  }

  private showMarker(col: number, kind: 'target' | 'hint') {
    const m = this.markers[col];
    const cards = this.state.columns[col];
    const y = cards.length ? this.cardY(col, cards.length - 1) + this.fans[col].next : this.L.tableTop;
    m.style.transform = `translate(${this.L.colX[col]}px, ${y}px)`;
    m.classList.add('show', kind);
  }

  private clearHint() {
    clearTimeout(this.hintTimer);
    this.layer.els.forEach((el) => el.classList.remove('hinted'));
    this.markers.forEach((m) => m.classList.remove('show', 'hint'));
  }

  // ───────────────────────── celebration ─────────────────────────

  private get celebrating() {
    return Boolean(this.cascade?.running);
  }

  /** Classic cascade: Kings first, one from each foundation in turn, then Queens, and so on. */
  private celebrate(onDone: () => void) {
    this.stopCelebration();
    // Played even with Reduce Motion on: it's the payoff for winning, and it can be skipped.
    const piles = this.state.foundations;
    const order: CascadeCard[] = [];
    for (let rank = 13; rank >= 1; rank--) {
      for (const pile of piles) {
        const card = pile[rank - 1];
        const p = this.layer.pos(card.id)!;
        order.push({ card, x: p.x, y: p.y });
      }
    }
    this.cascade = runCascade(this.board, order, { cw: this.L.cw, ch: this.L.ch }, settings.courts, () => {
      this.emitHud();
      onDone();
    });
  }

  /** Play the win cascade with this deal's cards without touching the game, score or stats. */
  previewWin() {
    if (!this.state || this.celebrating || this.preview) return;
    this.flush();
    this.cancelDrag();
    this.stopClock();
    const real = this.state;
    const fake = structuredClone(real);
    const cards = [...fake.columns.flat(), ...fake.stock, ...fake.foundations.flat()];
    const piles: Card[][] = [];
    for (const suit of new Set(cards.map((c) => c.suit))) {
      const ofSuit = cards.filter((c) => c.suit === suit).sort((a, b) => a.rank - b.rank);
      const n = ofSuit.length / 13;
      for (let p = 0; p < n; p++) piles.push(ofSuit.filter((_, i) => i % n === p));
    }
    piles.forEach((p) => p.forEach((c) => (c.faceUp = true)));
    fake.columns = fake.columns.map(() => []);
    fake.stock = [];
    fake.foundations = piles;
    this.preview = { real };
    this.state = fake;
    this.render({ animate: false });
    sfx.win();
    this.hooks.event?.('win');
    this.celebrate(() => this.hooks.toast(t('tapToReturn')));
  }

  private endPreview() {
    if (!this.preview) return;
    this.stopCelebration();
    this.state = this.preview.real;
    this.preview = null;
    this.render({ animate: false });
    this.emitHud();
    if (this.actions.length && !this.paused) this.startClock();
  }

  private stopCelebration() {
    this.cascade?.clear();
    this.cascade = null;
  }

  // ───────────────────────── helpers ─────────────────────────

  private colFraction(col: number) {
    return (this.L.colX[col] + this.L.cw / 2) / this.L.W;
  }

  private el(className: string) {
    const el = document.createElement('div');
    el.className = className;
    this.board.appendChild(el);
    return el;
  }
}

/** Face-up cards that sit above the movable run of their column, so can't be picked up. */
function lockedCards(columns: Card[][]): Set<number> {
  const ids = new Set<number>();
  for (const col of columns) {
    const start = runStart(col);
    for (let i = 0; i < start; i++) if (col[i].faceUp) ids.add(col[i].id);
  }
  return ids;
}
