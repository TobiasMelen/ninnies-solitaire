import { randomSeed } from '../../core/cards';
import { type GameHooks, type HudStat, INTRO_MS, store } from '../../core/game';
import { TableGame } from '../../core/tableGame';
import { type Key, t } from '../../i18n';
import { haptic, sfx, unlockAudio } from '../../ui/feedback';
import { settings } from '../../ui/settings';
import { ADVISOR, chooseMove, skillFor } from './ai';
import { PLAYER_COLOURS, VARIANTS, followerSvg, spotOf, tileSvg, turnedSpot } from './render';
import { type LandscaperState, type Move, type Part, analyse, followerSpots, leaders, newGame, placements, play } from './rules';

/** You, then the animals in the order they join. */
const PLAYERS = [
  { emoji: '🙂', key: 'you' },
  { emoji: '🦊', key: 'animal.fox' },
  { emoji: '🦉', key: 'animal.owl' },
  { emoji: '🐻', key: 'animal.bear' },
] as const;

const SAVE_KEY = 'ninnies.landscaper.save.v1';
/** Tile size on screen at zoom 1. */
const TILE = 84;

/** Your turn in two steps: where the tile goes, then whether a follower goes with it. */
type Stage = { at: 'lay'; ghost: { x: number; y: number; r: number } | null } | { at: 'follow'; x: number; y: number; r: number; pick: { part: Part; i: number } | null };

export class LandscaperGame extends TableGame<LandscaperState> {
  readonly id = 'landscaper' as const;
  readonly restartLabel = 'menu.restartGame' as const;

  private world: HTMLElement;
  private tilesEl: HTMLElement;
  private marksEl: HTMLElement;
  private popsEl: HTMLElement;
  private panel: HTMLElement;
  private view = { x: 0, y: 0, zoom: 1 };
  private stage: Stage = { at: 'lay', ghost: null };
  /** Pointers on the board, for dragging and pinching it. */
  private pointers = new Map<number, { x: number; y: number; startX: number; startY: number }>();
  private pinch: { dist: number; zoom: number } | null = null;
  private panned = false;
  private thinking = false;
  /** An opponent's chosen move, shown hovering over its spot before it's laid. */
  private aiShow: { m: Move; r: number } | null = null;
  /** Tiles already on the board, by index, so new ones can animate in. */
  private tileEls: HTMLElement[] = [];
  /** Followers shown last time (by tile index), to pop in new ones and float off scored ones. */
  private shownFollowers = new Map<number, { x: number; y: number; html: string }>();
  /** Which tile the panel last drew, so a newly drawn one flips in. */
  private drawnKey = '';
  /** Where the next tile flies in from (board pixels), when it comes from the panel. */
  private flyFrom: { x: number; y: number } | null = null;
  private followersEl!: HTMLElement;

  constructor(root: HTMLElement, hooks: GameHooks) {
    super(root, hooks, SAVE_KEY);
    root.classList.add('landscaper-root');
    this.world = this.el('ls-world');
    this.tilesEl = document.createElement('div');
    this.marksEl = document.createElement('div');
    this.popsEl = document.createElement('div');
    this.followersEl = document.createElement('div');
    this.world.append(this.tilesEl, this.followersEl, this.marksEl, this.popsEl);
    this.panel = this.el('ls-panel');
    this.panel.addEventListener('click', (e) => this.onPanel(e));
    root.addEventListener('pointerdown', (e) => this.onDown(e));
    root.addEventListener('pointermove', (e) => this.onMove(e));
    root.addEventListener('pointerup', (e) => this.onUp(e));
    root.addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
    root.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomAt(e.clientX, e.clientY, this.view.zoom * Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
  }

  static saved(): string | null {
    const s = store.get<LandscaperState>(SAVE_KEY);
    if (!s || s.over) return null;
    return t('landscaper.saved', { pts: s.scores[0], n: s.pile.length + 1 });
  }

  // ───────────────────────── controller ─────────────────────────

  newGame(opponents: number, seed = randomSeed()) {
    this.stopCascade();
    this.cancelAll();
    this.state = newGame(seed, { players: opponents + 1, farmers: settings.landscaperFarmers });
    this.stage = { at: 'lay', ghost: null };
    this.view = { x: 0, y: 0, zoom: 1 };
    this.save();
    this.render(false);
    this.hooks.event?.('start');
    this.after('next', INTRO_MS, () => this.step());
  }

  restart() {
    this.newGame(this.state.options.players - 1, this.state.seed);
  }

  again() {
    this.newGame(this.state.options.players - 1);
  }

  status() {
    return t('landscaper.saved', { pts: this.state.scores[0], n: this.state.pile.length + 1 });
  }

  key(e: KeyboardEvent) {
    if (e.key === 'r' && this.stage.at === 'lay') {
      this.rotate();
      return true;
    }
    return false;
  }

  refresh() {
    if (this.state) this.render(false);
  }

  undo() {
    // Laying a tile can't be taken back once it's done; before that, Pick up / tap elsewhere.
  }

  hint() {
    const s = this.state;
    if (!s || s.over || s.turn !== 0 || this.thinking) return;
    const m = chooseMove(s, Math.random, ADVISOR);
    this.stage = { at: 'lay', ghost: { x: m.x, y: m.y, r: m.r } };
    this.render();
    const p = this.toScreen(m.x + 0.5, m.y + 0.5);
    this.hooks.hint?.({ from: p.x / this.root.clientWidth }, 'move');
    this.hooks.toast(m.f ? t('landscaper.hintFollower', { part: t(`landscaper.part.${m.f.part}` as Key) }) : t('landscaper.hintNoFollower'));
  }

  protected isFinished(s: LandscaperState) {
    return s.over;
  }

  protected onResume() {
    this.stage = { at: 'lay', ghost: null };
    this.view = { x: 0, y: 0, zoom: 1 };
  }

  protected settle() {
    this.thinking = false;
    this.aiShow = null;
  }

  protected cascadeCards() {
    return [];
  }

  protected cardSize() {
    return { cw: 60, ch: 84 };
  }

  // ───────────────────────── flow ─────────────────────────

  private speed() {
    return settings.landscaperFast ? 450 : 1000;
  }

  protected step() {
    const s = this.state;
    if (!s || this.paused) return;
    this.emitHud();
    if (s.over) return this.finish();
    this.render();
    if (s.turn === 0) return;
    this.thinking = true;
    this.after('ai', this.speed(), () => {
      const m = chooseMove(s, Math.random, skillFor(s.seed, s.turn));
      // Out of the panel to hover over its spot, turning into place...
      this.flyFrom = this.panelSpot();
      this.aiShow = { m, r: 0 };
      this.reveal(m.x, m.y);
      this.render();
      this.after('ai-turn', 380, () => {
        if (!this.aiShow) return;
        this.aiShow.r = m.r;
        this.render();
        // ...then down it goes.
        this.after('ai-lay', 420, () => {
          this.aiShow = null;
          this.thinking = false;
          this.commit(m);
        });
      });
    });
  }

  /** The middle of the panel's tile, in board pixels: where drawn tiles fly out from. */
  private panelSpot() {
    const el = this.panel.querySelector<HTMLElement>('.ls-preview');
    const r = (el ?? this.panel).getBoundingClientRect();
    const w = this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
    return { x: w.x * TILE, y: w.y * TILE };
  }

  /** Play a move (anyone's), show what it scored, and carry on. */
  private commit(m: Move) {
    const s = this.state;
    const who = s.turn;
    play(s, m);
    if (s.scored.some((x) => !x.final)) window.setTimeout(() => sfx.complete(), 250);
    this.stage = { at: 'lay', ghost: null };
    sfx.drop();
    haptic(8);
    this.save();
    this.render();
    // Keep an opponent's tile in view.
    if (who !== 0) this.reveal(m.x, m.y);
    for (const sc of s.scored.filter((x) => !x.final)) this.popScore(sc.tiles, sc.points, sc.players);
    if (s.scored.some((x) => !x.final && x.players.includes(0))) {
      this.hooks.event?.('complete', 0.5);
    } else if (who === 0) this.hooks.event?.(m.f ? 'suit' : 'move', 0.5);
    this.after('next', s.scored.length ? 700 : 250, () => this.step());
  }

  private finish() {
    const s = this.state;
    this.render();
    for (const sc of s.scored.filter((x) => x.final)) this.popScore(sc.tiles, sc.points, sc.players);
    const best = leaders(s);
    const youWon = best.includes(0);
    if (youWon) sfx.win();
    this.hooks.event?.(youWon ? 'win' : 'stuck');
    this.clearSave();
    this.after('result', 1600, () =>
      this.hooks.finished({
        title: youWon ? t('win.won') : `${PLAYERS[best[0]].emoji} ${t('landscaper.wins', { who: t(PLAYERS[best[0]].key) })}`,
        line: t('landscaper.resultLine', { n: s.tiles.length }),
        stats: s.scores.map((n, p) => ({ label: p ? PLAYERS[p].emoji : t('you'), value: String(n) })),
        celebrate: youWon,
      }),
    );
  }

  protected emitHud() {
    const s = this.state;
    if (!s) return;
    const stats: HudStat[] = s.scores.map((n, p) => ({
      label: `${p ? PLAYERS[p].emoji : t('you')} · ${s.followers[p]}♟`,
      value: String(n),
      hot: !s.over && s.turn === p,
    }));
    this.hooks.hud({ stats, canUndo: false, hasUndo: false });
  }

  // ───────────────────────── your turn ─────────────────────────

  private legal() {
    const s = this.state;
    return s.current && !s.over && s.turn === 0 && !this.thinking ? placements(s, s.current) : [];
  }

  /** Tapped a board square: put the tile there (or turn it, if it's already there). */
  private tapCell(x: number, y: number) {
    const st = this.stage;
    if (st.at !== 'lay') return;
    const fits = this.legal().filter((p) => p.x === x && p.y === y);
    if (!fits.length) return;
    if (st.ghost && st.ghost.x === x && st.ghost.y === y) return this.rotate();
    if (!st.ghost) this.flyFrom = this.panelSpot();
    this.stage = { at: 'lay', ghost: fits[0] };
    sfx.pick();
    haptic(5);
    this.render();
  }

  /** Next turn of the tile that fits where it is. */
  private rotate() {
    const st = this.stage;
    if (st.at !== 'lay' || !st.ghost) return;
    const g = st.ghost;
    const fits = this.legal().filter((p) => p.x === g.x && p.y === g.y);
    const next = fits[(fits.findIndex((p) => p.r === g.r) + 1) % fits.length];
    this.stage = { at: 'lay', ghost: next };
    sfx.pick();
    this.render();
  }

  /** The state with your tile laid but not yet played, to see where a follower could go. */
  private laid(x: number, y: number, r: number) {
    const s = structuredClone(this.state);
    s.tiles.push({ k: s.current!, r, x, y });
    return s;
  }

  private onPanel(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!btn) return;
    unlockAudio();
    const st = this.stage;
    const act = btn.dataset.act;
    if (act === 'rotate') return this.rotate();
    if (act === 'place' && st.at === 'lay' && st.ghost) {
      const { x, y, r } = st.ghost;
      // Nothing to put a follower on (or none left): the turn is done.
      if (!followerSpots(this.laid(x, y, r)).length) return this.commit({ x, y, r });
      this.stage = { at: 'follow', x, y, r, pick: null };
      return this.render();
    }
    if (act === 'back' && st.at === 'follow') {
      this.stage = { at: 'lay', ghost: { x: st.x, y: st.y, r: st.r } };
      return this.render();
    }
    if (act === 'done' && st.at === 'follow') return this.commit({ x: st.x, y: st.y, r: st.r, f: st.pick ?? undefined });
  }

  // ───────────────────────── board: pan, pinch, tap ─────────────────────────

  private onDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('.ls-panel')) return;
    unlockAudio();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone; a tap still works without capture */
    }
    if (this.pointers.size === 1) this.panned = false;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.view.zoom };
      this.panned = true;
    }
  }

  private onMove(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.zoomAt(mid.x, mid.y, this.pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.dist));
      return;
    }
    if (!this.panned && Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < 8) return;
    this.panned = true;
    this.view.x += dx;
    this.view.y += dy;
    this.applyView();
  }

  private onUp(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!p || this.panned || this.pointers.size) return;
    // A tap: a follower spot, or a square on the board.
    const spot = (e.target as HTMLElement).closest<HTMLElement>('.ls-spot');
    const st = this.stage;
    if (spot && st.at === 'follow') {
      const pick = { part: spot.dataset.part as Part, i: Number(spot.dataset.i) };
      this.stage = { ...st, pick: st.pick && st.pick.part === pick.part && st.pick.i === pick.i ? null : pick };
      sfx.pick();
      haptic(5);
      return this.render();
    }
    const w = this.toWorld(e.clientX, e.clientY);
    this.tapCell(Math.floor(w.x), Math.floor(w.y));
  }

  private zoomAt(cx: number, cy: number, zoom: number) {
    zoom = Math.max(0.35, Math.min(2.2, zoom));
    const r = this.root.getBoundingClientRect();
    const px = cx - r.left;
    const py = cy - r.top;
    // Keep the point under the fingers where it is.
    const wx = (px - r.width / 2 - this.view.x) / this.view.zoom;
    const wy = (py - r.height / 2 - this.view.y) / this.view.zoom;
    this.view.zoom = zoom;
    this.view.x = px - r.width / 2 - wx * zoom;
    this.view.y = py - r.height / 2 - wy * zoom;
    this.applyView();
  }

  /** Board coordinates (in tiles) under a point on screen. */
  private toWorld(cx: number, cy: number) {
    const r = this.root.getBoundingClientRect();
    return {
      x: (cx - r.left - r.width / 2 - this.view.x) / (this.view.zoom * TILE),
      y: (cy - r.top - this.boardMid() - this.view.y) / (this.view.zoom * TILE),
    };
  }

  private toScreen(x: number, y: number) {
    return {
      x: this.root.clientWidth / 2 + this.view.x + x * TILE * this.view.zoom,
      y: this.boardMid() + this.view.y + y * TILE * this.view.zoom,
    };
  }

  /** The board's middle sits above the panel. */
  private boardMid() {
    return (this.root.clientHeight - this.panel.offsetHeight) / 2;
  }

  /** Pan so tile (x, y) is on screen, if it isn't. */
  private reveal(x: number, y: number) {
    const p = this.toScreen(x + 0.5, y + 0.5);
    const W = this.root.clientWidth;
    const H = this.root.clientHeight - this.panel.offsetHeight;
    const m = TILE * this.view.zoom;
    if (p.x > m && p.x < W - m && p.y > m && p.y < H - m) return;
    this.view.x += W / 2 - p.x;
    this.view.y += H / 2 - p.y;
    this.applyView();
  }

  private applyView() {
    this.world.style.transform = `translate(${this.root.clientWidth / 2 + this.view.x}px, ${this.boardMid() + this.view.y}px) scale(${this.view.zoom})`;
  }

  protected relayout() {
    if (this.state && !this.cascade) this.render(false);
  }

  // ───────────────────────── drawing ─────────────────────────

  /** Each spot on the board gets one of the tile's looks, so repeats don't look stamped. */
  private look(x: number, y: number) {
    return (((x * 7 + y * 13) % VARIANTS) + VARIANTS) % VARIANTS;
  }

  private tileEl(k: string, x: number, y: number, r: number, cls = '') {
    const el = document.createElement('div');
    el.className = `ls-tile ${cls}`;
    el.style.cssText = `left:${x * TILE}px;top:${y * TILE}px;width:${TILE}px;height:${TILE}px`;
    el.innerHTML = `<div class="ls-face" style="rotate:${r * 90}deg">${tileSvg(k, this.look(x, y), r)}</div>`;
    return el;
  }

  /** Animate a tile in: flying from the panel if it came from there, else dropping into place. */
  private arrive(el: HTMLElement, x: number, y: number) {
    if (this.flyFrom) {
      el.style.setProperty('--fx', `${this.flyFrom.x - (x + 0.5) * TILE}px`);
      el.style.setProperty('--fy', `${this.flyFrom.y - (y + 0.5) * TILE}px`);
      el.classList.add('fly');
      this.flyFrom = null;
    } else {
      el.classList.add('drop');
    }
  }

  protected render(animate = true) {
    const s = this.state;
    if (!s) return;
    const st = this.stage;

    // Tiles: a new game (or a resumed one) starts over; otherwise only new tiles are added.
    if (this.tileEls.length > s.tiles.length || !animate) {
      this.tilesEl.innerHTML = '';
      this.tileEls = [];
      this.shownFollowers.clear();
    }
    for (let i = this.tileEls.length; i < s.tiles.length; i++) {
      const tile = s.tiles[i];
      const el = this.tileEl(tile.k, tile.x, tile.y, tile.r);
      if (animate && i > 0) this.arrive(el, tile.x, tile.y);
      this.tilesEl.appendChild(el);
      this.tileEls.push(el);
    }
    this.tileEls.forEach((el, i) => el.classList.toggle('latest', i === s.tiles.length - 1 && i > 0));

    // Followers: new ones pop in; ones that scored float away.
    const now = new Map<number, { x: number; y: number; html: string }>();
    s.tiles.forEach((tile, i) => {
      if (!tile.f) return;
      const [fx, fy] = turnedSpot(spotOf(tile.k, tile.f.part, tile.f.i), tile.r);
      now.set(i, { x: tile.x * TILE + (fx / 100) * TILE, y: tile.y * TILE + (fy / 100) * TILE, html: followerSvg(tile.f.p, tile.f.part) });
    });
    this.followersEl.innerHTML = [...now]
      .map(([i, f]) => `<div class="ls-follower${animate && !this.shownFollowers.has(i) ? ' pop' : ''}" style="left:${f.x}px;top:${f.y}px">${f.html}</div>`)
      .join('');
    if (animate) {
      for (const [i, f] of this.shownFollowers) {
        if (now.has(i)) continue;
        const el = document.createElement('div');
        el.className = 'ls-follower leave';
        el.style.cssText = `left:${f.x}px;top:${f.y}px`;
        el.innerHTML = f.html;
        this.popsEl.appendChild(el);
        window.setTimeout(() => el.remove(), 900);
      }
    }
    this.shownFollowers = now;

    // Marks: where your tile fits, your tile hovering, follower spots, an opponent's tile.
    this.marksEl.innerHTML = '';
    const mark = (el: HTMLElement) => this.marksEl.appendChild(el);
    const myTurn = s.turn === 0 && !s.over && !this.thinking && !!s.current;
    if (myTurn && st.at === 'lay') {
      const cells = new Map<string, { x: number; y: number }>();
      for (const p of this.legal()) cells.set(`${p.x},${p.y}`, p);
      for (const c of cells.values()) {
        const el = document.createElement('div');
        el.className = 'ls-open';
        el.style.cssText = `left:${c.x * TILE}px;top:${c.y * TILE}px;width:${TILE}px;height:${TILE}px`;
        mark(el);
      }
      if (st.ghost) {
        // The same element while it stays on one square, so turning it animates.
        const at = `${st.ghost.x},${st.ghost.y}`;
        let g = this.ghostEl;
        if (g && g.dataset.at === at) g.querySelector<HTMLElement>('.ls-face')!.style.rotate = `${st.ghost.r * 90}deg`;
        else {
          g = this.tileEl(s.current!, st.ghost.x, st.ghost.y, st.ghost.r, 'ghost');
          g.dataset.at = at;
          if (this.flyFrom) this.arrive(g, st.ghost.x, st.ghost.y);
          this.ghostEl = g;
        }
        mark(g);
      } else this.ghostEl = null;
    }
    if (myTurn && st.at === 'follow') {
      mark(this.tileEl(s.current!, st.x, st.y, st.r, 'ghost placed'));
      const laid = this.laid(st.x, st.y, st.r);
      for (const sp of followerSpots(laid, analyse(laid))) {
        const [fx, fy] = turnedSpot(spotOf(s.current!, sp.part, sp.i), st.r);
        const on = st.pick?.part === sp.part && st.pick.i === sp.i;
        const el = document.createElement('div');
        el.className = `ls-spot${on ? ' on' : ''}`;
        el.dataset.part = sp.part;
        el.dataset.i = String(sp.i);
        el.style.cssText = `left:${st.x * TILE + (fx / 100) * TILE}px;top:${st.y * TILE + (fy / 100) * TILE}px`;
        el.innerHTML = on ? followerSvg(0, sp.part) : '';
        mark(el);
      }
    }
    if (this.aiShow && s.current) {
      const { m, r } = this.aiShow;
      const el = this.tileEl(s.current, m.x, m.y, r, 'ghost hover');
      if (this.flyFrom) this.arrive(el, m.x, m.y);
      // Keep the element between steps so the turn animates.
      const prev = this.hoverEl;
      if (prev && prev.dataset.at === `${m.x},${m.y}`) {
        prev.querySelector<HTMLElement>('.ls-face')!.style.rotate = `${r * 90}deg`;
        mark(prev);
      } else {
        el.dataset.at = `${m.x},${m.y}`;
        this.hoverEl = el;
        mark(el);
      }
    } else {
      this.hoverEl = null;
    }
    this.renderPanel();
    this.applyView();
  }

  private hoverEl: HTMLElement | null = null;
  private ghostEl: HTMLElement | null = null;

  private renderPanel() {
    const s = this.state;
    const st = this.stage;
    const left = t('landscaper.tilesLeft', { n: s.pile.length + (s.current ? 1 : 0) });
    const key = `${s.tiles.length}:${s.current}`;
    const fresh = key !== this.drawnKey;
    this.drawnKey = key;
    const shown = this.aiShow ? null : s.current;
    const turned = (st.at === 'lay' ? (st.ghost?.r ?? 0) : st.r) * (s.turn === 0 ? 1 : 0);
    const pile = `<div class="ls-pile" aria-hidden="true">${'<i></i>'.repeat(Math.min(4, Math.ceil(s.pile.length / 18)))}</div>`;
    const preview = `${pile}<div class="ls-preview${shown ? '' : ' empty'}${fresh ? ' draw' : ''}" style="rotate:${turned * 90}deg">${shown ? tileSvg(shown) : ''}</div>`;
    let body = '';
    if (s.over) body = `<p>${t('landscaper.gameOver')}</p>`;
    else if (s.turn !== 0) body = `<p>${t('landscaper.thinking', { who: PLAYERS[s.turn].emoji })}</p>`;
    else if (st.at === 'lay')
      body = `<p>${st.ghost ? t('landscaper.turnOrPlace') : t('landscaper.pickSpot')}</p>
        <div class="ls-actions"><button type="button" class="btn" data-act="rotate" ${st.ghost ? '' : 'disabled'}>↻ ${t('landscaper.rotate')}</button>
        <button type="button" class="btn primary" data-act="place" ${st.ghost ? '' : 'disabled'}>${t('landscaper.place')}</button></div>`;
    else
      body = `<p>${s.followers[0] ? t('landscaper.pickFollower') : t('landscaper.noFollowers')}</p>
        <div class="ls-actions"><button type="button" class="btn" data-act="back">${t('landscaper.back')}</button>
        <button type="button" class="btn primary" data-act="done">${st.pick ? t('landscaper.done') : t('landscaper.skip')}</button></div>`;
    this.panel.innerHTML = `${preview}<div class="ls-info"><small>${left}</small>${body}</div>`;
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (W && H) this.hooks.occupied?.([{ x0: this.panel.offsetLeft / W - 0.5 * (this.panel.offsetWidth / W), x1: (this.panel.offsetLeft + this.panel.offsetWidth / 2) / W, y: 1 }]);
    this.panel.style.setProperty('--you', PLAYER_COLOURS[0]);
  }

  /** "+N" over a scored feature, in the colours of whoever scored. */
  private popScore(tiles: number[], points: number, players: number[]) {
    if (!points || !players.length) return;
    const s = this.state;
    const cx = tiles.reduce((n, i) => n + s.tiles[i].x, 0) / tiles.length + 0.5;
    const cy = tiles.reduce((n, i) => n + s.tiles[i].y, 0) / tiles.length + 0.5;
    const el = document.createElement('div');
    el.className = 'ls-pop';
    el.style.left = `${cx * TILE}px`;
    el.style.top = `${cy * TILE}px`;
    el.innerHTML = players.map((p) => `<b style="background:${PLAYER_COLOURS[p]}">+${points}</b>`).join('');
    this.popsEl.appendChild(el);
    window.setTimeout(() => el.remove(), 1800);
  }

  private el(cls: string) {
    const e = document.createElement('div');
    e.className = cls;
    this.root.appendChild(e);
    return e;
  }
}
