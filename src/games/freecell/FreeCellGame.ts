import { type Card, randomSeed } from '../../core/cards';
import { type GameController, type GameHooks, INTRO_MS, fmtTime, store } from '../../core/game';
import { CardLayer, MOVE_MS, MOVE_MS_REDUCED, type Placement } from '../../ui/cardLayer';
import { type Cascade, type CascadeCard, runCascade } from '../../ui/cascade';
import { haptic, sfx, unlockAudio } from '../../ui/feedback';
import { flash } from '../../ui/fx';
import { settings } from '../../ui/settings';
import { Hints } from './hints';
import {
  CASCADES,
  CELLS,
  FOUND_SUITS,
  type FreeCellState,
  type Loc,
  type Move,
  applyMove,
  autoPlay,
  bestTarget,
  canMove,
  isWon,
  legalMoves,
  maxMove,
  newGame,
  replay,
  runLength,
} from './rules';

interface Stats {
  played: number;
  won: number;
  bestMs?: number;
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
}

type Where = { pile: 'col'; col: number; index: number } | { pile: 'cell'; i: number } | { pile: 'found'; i: number };

interface Drag {
  pointerId: number;
  from: Loc;
  n: number;
  ids: number[];
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  moved: boolean;
  trail: { x: number; y: number }[];
  base: { x: number; y: number }[];
  hover: Loc | null;
  /** Everywhere these cards may legally go, worked out at pick-up. */
  legal: Loc[];
  boardRect: DOMRect;
  raf: number;
}

interface Save {
  seed: number;
  moves: Move[];
  ms: number;
  counted: boolean;
}

const SAVE_KEY = 'ninnies.freecell.save.v1';
const STATS_KEY = 'ninnies.freecell.stats.v1';
const DRAG_SLOP = 7;
const DOUBLE_TAP_MS = 380;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const sameLoc = (a: Loc | null, b: Loc | null) => !!a && !!b && a.t === b.t && a.i === b.i;

export class FreeCellGame implements GameController {
  readonly id = 'freecell' as const;
  readonly restartLabel = 'Restart this deal';

  private state!: FreeCellState;
  private moves: Move[] = [];
  private counted = false;
  private layer: CardLayer;
  private L!: Layout;
  private gaps: number[] = [];
  private where = new Map<number, Where>();
  private drag: Drag | null = null;
  private msBefore = 0;
  private clockStart: number | null = null;
  private paused = false;
  private cascade: Cascade | null = null;
  private preview: { real: FreeCellState } | null = null;
  private lastTap: { id: number; at: number } | null = null;
  private hintTimer = 0;
  private stuckTimer = 0;
  private stuckNotified = -1;
  private hints = new Hints();

  private colSlots: HTMLElement[] = [];
  private cellSlots: HTMLElement[] = [];
  private foundSlots: HTMLElement[] = [];
  private markers: HTMLElement[] = [];

  constructor(
    private board: HTMLElement,
    private hooks: GameHooks,
  ) {
    board.classList.add('freecell-root');
    this.layer = new CardLayer(board);
    this.layer.setCourts(settings.courts);
    for (let i = 0; i < CELLS; i++) this.cellSlots.push(this.el('slot fc-cell'));
    FOUND_SUITS.forEach((suit) => {
      const s = this.el('slot fc-found');
      s.dataset.suit = suit;
      this.foundSlots.push(s);
    });
    for (let i = 0; i < CASCADES; i++) {
      this.colSlots.push(this.el('slot col-slot'));
      this.markers.push(this.el('marker'));
    }
    this.bindInput();
    new ResizeObserver(() => {
      if (this.L && board.clientWidth === this.L.W && board.clientHeight === this.L.H) return;
      this.relayout();
    }).observe(board);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stopClock();
        this.save();
      } else if (!this.paused && this.state && this.moves.length && !isWon(this.state)) {
        this.startClock();
      }
    });
    setInterval(() => this.emitHud(), 1000);
  }

  /** The saved, unfinished game if there is one. */
  static saved(): { moves: number; ms: number } | null {
    const data = store.get<Save>(SAVE_KEY);
    if (!data || !data.moves.length) return null;
    try {
      const s = replay(data.seed, data.moves);
      return isWon(s) ? null : { moves: s.moves, ms: data.ms };
    } catch {
      return null;
    }
  }

  // ───────────────────────── controller ─────────────────────────

  get active() {
    return Boolean(this.state);
  }

  status() {
    return `FreeCell · ${this.state.moves} moves · ${fmtTime(this.elapsed())}`;
  }

  key() {
    return false;
  }

  setVisible(on: boolean) {
    this.board.hidden = !on;
    if (on) this.relayout();
  }

  resume(): boolean {
    const data = store.get<Save>(SAVE_KEY);
    if (!data) return false;
    try {
      this.state = replay(data.seed, data.moves);
    } catch {
      return false;
    }
    if (isWon(this.state)) return false;
    this.moves = data.moves;
    this.counted = data.counted;
    this.msBefore = data.ms;
    this.hints.clear();
    this.relayout();
    this.emitHud();
    this.think();
    return true;
  }

  pause() {
    if (!this.state) return;
    this.endPreview();
    this.paused = true;
    this.cancelDrag();
    this.stopClock();
    this.save();
  }

  unpause() {
    this.paused = false;
    if (this.state && this.moves.length && !isWon(this.state)) this.startClock();
    this.emitHud();
  }

  newGame(seed = randomSeed()) {
    this.endPreview();
    this.stopCelebration();
    this.state = newGame(seed);
    // Aces (and twos after them) dealt to the bottom of a column go home once the deal is done.
    autoPlay(this.state);
    this.moves = [];
    this.counted = false;
    this.msBefore = 0;
    this.clockStart = null;
    this.stuckNotified = -1;
    this.hints.clear();
    this.save();
    this.dealIn();
    this.hooks.event?.('start');
    this.emitHud();
    this.think();
  }

  restart() {
    this.newGame(this.state.seed);
  }

  again() {
    this.newGame();
  }

  undo() {
    if (this.celebrating) return;
    if (this.preview) return this.endPreview();
    this.cancelDrag();
    if (!this.moves.length) return;
    this.moves.pop();
    this.state = replay(this.state.seed, this.moves);
    this.stuckNotified = -1;
    this.render();
    sfx.undo();
    this.hooks.event?.('undo');
    haptic(6);
    this.save();
    this.emitHud();
  }

  refresh() {
    if (!this.state) return;
    this.layer.setCourts(settings.courts);
    this.render({ animate: false });
  }

  async hint() {
    if (this.celebrating) return;
    if (this.preview) return this.endPreview();
    this.clearHint();
    const at = this.moves.length;
    const known = this.hints.peek(this.state);
    if (known === undefined) this.hooks.toast('Thinking…');
    const line = known === undefined ? await this.hints.line(this.state) : known;
    if (this.moves.length !== at || this.paused) return;
    const m = line?.[0];
    if (!m) {
      this.hooks.toast(legalMoves(this.state).length ? 'No winning way from here: try Undo' : 'No moves left');
      this.hooks.hint?.(null, 'none');
      return;
    }
    this.pickIds(m.from, m.n).forEach((id) => this.layer.els.get(id)!.classList.add('hinted'));
    this.showTarget(m.to, 'hint');
    haptic(6);
    this.hooks.hint?.({ from: this.locFraction(m.from), to: this.locFraction(m.to) }, 'move');
    this.hintTimer = window.setTimeout(() => this.clearHint(), 2600);
  }

  // ───────────────────────── flow ─────────────────────────

  private get fast() {
    return reducedMotion.matches;
  }

  private stats(): Stats {
    return store.get<Stats>(STATS_KEY) ?? { played: 0, won: 0 };
  }

  /** Start solving the current position in the background, so hints are instant. */
  private think() {
    if (this.state && !isWon(this.state)) void this.hints.line(this.state);
  }

  private move(m: Move, fromDrag: boolean) {
    this.clearHint();
    clearTimeout(this.stuckTimer);
    const before = structuredClone(this.state);
    const ids = this.pickIds(m.from, m.n);
    const landAt = ((this.fast ? MOVE_MS_REDUCED : MOVE_MS) * 0.65) / 1000;
    if (fromDrag) sfx.drop();
    else sfx.move(ids.length, landAt);
    haptic(8);
    this.moves.push(m);
    applyMove(this.state, m);
    if (!this.counted) {
      this.counted = true;
      const st = this.stats();
      st.played++;
      store.set(STATS_KEY, st);
    }
    // Then every safe card flies home, one after another once the move has landed.
    const autos = autoPlay(this.state);
    const flight = new Map<number, number>();
    const settleMs = fromDrag ? 120 : MOVE_MS - 40;
    autos.forEach((a, k) => flight.set(this.state.foundations[a.to.i].at(-1)!.id, settleMs + k * 90));
    this.render({ delay: (id) => flight.get(id) ?? (fromDrag ? 0 : Math.max(0, ids.indexOf(id)) * 18) });
    autos.forEach((_, k) => sfx.move(1, (settleMs + k * 90) / 1000 + landAt));
    this.startClock();
    this.save();
    this.emitHud();
    const home = m.to.t === 'found' || autos.length > 0;
    const done = this.state.foundations.some((f, i) => f.length === 13 && before.foundations[i].length < 13);
    this.hooks.event?.(done ? 'complete' : home ? 'suit' : 'move', this.locFraction(m.to));
    if (isWon(this.state)) {
      window.setTimeout(() => this.win(), settleMs + autos.length * 90 + (this.fast ? 200 : 700));
      return;
    }
    this.judge(before, m);
    this.checkStuck();
  }

  /**
   * The Hint Bunny frowns at a move that turned a winnable game into one it can't win (the hinted
   * move never is one). Works off the background solver, so it never holds up play.
   */
  private judge(before: FreeCellState, m: Move) {
    const could = this.hints.peek(before);
    if (!could?.length) return this.think();
    const at = this.moves.length;
    void this.hints.line(this.state).then((line) => {
      if (line || this.moves.length !== at || this.celebrating) return;
      this.hooks.event?.('blunder', this.locFraction(m.to));
    });
  }

  private checkStuck() {
    clearTimeout(this.stuckTimer);
    const at = this.moves.length;
    this.stuckTimer = window.setTimeout(() => {
      if (this.moves.length !== at || this.drag || !settings.noMovesAlert || this.stuckNotified === at) return;
      if (legalMoves(this.state).length) return;
      this.stuckNotified = at;
      this.hooks.stuck();
    }, 1100);
  }

  private win() {
    this.stopClock();
    const ms = this.elapsed();
    const st = this.stats();
    st.won++;
    const best = st.bestMs === undefined || ms < st.bestMs;
    if (best) st.bestMs = ms;
    store.set(STATS_KEY, st);
    sfx.win();
    haptic([20, 60, 20, 60, 40]);
    this.hooks.event?.('win');
    this.save();
    const result = {
      title: 'You won!',
      line: `${this.state.moves} moves · ${fmtTime(ms)}${best ? ' · new best time!' : ''}`,
      stats: [
        { label: 'Moves', value: String(this.state.moves) },
        { label: 'Won', value: `${st.won}/${st.played}` },
        { label: 'Best', value: st.bestMs !== undefined ? fmtTime(st.bestMs) : '–' },
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
    store.set(SAVE_KEY, { seed: state.seed, moves: this.moves, ms: Math.round(this.elapsed()), counted: this.counted } satisfies Save);
  }

  private emitHud() {
    if (!this.state) return;
    this.hooks.hud({
      stats: [
        { label: 'Moves', value: String(this.state.moves) },
        { label: 'Time', value: fmtTime(this.elapsed()) },
      ],
      canUndo: this.moves.length > 0 && !this.celebrating,
      hasUndo: true,
    });
  }

  // ───────────────────────── layout & render ─────────────────────────

  private relayout() {
    const W = this.board.clientWidth;
    const H = this.board.clientHeight;
    if (!W || !H) return;
    const gap = Math.round(Math.min(14, Math.max(3, W * 0.012)));
    const pad = Math.max(gap, 6);
    const cw = Math.floor(Math.min((W - pad * 2 - gap * (CASCADES - 1)) / CASCADES, (H - 20) / 5.4, 118));
    const ch = Math.round(cw * 1.4);
    const left = Math.round((W - (cw * CASCADES + gap * (CASCADES - 1))) / 2);
    const colX = Array.from({ length: CASCADES }, (_, i) => left + i * (cw + gap));
    const topY = pad;
    this.L = { W, H, cw, ch, colX, topY, tableTop: topY + ch + Math.max(gap * 2, 12), bottom: H - pad };
    this.board.style.setProperty('--cw', `${cw}px`);
    this.board.style.setProperty('--ch', `${ch}px`);
    const at = (el: HTMLElement, x: number, y: number) => (el.style.transform = `translate(${x}px, ${y}px)`);
    // Free cells over the left half, foundations over the right.
    this.cellSlots.forEach((s, i) => at(s, colX[i], topY));
    this.foundSlots.forEach((s, i) => at(s, colX[CELLS + i], topY));
    this.colSlots.forEach((s, i) => at(s, colX[i], this.L.tableTop));
    if (this.state && !this.celebrating) {
      this.cancelDrag();
      this.render({ animate: false });
    }
  }

  private cardY(col: number, index: number) {
    return Math.round(this.L.tableTop + index * this.gaps[col]);
  }

  private render(opts: { animate?: boolean; delay?: (id: number) => number } = {}) {
    if (!this.L) this.relayout();
    if (!this.L) return;
    const animate = opts.animate ?? true;
    const s = this.state;
    const L = this.L;
    const put = (card: Card, w: Where, p: Placement) => {
      this.layer.sync(card);
      this.where.set(card.id, w);
      this.layer.place(card.id, { ...p, delay: opts.delay?.(card.id) ?? 0 }, animate);
    };
    this.where.clear();
    // Like Spider: only the run at the bottom of each column can move; shade the rest.
    const locked = new Set<number>();
    if (settings.dimLocked) for (const col of s.cascades) col.slice(0, col.length - runLength(col)).forEach((c) => locked.add(c.id));
    this.layer.els.forEach((el, id) => el.classList.toggle('locked', locked.has(id)));
    // Columns squeeze together when they'd run off the bottom.
    const room = L.bottom - L.tableTop - L.ch;
    // Tall screens fan the columns further apart, so ranks are easier to read.
    const most = L.ch * (L.H > L.W ? 0.42 : 0.28);
    this.gaps = s.cascades.map((col) => Math.min(most, col.length > 1 ? room / (col.length - 1) : L.ch));

    s.foundations.forEach((pile, i) => pile.forEach((c, j) => put(c, { pile: 'found', i }, { x: L.colX[CELLS + i], y: L.topY, z: 100 + j, faceUp: true })));
    s.cells.forEach((c, i) => c && put(c, { pile: 'cell', i }, { x: L.colX[i], y: L.topY, z: 200, faceUp: true }));
    s.cascades.forEach((col, c) => col.forEach((card, i) => put(card, { pile: 'col', col: c, index: i }, { x: L.colX[c], y: this.cardY(c, i), z: 300 + i, faceUp: true })));

    this.colSlots.forEach((slot, i) => slot.classList.toggle('empty', !s.cascades[i].length));
    this.hooks.occupied?.(
      s.cascades.map((col, c) => ({
        x0: L.colX[c] / L.W,
        x1: (L.colX[c] + L.cw) / L.W,
        y: (col.length ? this.cardY(c, col.length - 1) + L.ch : L.tableTop) / L.H,
      })),
    );
  }

  /** New deal: the cards fly out from the middle of the top row, row by row. */
  private dealIn() {
    if (!this.L) this.relayout();
    const homeEarly = this.state.foundations.flat();
    const all = [...this.state.cascades.flat(), ...homeEarly];
    const from = { x: (this.L.W - this.L.cw) / 2, y: this.L.topY };
    for (const card of all) {
      this.layer.sync(card);
      this.layer.place(card.id, { ...from, z: 10, faceUp: false }, false);
    }
    void this.board.offsetWidth;
    const step = this.fast ? 8 : 20;
    const order = new Map<number, number>();
    this.state.cascades.forEach((col, c) => col.forEach((card, r) => order.set(card.id, INTRO_MS + (r * CASCADES + c) * step)));
    homeEarly.forEach((card, k) => order.set(card.id, INTRO_MS + 52 * step + 200 + k * 120));
    this.render({ delay: (id) => order.get(id) ?? 0 });
    if (step) for (let i = 0; i < 52; i += 3) sfx.deal((INTRO_MS + i * step) / 1000);
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

  /** The cards (bottom of a column, or a free cell's card) a move from `from` picks up. */
  private pickIds(from: Loc, n: number) {
    if (from.t === 'col') return this.state.cascades[from.i].slice(-n).map((c) => c.id);
    if (from.t === 'cell') return this.state.cells[from.i] ? [this.state.cells[from.i]!.id] : [];
    return [];
  }

  private onDown(e: PointerEvent) {
    unlockAudio();
    if (this.celebrating) return this.cascade!.skip();
    if (this.preview) return this.endPreview();
    if (this.drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const cardEl = (e.target as HTMLElement).closest<HTMLElement>('.card');
    if (!cardEl) return;
    const id = Number(cardEl.dataset.id);
    const w = this.where.get(id);
    if (!w || w.pile === 'found') return;
    let from: Loc;
    let n = 1;
    if (w.pile === 'cell') from = { t: 'cell', i: w.i };
    else {
      const col = this.state.cascades[w.col];
      n = col.length - w.index;
      from = { t: 'col', i: w.col };
      if (n > runLength(col)) {
        this.layer.wiggle([id]);
        haptic(15);
        this.hooks.toast('Only an alternating-colour run moves together');
        return;
      }
    }
    const ids = this.pickIds(from, n);
    const base = ids.map((i) => ({ ...this.layer.pos(i)! }));
    const spots: Loc[] = [
      ...FOUND_SUITS.map((_, i) => ({ t: 'found' as const, i })),
      ...this.cellSlots.map((_, i) => ({ t: 'cell' as const, i })),
      ...this.colSlots.map((_, i) => ({ t: 'col' as const, i })),
    ];
    this.drag = {
      pointerId: e.pointerId,
      from,
      n,
      ids,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      dy: 0,
      moved: false,
      trail: base.map((p) => ({ x: p.x, y: p.y })),
      base: base.map((p) => ({ x: p.x, y: p.y })),
      hover: null,
      legal: spots.filter((to) => canMove(this.state, { from, to, n })),
      boardRect: this.board.getBoundingClientRect(),
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
    if (d.moved || Math.hypot(d.dx, d.dy) < DRAG_SLOP) return;
    d.moved = true;
    d.ids.forEach((i) => this.layer.els.get(i)!.classList.add('dragging'));
    this.board.classList.add('is-dragging');
    sfx.pick();
    haptic(5);
    if (settings.showTargets) d.legal.forEach((to) => this.showTarget(to, 'target'));
    const tick = () => {
      if (this.drag !== d) return;
      this.dragFrame(d);
      d.raf = requestAnimationFrame(tick);
    };
    d.raf = requestAnimationFrame(tick);
  }

  /** Where a spot is on the board: its top-left corner. */
  private spotXY(to: Loc) {
    const L = this.L;
    if (to.t === 'col') {
      const col = this.state.cascades[to.i];
      return { x: L.colX[to.i], y: col.length ? this.cardY(to.i, col.length - 1) : L.tableTop };
    }
    return { x: L.colX[to.t === 'cell' ? to.i : CELLS + to.i], y: L.topY };
  }

  private dragFrame(d: Drag) {
    d.ids.forEach((id, k) => {
      const t = d.trail[k];
      if (k === 0) {
        t.x = d.base[0].x + d.dx;
        t.y = d.base[0].y + d.dy;
      } else {
        const prev = d.trail[k - 1];
        t.x += (prev.x + (d.base[k].x - d.base[k - 1].x) - t.x) * 0.55;
        t.y += (prev.y + (d.base[k].y - d.base[k - 1].y) - t.y) * 0.55;
      }
      this.layer.drag(id, t.x, t.y, 2000 + k);
    });
    // Forgiving drop: the nearest legal spot to the dragged card or the finger, within reach.
    const L = this.L;
    const card = { x: d.trail[0].x + L.cw / 2, y: d.trail[0].y + L.ch / 2 };
    const finger = { x: d.startX + d.dx - d.boardRect.left, y: d.startY + d.dy - d.boardRect.top };
    const topRow = Math.min(card.y, finger.y) < L.tableTop - 4;
    let next: Loc | null = null;
    let best = Infinity;
    for (const to of d.legal) {
      if ((to.t !== 'col') !== topRow) continue;
      const p = this.spotXY(to);
      const cx = p.x + L.cw / 2;
      const dist = Math.min(Math.abs(cx - card.x), Math.abs(cx - finger.x));
      if (dist < L.cw * 1.1 && dist < best) (best = dist), (next = to);
    }
    if (!sameLoc(next, d.hover)) {
      if (d.hover) this.targetEl(d.hover).classList.remove('hot');
      if (next) {
        this.showTarget(next, 'target');
        this.targetEl(next).classList.add('hot');
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
      if (d.hover) return this.move({ from: d.from, to: d.hover, n: d.n }, true);
      return this.render();
    }
    if (!settings.tapToMove) return this.render();
    const tapped = d.ids[0];
    const now = performance.now();
    const second = this.lastTap?.id === tapped && now - this.lastTap.at < DOUBLE_TAP_MS;
    if (!settings.singleTap && !second) {
      this.lastTap = { id: tapped, at: now };
      this.render();
      for (const id of d.ids) flash(this.layer.els.get(id)!, 'tapped', DOUBLE_TAP_MS);
      return;
    }
    this.lastTap = null;
    const to = bestTarget(this.state, d.from, d.n);
    if (!to) {
      this.render();
      this.layer.wiggle(d.ids);
      sfx.invalid();
      this.hooks.event?.('invalid', this.locFraction(d.from));
      haptic([15, 40, 15]);
      if (d.n > maxMove(this.state, false)) this.hooks.toast('Not enough free cells to move that many');
      return;
    }
    this.move({ from: d.from, to, n: d.n }, false);
  }

  private endDrag() {
    const d = this.drag;
    if (!d) return;
    cancelAnimationFrame(d.raf);
    d.ids.forEach((i) => this.layer.els.get(i)!.classList.remove('lifted', 'dragging'));
    this.board.classList.remove('is-dragging');
    this.clearTargets();
    this.drag = null;
  }

  private cancelDrag() {
    if (!this.drag) return;
    this.endDrag();
    this.render();
  }

  /** The element that lights up for a spot: a column's marker, or the cell or foundation slot. */
  private targetEl(to: Loc) {
    return to.t === 'col' ? this.markers[to.i] : to.t === 'cell' ? this.cellSlots[to.i] : this.foundSlots[to.i];
  }

  private showTarget(to: Loc, kind: 'target' | 'hint') {
    const el = this.targetEl(to);
    if (to.t === 'col') {
      const col = this.state.cascades[to.i];
      const y = col.length ? this.cardY(to.i, col.length - 1) + (this.gaps[to.i] || this.L.ch * 0.28) : this.L.tableTop;
      el.style.transform = `translate(${this.L.colX[to.i]}px, ${y}px)`;
      el.classList.add('show', kind);
    } else {
      el.classList.add(kind === 'hint' ? 'hint' : 'target');
    }
  }

  private clearTargets() {
    this.markers.forEach((m) => m.classList.remove('show', 'hot', 'target'));
    [...this.cellSlots, ...this.foundSlots].forEach((s) => s.classList.remove('hot', 'target'));
  }

  private clearHint() {
    clearTimeout(this.hintTimer);
    this.layer.els.forEach((el) => el.classList.remove('hinted'));
    this.markers.forEach((m) => m.classList.remove('show', 'hint'));
    [...this.cellSlots, ...this.foundSlots].forEach((s) => s.classList.remove('hint'));
  }

  private locFraction(at: Loc) {
    if (!this.L) return 0.5;
    const x = at.t === 'col' ? this.L.colX[at.i] : this.L.colX[at.t === 'cell' ? at.i : CELLS + at.i];
    return (x + this.L.cw / 2) / this.L.W;
  }

  // ───────────────────────── celebration ─────────────────────────

  private get celebrating() {
    return Boolean(this.cascade?.running);
  }

  private celebrate(onDone: () => void) {
    this.stopCelebration();
    const order: CascadeCard[] = [];
    for (let rank = 13; rank >= 1; rank--) {
      for (const pile of this.state.foundations) {
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

  previewWin() {
    if (!this.state || this.celebrating || this.preview) return;
    this.cancelDrag();
    this.stopClock();
    const real = this.state;
    const fake = structuredClone(real);
    const all = [...fake.cascades.flat(), ...fake.cells.filter((c): c is Card => !!c), ...fake.foundations.flat()];
    fake.foundations = FOUND_SUITS.map((suit) => all.filter((c) => c.suit === suit).sort((a, b) => a.rank - b.rank));
    fake.cascades = fake.cascades.map(() => []);
    fake.cells = fake.cells.map(() => null);
    this.preview = { real };
    this.state = fake;
    this.render({ animate: false });
    sfx.win();
    this.hooks.event?.('win');
    this.celebrate(() => this.hooks.toast('Tap to return to your game'));
  }

  private endPreview() {
    if (!this.preview) return;
    this.stopCelebration();
    this.state = this.preview.real;
    this.preview = null;
    this.render({ animate: false });
    this.emitHud();
    if (this.moves.length && !this.paused) this.startClock();
  }

  private stopCelebration() {
    this.cascade?.clear();
    this.cascade = null;
  }

  private el(cls: string) {
    const e = document.createElement('div');
    e.className = cls;
    this.board.appendChild(e);
    return e;
  }
}
