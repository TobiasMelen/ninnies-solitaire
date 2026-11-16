import { randomSeed } from '../../core/cards';
import { type GameController, type GameHooks, fmtTime, store } from '../../core/game';
import { haptic, sfx, unlockAudio } from '../../ui/feedback';
import { flash } from '../../ui/fx';
import { settings } from '../../ui/settings';
import { type MinesLevel, type MinesState, SIZES, chord, flagsLeft, newGame, reveal, safeCell, toggleFlag } from './rules';

const SAVE_KEY = 'ninnies.mines.save.v1';
const LONG_PRESS = 420;
const LEVEL_ICON: Record<MinesLevel, string> = { easy: '🌱', medium: '🌿', hard: '🌳' };

interface Save {
  state: MinesState;
  ms: number;
}

interface Press {
  pointerId: number;
  i: number;
  x: number;
  y: number;
  timer: number;
  handled: boolean;
}

/**
 * Minesweeper, touch-first: tap to open, long-press (or the 🚩 mode switch) to flag, tap a
 * satisfied number to clear around it. Unopened cells look like little card backs.
 */
export class MinesGame implements GameController {
  readonly id = 'mines' as const;
  readonly restartLabel = 'Restart this board';

  private state!: MinesState;
  private history: MinesState[] = [];
  private grid: HTMLElement;
  private modeBtn: HTMLButtonElement;
  private cells: HTMLElement[] = [];
  /** The grid is drawn transposed when that fits the screen better (e.g. Hard in portrait). */
  private transposed = false;
  private flagMode = false;
  private press: Press | null = null;
  private paused = true;
  private msBefore = 0;
  private clockStart: number | null = null;
  /** Board size the layout was last made for (see SpiderGame's observer). */
  private sized = '';

  constructor(
    private root: HTMLElement,
    private hooks: GameHooks,
  ) {
    root.classList.add('mines-root');
    this.grid = document.createElement('div');
    this.grid.className = 'mines-grid';
    root.appendChild(this.grid);
    this.modeBtn = document.createElement('button');
    this.modeBtn.type = 'button';
    this.modeBtn.className = 'mines-mode';
    this.modeBtn.setAttribute('aria-label', 'Switch between digging and flagging');
    this.modeBtn.addEventListener('click', () => this.setFlagMode(!this.flagMode));
    root.appendChild(this.modeBtn);
    this.setFlagMode(false);

    this.grid.addEventListener('pointerdown', (e) => this.onDown(e));
    this.grid.addEventListener('pointermove', (e) => this.onMove(e));
    this.grid.addEventListener('pointerup', (e) => this.onUp(e));
    this.grid.addEventListener('pointercancel', () => this.cancelPress());
    this.grid.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => {
      const key = `${root.clientWidth}x${root.clientHeight}`;
      if (key === this.sized) return;
      this.sized = key;
      this.relayout();
    }).observe(root);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stopClock();
        this.save();
      } else if (!this.paused) this.startClock();
    });
    setInterval(() => !this.paused && this.emitHud(), 1000);
  }

  // ───────────────────────── controller ─────────────────────────

  get active() {
    return Boolean(this.state);
  }

  get level(): MinesLevel {
    return this.state?.level ?? 'easy';
  }

  static saved(): string | null {
    const d = store.get<Save>(SAVE_KEY);
    if (!d || d.state.won || d.state.lost !== null || !d.state.placed) return null;
    return `Minesweeper ${LEVEL_ICON[d.state.level]} · 💣 ${flagsLeft(d.state)} · ${fmtTime(d.ms)}`;
  }

  static savedLevel(): MinesLevel | null {
    return store.get<Save>(SAVE_KEY)?.state.level ?? null;
  }

  status() {
    return `Minesweeper ${LEVEL_ICON[this.level]} · 💣 ${flagsLeft(this.state)} left · ${fmtTime(this.elapsed())}`;
  }

  newGame(level: MinesLevel = this.level, seed = randomSeed()) {
    this.state = newGame(seed, level);
    this.history = [];
    this.msBefore = 0;
    this.clockStart = null;
    this.setFlagMode(false);
    this.build();
    this.save();
    this.hooks.event?.('start');
    this.emitHud();
  }

  restart() {
    this.newGame(this.level, this.state.seed);
  }

  again() {
    this.newGame(this.level);
  }

  resume(): boolean {
    const d = store.get<Save>(SAVE_KEY);
    if (!d || d.state.won) return false;
    this.state = d.state;
    this.msBefore = d.ms;
    this.history = [];
    this.build();
    return true;
  }

  pause() {
    this.paused = true;
    this.cancelPress();
    this.stopClock();
    this.save();
  }

  unpause() {
    this.paused = false;
    if (this.state?.placed && !this.over()) this.startClock();
    this.emitHud();
  }

  refresh() {
    if (this.state) this.render();
  }

  undo() {
    const prev = this.history.pop();
    if (!prev) return;
    this.state = prev;
    sfx.undo();
    haptic(6);
    this.render();
    if (!this.over() && !this.paused) this.startClock();
    this.save();
    this.emitHud();
  }

  hint() {
    if (!this.state || this.over()) return;
    const i = safeCell(this.state);
    if (i === null) {
      this.hooks.toast('Nothing is certain here: time to guess');
      this.hooks.hint?.(null, 'none');
      return;
    }
    const el = this.cells[i];
    flash(el, 'hinted', 1800);
    const r = el.getBoundingClientRect();
    const b = this.root.getBoundingClientRect();
    this.hooks.hint?.({ from: (r.left + r.width / 2 - b.left) / b.width }, 'move');
  }

  previewWin() {
    sfx.win();
    this.hooks.event?.('win');
  }

  key(e: KeyboardEvent) {
    if (e.key === 'f') {
      this.setFlagMode(!this.flagMode);
      return true;
    }
    return false;
  }

  setVisible(on: boolean) {
    this.root.hidden = !on;
    if (on) this.relayout();
  }

  // ───────────────────────── play ─────────────────────────

  private over() {
    return this.state.won || this.state.lost !== null;
  }

  private snapshot() {
    this.history.push(structuredClone(this.state));
    if (this.history.length > 200) this.history.shift();
  }

  private open(i: number) {
    const s = this.state;
    const c = s.cells[i];
    if (this.over() || c.flag) return;
    if (c.open && c.n) return this.clearAround(i);
    if (c.open) return;
    this.snapshot();
    const opened = reveal(s, i);
    this.startClock();
    this.afterOpen(opened, i);
  }

  private clearAround(i: number) {
    const s = this.state;
    const before = structuredClone(s);
    const opened = chord(s, i);
    if (!opened.length) {
      flash(this.cells[i], 'nope', 400);
      return;
    }
    this.history.push(before);
    this.afterOpen(opened, i);
  }

  private afterOpen(opened: { i: number; d: number }[], from: number) {
    const s = this.state;
    // Ripple open from the tap, with a few soft ticks rather than one per cell.
    for (const o of opened) this.cells[o.i].style.setProperty('--d', `${Math.min(o.d, 14) * 28}ms`);
    const ticks = Math.min(6, Math.ceil(opened.length / 6));
    for (let k = 0; k < ticks; k++) sfx.flip(k * 0.05);
    if (s.lost !== null) return this.boom(s.lost);
    haptic(opened.length > 4 ? [6, 30, 6] : 6);
    if (opened.length > 12) this.hooks.event?.('reveal', this.fraction(from));
    this.render();
    this.save();
    this.emitHud();
    if (s.won) this.win();
  }

  private flag(i: number) {
    const s = this.state;
    if (s.cells[i].open || this.over()) return;
    this.snapshot();
    toggleFlag(s, i);
    sfx.drop();
    haptic(12);
    this.render();
    this.save();
    this.emitHud();
  }

  private boom(at: number) {
    this.stopClock();
    sfx.heartsBreak();
    sfx.queenScare();
    haptic([60, 40, 120]);
    this.hooks.event?.('scare', this.fraction(at));
    // The other mines appear one by one, spreading out from the one that went off.
    const s = this.state;
    const ax = at % s.w;
    const ay = Math.floor(at / s.w);
    s.cells.forEach((c, i) => {
      if (!c.mine || i === at) return;
      const d = Math.hypot((i % s.w) - ax, Math.floor(i / s.w) - ay);
      this.cells[i].style.setProperty('--d', `${300 + d * 45}ms`);
    });
    this.render();
    this.save();
    this.emitHud();
    window.setTimeout(
      () =>
        this.hooks.finished({
          title: 'Boom!',
          line: `Minesweeper ${LEVEL_ICON[s.level]} · Undo takes it back`,
          stats: [
            { label: '💣 left', value: String(s.cells.filter((c) => c.mine && !c.flag).length) },
            { label: 'Time', value: fmtTime(this.elapsed()) },
          ],
          celebrate: false,
        }),
      1600,
    );
  }

  private win() {
    this.stopClock();
    const ms = this.elapsed();
    sfx.win();
    haptic([20, 60, 20, 60, 40]);
    this.hooks.event?.('win');
    // Flags pop in a wave across the board.
    this.state.cells.forEach((c, i) => c.mine && this.cells[i].style.setProperty('--d', `${(i % this.state.w) * 40}ms`));
    this.render();
    const best = this.recordBest(ms);
    store.set(SAVE_KEY, null);
    window.setTimeout(
      () =>
        this.hooks.finished({
          title: 'Cleared!',
          line: `Minesweeper ${LEVEL_ICON[this.state.level]}${best ? ' · new best time!' : ''}`,
          stats: [
            { label: 'Time', value: fmtTime(ms) },
            { label: 'Best', value: fmtTime(store.get<Record<string, number>>('ninnies.mines.best')?.[this.state.level] ?? ms) },
          ],
          celebrate: true,
        }),
      1200,
    );
  }

  private recordBest(ms: number) {
    const best = store.get<Record<string, number>>('ninnies.mines.best') ?? {};
    const prev = best[this.state.level];
    if (prev !== undefined && prev <= ms) return false;
    best[this.state.level] = ms;
    store.set('ninnies.mines.best', best);
    return true;
  }

  private setFlagMode(on: boolean) {
    this.flagMode = on;
    this.modeBtn.textContent = on ? '🚩' : '⛏';
    this.modeBtn.classList.toggle('flagging', on);
    this.root.classList.toggle('flagging', on);
  }

  // ───────────────────────── clock & save ─────────────────────────

  private elapsed() {
    return this.msBefore + (this.clockStart === null ? 0 : performance.now() - this.clockStart);
  }

  private startClock() {
    if (this.clockStart === null && this.state.placed && !this.over()) this.clockStart = performance.now();
  }

  private stopClock() {
    this.msBefore = this.elapsed();
    this.clockStart = null;
  }

  private save() {
    if (this.state) store.set(SAVE_KEY, { state: this.state, ms: Math.round(this.elapsed()) } satisfies Save);
  }

  private emitHud() {
    if (!this.state) return;
    this.hooks.hud({
      stats: [
        { label: '💣', value: String(flagsLeft(this.state)) },
        { label: 'Time', value: fmtTime(this.elapsed()) },
      ],
      canUndo: this.history.length > 0,
      hasUndo: true,
    });
  }

  // ───────────────────────── input ─────────────────────────

  private cellAt(e: PointerEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.mine-cell');
    return el ? Number(el.dataset.i) : -1;
  }

  private onDown(e: PointerEvent) {
    unlockAudio();
    if (!this.state || this.over()) return;
    const i = this.cellAt(e);
    if (i < 0) return;
    e.preventDefault();
    this.cancelPress();
    // Right click (desktop) flags straight away.
    if (e.button === 2) return this.flag(i);
    const press: Press = { pointerId: e.pointerId, i, x: e.clientX, y: e.clientY, handled: false, timer: 0 };
    press.timer = window.setTimeout(() => {
      // Long-press: the opposite of the current mode.
      press.handled = true;
      if (this.flagMode) this.open(i);
      else this.flag(i);
    }, LONG_PRESS);
    this.press = press;
    this.cells[i].classList.add('pressed');
  }

  private onMove(e: PointerEvent) {
    const p = this.press;
    if (p && p.pointerId === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 12) this.cancelPress();
  }

  private onUp(e: PointerEvent) {
    const p = this.press;
    if (!p || p.pointerId !== e.pointerId) return;
    this.cancelPress();
    if (p.handled) return;
    if (this.flagMode && !this.state.cells[p.i].open) this.flag(p.i);
    else this.open(p.i);
  }

  private cancelPress() {
    if (!this.press) return;
    clearTimeout(this.press.timer);
    this.cells[this.press.i]?.classList.remove('pressed');
    this.press = null;
  }

  // ───────────────────────── layout & render ─────────────────────────

  /** One element per cell, created once per board. */
  private build() {
    const s = this.state;
    this.grid.innerHTML = '';
    this.cells = s.cells.map((_, i) => {
      const el = document.createElement('div');
      el.className = 'mine-cell';
      el.dataset.i = String(i);
      this.grid.appendChild(el);
      return el;
    });
    this.relayout();
  }

  private relayout() {
    const s = this.state;
    if (!s) return;
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (!W || !H) return;
    this.sized = `${W}x${H}`;
    const pad = 10;
    // Room for the dig/flag switch: below the board in portrait, beside it in landscape.
    const side = W > H;
    const room = 68;
    this.root.classList.toggle('side', side);
    this.root.style.padding = side ? `0 ${room}px` : `0 0 ${room}px`;
    // Turn the board to match the screen (Hard is 30×16: tall in portrait, wide in landscape).
    this.transposed = (H > W) !== (s.h > s.w) && s.w !== s.h;
    const cols = this.transposed ? s.h : s.w;
    const rows = this.transposed ? s.w : s.h;
    // Each cell also takes a gap (6%) and the frame adds 24% of a cell; see .mines-grid.
    const fit = (space: number, n: number) => space / (n * 1.06 + 0.24);
    const size = Math.floor(Math.min(fit(W - pad * 2 - (side ? room * 2 : 0), cols), fit(H - pad * 2 - (side ? 0 : room), rows), 56));
    this.grid.style.setProperty('--cell', `${size}px`);
    this.grid.style.gridTemplateColumns = `repeat(${cols}, var(--cell))`;
    this.cells.forEach((el, i) => {
      const x = i % s.w;
      const y = Math.floor(i / s.w);
      el.style.gridColumn = String((this.transposed ? y : x) + 1);
      el.style.gridRow = String((this.transposed ? x : y) + 1);
    });
    this.render();
  }

  private render() {
    const s = this.state;
    s.cells.forEach((c, i) => {
      const el = this.cells[i];
      el.classList.toggle('open', c.open);
      el.classList.toggle('flag', c.flag && !c.open);
      el.classList.toggle('boom', s.lost === i);
      // After a loss every mine shows; wrong flags are marked.
      const showMine = c.mine && (s.lost !== null || s.won);
      el.classList.toggle('mine', showMine && !c.flag);
      el.classList.toggle('wrong', s.lost !== null && c.flag && !c.mine);
      el.dataset.n = c.open && !c.mine && c.n ? String(c.n) : '';
      el.textContent = c.open && !c.mine && c.n ? String(c.n) : '';
    });
    this.root.classList.toggle('lost', s.lost !== null);
    this.root.classList.toggle('won', s.won);
    this.grid.dataset.back = settings.back;
  }

  private fraction(i: number) {
    const el = this.cells[i];
    const r = el.getBoundingClientRect();
    const b = this.root.getBoundingClientRect();
    return (r.left + r.width / 2 - b.left) / b.width;
  }
}

export { SIZES, LEVEL_ICON };
