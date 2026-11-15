import { randomSeed } from '../../core/cards';
import { CardLayer, type Placement } from '../../ui/cardLayer';
import { haptic, sfx, unlockAudio } from '../../ui/feedback';
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
  replay,
} from './rules';

export interface Hud {
  score: number;
  moves: number;
  ms: number;
  canUndo: boolean;
  suitCount: SuitCount;
}

export interface Stats {
  played: Record<SuitCount, number>;
  won: Record<SuitCount, number>;
  bestMs: Partial<Record<SuitCount, number>>;
}

export interface GameHooks {
  hud(h: Hud): void;
  toast(msg: string): void;
  won(result: { score: number; moves: number; ms: number; suitCount: SuitCount; stats: Stats; best: boolean }): void;
  stuck(): void;
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
  down: number;
  up: number;
}

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

const store = {
  get<T>(key: string): T | null {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or unavailable */
    }
  },
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export class SpiderGame {
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
  private hintIndex = 0;
  private hintTimer = 0;
  private celebrating: number | null = null;

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
    this.foundSlot = this.el('slot found-slot');
    for (let i = 0; i < COLUMNS; i++) {
      this.colSlots.push(this.el('slot col-slot'));
      this.markers.push(this.el('marker'));
    }
    this.stockSlot = this.el('slot stock-slot');
    this.stockSlot.setAttribute('role', 'button');
    this.stockSlot.setAttribute('aria-label', 'Deal a new row');
    this.stockBadge = this.el('stock-badge');

    this.bindInput();
    new ResizeObserver(() => this.relayout()).observe(board);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stopClock();
        this.save();
      } else if (this.actions.length && !isWon(this.state)) {
        this.startClock();
      }
    });
    setInterval(() => this.emitHud(), 1000);

    if (!this.restore()) this.newGame(4);
  }

  // ───────────────────────── public API ─────────────────────────

  get suitCount() {
    return this.state.suitCount;
  }

  newGame(suitCount: SuitCount, seed = randomSeed()) {
    this.flush();
    this.stopCelebration();
    this.state = newGame(seed, suitCount);
    this.actions = [];
    this.counted = false;
    this.msBefore = 0;
    this.clockStart = null;
    this.stuckNotified = -1;
    this.hintIndex = 0;
    this.save();
    this.dealIn();
    this.emitHud();
  }

  restart() {
    this.newGame(this.state.suitCount, this.state.seed);
  }

  undo() {
    if (this.celebrating !== null) return;
    this.flush();
    this.cancelDrag();
    if (!this.actions.length) return;
    this.actions.pop();
    this.state = replay(this.state.seed, this.state.suitCount, this.actions);
    this.hintIndex = 0;
    this.stuckNotified = -1;
    this.render();
    sfx.undo();
    haptic(6);
    this.save();
    this.emitHud();
  }

  deal() {
    if (this.celebrating !== null) return;
    this.flush();
    const blocked = dealBlocked(this.state);
    if (blocked === 'empty-stock') {
      this.hooks.toast('No more cards to deal');
      return;
    }
    if (blocked === 'empty-column') {
      this.hooks.toast('Fill every empty column before dealing');
      sfx.invalid();
      haptic([18, 50, 18]);
      this.colSlots.forEach((s, i) => !this.state.columns[i].length && flash(s, 'attention'));
      return;
    }
    const ids = this.commit({ t: 'deal' });
    const step = this.fast ? 20 : 55;
    this.render({ delay: (id) => ids.indexOf(id) * step });
    ids.forEach((_, i) => sfx.deal((i * step) / 1000));
    haptic(10);
    this.settleLater(ids.length * step + 260);
  }

  hint() {
    if (this.celebrating !== null) return;
    this.flush();
    this.clearHint();
    const moves = findMoves(this.state);
    if (!moves.length) {
      if (!dealBlocked(this.state)) {
        flash(this.stockSlot, 'hint');
        this.hooks.toast('No moves on the table — deal a new row');
      } else {
        this.hooks.toast('No moves left');
      }
      return;
    }
    const mv = moves[this.hintIndex++ % moves.length];
    const ids = this.state.columns[mv.from].slice(mv.index).map((c) => c.id);
    ids.forEach((id) => this.layer.els.get(id)!.classList.add('hinted'));
    this.showMarker(mv.to, 'hint');
    haptic(6);
    this.hintTimer = window.setTimeout(() => this.clearHint(), 1600);
  }

  /** Called when settings change. */
  refresh() {
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
    this.hintIndex = 0;
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
    const flipped = this.commit({ t: 'move', from, index, to });
    this.render({ delay: (id) => (fromDrag ? 0 : Math.max(0, ids.indexOf(id)) * 18) });
    sfx.place();
    haptic(8);
    if (flipped.length) {
      sfx.flip(0.14);
    }
    this.settleLater(fromDrag ? 200 : 260 + ids.length * 18);
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

  private checkStuck() {
    if (!settings.noMovesAlert || isWon(this.state)) return;
    if (this.stuckNotified === this.actions.length) return;
    if (findMoves(this.state).length) return;
    this.stuckNotified = this.actions.length;
    const blocked = dealBlocked(this.state);
    if (!blocked) {
      flash(this.stockSlot, 'hint');
      this.hooks.toast('No moves left on the table — deal a new row');
    } else if (blocked === 'empty-stock') {
      this.hooks.stuck();
    }
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
    this.celebrate();
    this.hooks.won({ score: this.state.score, moves: this.state.moves, ms, suitCount: s, stats: st, best });
    this.save();
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
    const data: Save = {
      seed: this.state.seed,
      suitCount: this.state.suitCount,
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
    if (this.actions.length) this.startClock();
    window.setTimeout(() => this.checkStuck(), 600);
    return true;
  }

  private emitHud() {
    if (!this.state) return;
    this.hooks.hud({
      score: this.state.score,
      moves: this.state.moves,
      ms: this.elapsed(),
      canUndo: this.actions.length > 0 && this.celebrating === null,
      suitCount: this.state.suitCount,
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

    if (this.state && this.celebrating === null) {
      this.cancelDrag();
      this.render({ animate: false });
    }
  }

  private computeFans() {
    const { ch, tableTop, bottom } = this.L;
    const baseDown = ch * 0.12;
    const baseUp = ch * 0.3;
    const avail = bottom - tableTop - ch;
    this.fans = this.state.columns.map((col) => {
      const d = col.filter((c) => !c.faceUp).length;
      const u = col.length - d;
      let down = baseDown;
      let up = baseUp;
      const need = d * down + Math.max(0, u - 1) * up;
      if (need > avail) {
        down = Math.max(ch * 0.05, down * (avail / need));
        if (u > 1) up = Math.min(baseUp, Math.max(ch * 0.17, (avail - d * down) / (u - 1)));
      }
      return { down, up };
    });
  }

  private cardY(col: number, index: number) {
    const fan = this.fans[col];
    const cards = this.state.columns[col];
    let y = this.L.tableTop;
    for (let i = 0; i < index; i++) y += cards[i].faceUp ? fan.up : fan.down;
    return Math.round(y);
  }

  private render(opts: { animate?: boolean; delay?: (id: number) => number } = {}) {
    if (!this.L) this.relayout();
    if (!this.L) return;
    const animate = (opts.animate ?? true) && !this.fast;
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
    this.board.classList.toggle('can-deal', !dealBlocked(s));
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
    const step = this.fast ? 0 : 22;
    const order = new Map<number, number>();
    s.columns.forEach((col, c) => col.forEach((card, r) => order.set(card.id, (r * COLUMNS + c) * step)));
    this.render({ delay: (id) => order.get(id) ?? 0 });
    if (step) for (let i = 0; i < 54; i += 2) sfx.deal((i * step) / 1000);
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
    if (this.celebrating !== null) return;
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
      if (card.faceUp) this.hooks.toast('Only cards of the same suit in order move together');
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

    const cx = d.trail[0].x + this.L.cw / 2;
    let hover = 0;
    let best = Infinity;
    this.L.colX.forEach((x, i) => {
      const dist = Math.abs(x + this.L.cw / 2 - cx);
      if (dist < best) {
        best = dist;
        hover = i;
      }
    });
    const valid = hover !== d.from && canMove(this.state, d.from, d.index, hover);
    const next = valid ? hover : null;
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
    this.endDrag();
    if (d.moved) {
      if (d.hover !== null) return this.move(d.from, d.index, d.hover, true);
      this.render(); // snap back
      return;
    }
    // A tap: send the run to its best spot.
    if (!settings.tapToMove) return this.render();
    const to = bestTarget(this.state, d.from, d.index);
    if (to === null) {
      this.render();
      this.layer.wiggle(d.ids);
      sfx.invalid();
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
    const y = cards.length ? this.cardY(col, cards.length - 1) + this.fans[col].up : this.L.tableTop;
    m.style.transform = `translate(${this.L.colX[col]}px, ${y}px)`;
    m.classList.add('show', kind);
  }

  private clearHint() {
    clearTimeout(this.hintTimer);
    this.layer.els.forEach((el) => el.classList.remove('hinted'));
    this.markers.forEach((m) => m.classList.remove('show', 'hint'));
  }

  // ───────────────────────── celebration ─────────────────────────

  private celebrate() {
    if (this.fast) return;
    const cards = this.state.foundations.flatMap((pile) => [...pile].reverse());
    const { W, H, ch, cw } = this.L;
    const floor = H - ch;
    const bodies = cards.map((card, i) => {
      const p = this.layer.pos(card.id)!;
      const el = this.layer.els.get(card.id)!;
      return {
        el,
        x: p.x,
        y: p.y,
        vx: (Math.random() < 0.5 ? -1 : 1) * (1.5 + Math.random() * 4) * (cw / 40),
        vy: -(Math.random() * 6) * (ch / 60),
        start: i * 70,
        done: false,
      };
    });
    const g = 0.45 * (ch / 60);
    const t0 = performance.now();
    let prev = t0;
    const frame = (now: number) => {
      const dt = Math.min(2, (now - prev) / 16.7);
      prev = now;
      let alive = 0;
      for (const b of bodies) {
        if (b.done || now - t0 < b.start) {
          if (!b.done) alive++;
          continue;
        }
        alive++;
        b.el.classList.add('no-anim');
        b.vy += g * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        if (b.y > floor) {
          b.y = floor;
          b.vy *= -0.72;
        }
        if (b.x < -cw * 1.5 || b.x > W + cw * 0.5) b.done = true;
        b.el.style.transform = `translate3d(${b.x}px, ${b.y}px, 0) rotate(${b.vx * (now - t0) * 0.02}deg)`;
        b.el.style.zIndex = String(3000 + Math.round(now - t0 - b.start) % 1000);
      }
      if (alive && now - t0 < 12000) this.celebrating = requestAnimationFrame(frame);
      else this.celebrating = null;
    };
    this.celebrating = requestAnimationFrame(frame);
  }

  private stopCelebration() {
    if (this.celebrating !== null) cancelAnimationFrame(this.celebrating);
    this.celebrating = null;
  }

  // ───────────────────────── helpers ─────────────────────────

  private el(className: string) {
    const el = document.createElement('div');
    el.className = className;
    this.board.appendChild(el);
    return el;
  }
}

function flash(el: HTMLElement, cls: string) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), 1600);
}
