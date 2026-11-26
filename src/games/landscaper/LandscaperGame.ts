import { randomSeed } from '../../core/cards';
import { type GameHooks, type HudStat, store } from '../../core/game';
import { TableGame } from '../../core/tableGame';
import { type Key, t } from '../../i18n';
import { haptic, sfx, unlockAudio } from '../../ui/feedback';
import { settings, updateSettings } from '../../ui/settings';
import { ADVISOR, LEVELS, STYLES, type Seat, type Style, seatOf, skillOf, styleOf } from './ai';
import { think } from './think';
import { KIND } from './tiles';
import { PLAYER_COLOURS, followerSvg, paintTile, spotOf, tileSvg, turnedSpot } from './render';
import { type LandscaperState, type Move, type Part, analyse, followerSpots, leaders, owners, newGame, placements, play } from './rules';

/** The tile in hand on the board: where, which way, and whether it's an opponent's (hover). */
interface Lift {
  k: string;
  x: number;
  y: number;
  r: number;
  hover: boolean;
  placed: boolean;
}

/** Degrees to show turn `r` at, going on clockwise from `deg` (so 270° → 360°, not back to 0°). */
const clockwise = (deg: number, r: number) => deg + ((((r * 90 - deg) % 360) + 360) % 360);

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Each opponent shows as the emoji of its playstyle (players' colours tell two alike apart). */
const STYLE_EMOJI: Record<Style['id'], string> = { builder: '🧱', saboteur: '😈', longGame: '🌾', opportunist: '💰' };

const SAVE_KEY = 'ninnies.landscaper.save.v1';
/** Tile size on screen at zoom 1. */
const TILE = 84;
/** How long the board takes to glide to a tile that's off screen (as .ls-world.gliding). */
const GLIDE = 450;
/** Laid tiles are kept as bitmaps this many pixels square: sharp when zoomed in a fair way. */
const BITMAP = Math.round(TILE * 2 * Math.min(window.devicePixelRatio || 1, 2.5));

/** Your turn in two steps: where the tile goes, then whether a follower goes with it. */
type Stage = { at: 'lay'; ghost: { x: number; y: number; r: number } | null } | { at: 'follow'; x: number; y: number; r: number; pick: { part: Part; i: number; big?: boolean } | null };

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
  /** Each laid tile's wash of claimed colour, as last drawn. */
  private tints: string[] = [];
  /** Followers shown last time (by tile index), to pop in new ones and float off scored ones. */
  private shownFollowers = new Map<number, { x: number; y: number; html: string; big?: boolean }>();
  /** Which tile the panel last drew, so a newly drawn one flips in. */
  private drawnKey = '';
  /** Where the next tile flies in from (board pixels), when it comes from the panel. */
  private flyFrom: { x: number; y: number } | null = null;
  private followersEl!: HTMLElement;
  private liftEl!: HTMLElement;

  constructor(root: HTMLElement, hooks: GameHooks) {
    super(root, hooks, SAVE_KEY);
    root.classList.add('landscaper-root');
    this.world = this.el('ls-world');
    this.tilesEl = document.createElement('div');
    this.marksEl = document.createElement('div');
    this.popsEl = document.createElement('div');
    this.followersEl = document.createElement('div');
    this.liftEl = document.createElement('div');
    this.world.append(this.tilesEl, this.followersEl, this.marksEl, this.liftEl, this.popsEl);
    this.panel = this.el('ls-panel');
    this.panel.innerHTML = `<div class="ls-tray"><div class="ls-pile" aria-hidden="true"></div><div class="ls-preview"><div class="ls-card"><div class="ls-card-front"></div><div class="ls-card-back"></div></div></div><span class="ls-left"></span></div><div class="ls-info"></div>`;
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

  /** A new game; opponents as given, else as last time (or two picked at random). */
  newGame(lineup?: Seat[], seed = randomSeed()) {
    this.stopCascade();
    this.cancelAll();
    const seats = lineup ?? (settings.landscaperLineup as Seat[] | null) ?? this.addSeat(this.addSeat([]));
    this.state = this.fresh(seed, seats);
    this.stage = { at: 'lay', ghost: null };
    this.view = { x: 0, y: 0, zoom: 1 };
    this.save();
    this.render(false);
    this.hooks.event?.('start');
    this.showLineup();
  }

  /** One more opponent, playing a style nobody else at the table does, at a random level. */
  private addSeat(seats: Seat[]): Seat[] {
    const free = STYLES.filter((x) => !seats.some((st) => st.style === x.id));
    const pick = free[Math.floor(Math.random() * free.length)] ?? STYLES[0];
    return [...seats, { style: pick.id, level: Math.floor(Math.random() * LEVELS.length) }];
  }

  private fresh(seed: number, lineup: Seat[]) {
    return newGame(seed, { players: lineup.length + 1, farmers: settings.landscaperFarmers, river: settings.landscaperRiver, inns: settings.landscaperInns, bigBoy: settings.landscaperBigBoy, lineup });
  }

  /**
   * A new game opens on who's playing: you, then each opponent, whose playstyle and level you can
   * change (tap them) and who you can add or send away, before the first tile is laid.
   */
  private lineup: HTMLElement | null = null;
  private showLineup() {
    this.lineup?.remove();
    const el = this.el('ls-lineup');
    this.lineup = el;
    this.drawLineup(true);
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!b) return;
      const seats = [...(this.state.options.lineup as Seat[])];
      const p = Number(b.dataset.seat) - 1;
      const act = b.dataset.act;
      if (act === 'go') return this.closeLineup();
      if (act === 'style') seats[p] = { ...seats[p], style: STYLES[(STYLES.findIndex((x) => x.id === seats[p].style) + 1) % STYLES.length].id };
      if (act === 'level') seats[p] = { ...seats[p], level: (seats[p].level + 1) % LEVELS.length };
      if (act === 'remove' && seats.length > 1) seats.splice(p, 1);
      if (act === 'add' && seats.length < 3) seats.splice(0, seats.length, ...this.addSeat(seats));
      sfx.ui();
      this.state = this.fresh(this.state.seed, seats);
      this.save();
      this.render(false);
      this.drawLineup(false);
    });
  }

  private drawLineup(first: boolean) {
    const el = this.lineup;
    if (!el) return;
    const s = this.state;
    const n = s.scores.length;
    const row = (p: number) => {
      const pawn = `<span class="ls-lineup-pawn">${followerSvg(p, 'city')}</span>`;
      if (!p) return `<li style="--i:0">${pawn}<span class="ls-lineup-who"><b>🙂 ${t('you')}</b><small>${t('landscaper.youFirst')}</small></span></li>`;
      const seat = seatOf(s, p);
      const level = t((['level.easy', 'level.medium', 'level.hard'] as const)[seat.level]);
      return `<li style="--i:${p}">${pawn}<button type="button" class="ls-lineup-who" data-act="style" data-seat="${p}"><b>${this.icon(p)} ${capital(t(`landscaper.style.${seat.style}` as Key))}</b><small>${t(`landscaper.about.${seat.style}` as Key)}</small></button>
        <button type="button" class="ls-lineup-level" data-act="level" data-seat="${p}">${level}</button>${n > 2 ? `<button type="button" class="ls-lineup-remove" data-act="remove" data-seat="${p}" aria-label="${t('landscaper.removeOpponent')}">×</button>` : ''}</li>`;
    };
    el.classList.toggle('still', !first);
    el.innerHTML = `<div class="ls-lineup-card"><h2>${t('landscaper.lineup')}</h2><ol>${s.scores.map((_, p) => row(p)).join('')}</ol>
      ${n < 4 ? `<button type="button" class="ls-lineup-add" data-act="add" style="--i:${n}">+ ${t('landscaper.addOpponent')}</button>` : ''}
      <p class="ls-lineup-tip" style="--i:${n}">${t('landscaper.lineupTip')}</p>
      <button type="button" class="btn primary" data-act="go" style="--i:${n + 1}">${t('landscaper.lineupGo')}</button></div>`;
  }

  /** Off we go: remember these opponents for next time, then your first tile. */
  private closeLineup() {
    const el = this.lineup;
    if (!el) return;
    this.lineup = null;
    el.classList.remove('still');
    updateSettings({ landscaperLineup: this.state.options.lineup ?? null });
    // Draw your first tile properly, now that the table's yours.
    this.drawnKey = '';
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    this.after('next', 300, () => this.step());
  }

  restart() {
    this.newGame(this.state.options.lineup as Seat[] | undefined, this.state.seed);
  }

  again() {
    this.newGame(this.state.options.lineup as Seat[] | undefined);
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
    const at = s.tiles.length;
    think(s, ADVISOR).then((m) => {
      if (this.state === s && s.tiles.length === at && s.turn === 0 && !this.paused) this.showHint(m);
    });
  }

  private showHint(m: Move) {
    // Off screen? Glide over to it first, so you see the bunny's tile land.
    const s = this.state;
    const at = s.tiles.length;
    if (this.reveal(m.x, m.y)) return this.after('hint', GLIDE, () => this.state === s && s.tiles.length === at && this.stage.at === 'lay' && this.showHint(m));
    this.stage = { at: 'lay', ghost: { x: m.x, y: m.y, r: m.r } };
    this.render();
    const p = this.toScreen(m.x + 0.5, m.y + 0.5);
    this.hooks.hint?.({ from: p.x / this.root.clientWidth }, 'move');
    this.hooks.toast(m.f ? t(m.f.big ? 'landscaper.hintBigBoy' : 'landscaper.hintFollower', { part: t(`landscaper.part.${m.f.part}` as Key) }) : t('landscaper.hintNoFollower'));
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
    if (this.counting) {
      this.counting = null;
      this.countingWho = null;
      this.countingPart = null;
    }
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
    // Thinking starts straight away, in a worker; the move shows once the usual pause is up.
    const started = performance.now();
    const ticket = ++this.ticket;
    think(s, skillOf(s, s.turn), styleOf(s, s.turn)).then((m) => {
      if (ticket !== this.ticket || this.state !== s || this.paused) return;
      this.after('ai', Math.max(0, this.speed() - (performance.now() - started)), () => this.showAiMove(m));
    });
  }

  /** Which think is current: a newer one (or a new game) makes older answers stale. */
  private ticket = 0;

  private showAiMove(m: Move) {
    // Off screen? Glide over to its spot first, so you see the tile come in.
    if (this.reveal(m.x, m.y)) return this.after('ai-glide', GLIDE, () => this.showAiMove(m));
    // Out of the panel to hover over its spot, turning into place...
    this.flyFrom = this.panelSpot();
    this.aiShow = { m, r: 0 };
    this.render();
    this.after('ai-turn', 820, () => {
      if (!this.aiShow) return;
      this.aiShow.r = m.r;
      this.render();
      // ...then down it goes.
      this.after('ai-lay', 620, () => {
        this.aiShow = null;
        this.thinking = false;
        this.commit(m);
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
    this.after('next', s.scored.length ? 1000 : 450, () => this.step());
  }

  /** Scores shown while the final scoring counts up (null otherwise). */
  private counting: number[] | null = null;
  /** Whose tally it is, and the kind of feature being added up, for the panel. */
  private countingWho: number | null = null;
  private countingPart: Part | null = null;

  /**
   * The end of the game, as a final tally: "No more tiles!", then player by player, each one's
   * unfinished roads, cities, cloisters and fields light up in turn and add to their score.
   */
  private finish() {
    const s = this.state;
    this.clearSave();
    const order: Part[] = ['road', 'city', 'cloister', 'field'];
    const finals = s.scored.filter((x) => x.final);
    this.counting = [...s.scores];
    for (const sc of finals) for (const p of sc.players) this.counting[p] -= sc.points;
    this.countingWho = null;
    this.countingPart = null;
    this.render();
    this.emitHud();
    this.banner(t('landscaper.finalTally'));
    sfx.flip();

    const steps: { p: number; sc?: (typeof finals)[number] }[] = [];
    s.scores.forEach((_, p) => {
      steps.push({ p });
      for (const part of order) for (const sc of finals) if (sc.part === part && sc.players.includes(p)) steps.push({ p, sc });
    });
    let i = 0;
    const next = () => {
      const step = steps[i++];
      if (!step) return this.endCount();
      const { p, sc } = step;
      if (!sc) {
        // A new player's turn at the tally.
        this.countingWho = p;
        this.countingPart = null;
        this.tileEls.forEach((el) => el.classList.remove('counting'));
        this.banner(this.name(p));
        sfx.ui();
        this.renderPanel();
        this.emitHud();
        const nothing = !steps[i] || steps[i].p !== p;
        if (nothing) this.hooks.toast(t('landscaper.tallyNothing', { who: this.name(p) }));
        return this.after('count', nothing ? 1700 : 1400, next);
      }
      const fresh = sc.part !== this.countingPart;
      this.countingPart = sc.part;
      this.tileEls.forEach((el, k) => el.classList.toggle('counting', sc.tiles.includes(k)));
      const mid = sc.tiles.reduce((m, k) => ({ x: m.x + s.tiles[k].x / sc.tiles.length, y: m.y + s.tiles[k].y / sc.tiles.length }), { x: 0, y: 0 });
      this.reveal(Math.round(mid.x), Math.round(mid.y));
      this.popScore(sc.tiles, sc.points, [p]);
      this.counting![p] += sc.points;
      sfx.move(1);
      if (fresh) this.renderPanel();
      this.emitHud();
      // A beat longer when moving on to the next kind of feature or the next player.
      const later = steps[i];
      this.after('count', !later || later.p !== p ? 1500 : later.sc?.part !== sc.part ? 1300 : 950, next);
    };
    this.after('count', 2000, next);
  }

  /** A player by name for the tally: "🙂 You" or e.g. "🧱 the Builder". */
  private name(p: number) {
    return p ? this.who(p) : `🙂 ${t('you')}`;
  }

  /** A big word or two across the middle of the board for a moment. */
  private banner(text: string) {
    this.root.querySelector('.ls-banner')?.remove();
    const el = this.el('ls-banner');
    el.innerHTML = `<span></span>`;
    el.firstElementChild!.textContent = text;
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }

  private endCount() {
    this.cancel('count');
    this.counting = null;
    this.countingWho = null;
    this.countingPart = null;
    this.root.querySelector('.ls-banner')?.remove();
    this.tileEls.forEach((el) => el.classList.remove('counting'));
    this.render();
    this.emitHud();
    this.showResult();
  }

  private showResult() {
    const s = this.state;
    const best = leaders(s);
    const youWon = best.includes(0);
    if (youWon) sfx.win();
    this.hooks.event?.(youWon ? 'win' : 'stuck');
    this.after('result', 900, () =>
      this.hooks.finished({
        title: youWon ? t('win.won') : t('landscaper.wins', { who: this.who(best[0]) }),
        line: t('landscaper.resultLine', { n: s.tiles.length }),
        stats: s.scores.map((n, p) => ({ label: p ? this.icon(p) : t('you'), value: String(n) })),
        celebrate: youWon,
      }),
    );
  }

  /** An opponent's icon: its playstyle's emoji. */
  private icon(p: number) {
    return STYLE_EMOJI[seatOf(this.state, p).style];
  }

  /** An opponent by name: icon and playstyle, e.g. "🧱 the Builder". */
  private who(p: number) {
    return `${this.icon(p)} ${t(`landscaper.style.${seatOf(this.state, p).style}` as Key)}`;
  }

  protected emitHud() {
    const s = this.state;
    if (!s) return;
    // Above each score, that player's followers left, in their colour (and the big boy, if in hand).
    const men = (p: number) =>
      `<span class="ls-men"><span class="ls-man">${followerSvg(p, 'city')}</span>×${s.followers[p]}${s.big?.[p] ? `<span class="ls-man big" title="${t('landscaper.bigBoy')}">${followerSvg(p, 'city', true)}</span>` : ''}</span>`;
    const stats: HudStat[] = (this.counting ?? s.scores).map((n, p) => ({
      top: men(p),
      label: p ? this.icon(p) : t('you'),
      value: String(n),
      hot: this.counting ? this.countingWho === p : !s.over && s.turn === p,
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
    if (act === 'skip' && this.counting) return this.endCount();
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
    if (act === 'big' && st.at === 'follow' && st.pick) {
      if (this.state.followers[0] <= 0) return;
      this.stage = { ...st, pick: { ...st.pick, big: !st.pick.big } };
      sfx.pick();
      return this.render();
    }
    if (act === 'done' && st.at === 'follow') return this.commit({ x: st.x, y: st.y, r: st.r, f: st.pick ?? undefined });
  }

  // ───────────────────────── board: pan, pinch, tap ─────────────────────────

  private onDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('.ls-panel')) return;
    unlockAudio();
    this.world.classList.remove('gliding');
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
    // The board holds the pointer while it's down, so look at what's under the finger instead.
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const spot = under?.closest<HTMLElement>('.ls-spot') ?? (e.target as HTMLElement).closest<HTMLElement>('.ls-spot');
    const st = this.stage;
    if (spot && st.at === 'follow') {
      // With no ordinary followers left, it can only be the big boy.
      const pick = { part: spot.dataset.part as Part, i: Number(spot.dataset.i), big: this.state.followers[0] <= 0 };
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

  /** Pan so tile (x, y) is on screen, if it isn't, gliding there so you see where. Says whether it moved. */
  private reveal(x: number, y: number) {
    const p = this.toScreen(x + 0.5, y + 0.5);
    const W = this.root.clientWidth;
    const H = this.root.clientHeight - this.panel.offsetHeight;
    const m = TILE * this.view.zoom;
    if (p.x > m && p.x < W - m && p.y > m && p.y < H - m) return false;
    this.view.x += W / 2 - p.x;
    this.view.y += H / 2 - p.y;
    this.world.classList.add('gliding');
    this.applyView();
    window.clearTimeout(this.glideTimer);
    this.glideTimer = window.setTimeout(() => this.world.classList.remove('gliding'), GLIDE);
    return true;
  }
  private glideTimer = 0;

  private applyView() {
    this.world.style.transform = `translate(${this.root.clientWidth / 2 + this.view.x}px, ${this.boardMid() + this.view.y}px) scale(${this.view.zoom})`;
  }

  protected relayout() {
    if (this.state && !this.cascade) this.render(false);
  }

  // ───────────────────────── drawing ─────────────────────────

  /**
   * Like a real box of tiles, every copy of a kind has its own fixed look: the first one laid is
   * copy 0, the next copy 1, and so on. `upTo` is how many tiles to count (the tile in hand: all).
   */
  private look(k: string, upTo = this.state.tiles.length) {
    let n = 0;
    for (let i = 0; i < upTo; i++) if (this.state.tiles[i].k === k) n++;
    return n;
  }

  private tileEl(k: string, x: number, y: number, r: number, look: number, cls = '') {
    const el = document.createElement('div');
    el.className = `ls-tile ${cls}`;
    el.style.cssText = `left:${x * TILE}px;top:${y * TILE}px;width:${TILE}px;height:${TILE}px`;
    // The tile in hand turns, so its art stays live; laid tiles are plain images, cheap to paint.
    const art = cls.includes('ghost') ? tileSvg(k, look) : '<img alt="" decoding="sync" draggable="false">';
    el.innerHTML = `<div class="ls-face" style="rotate:${r * 90}deg;--deg:${r * 90}">${art}</div>`;
    const img = el.querySelector('img');
    if (img) paintTile(img, BITMAP, k, look, r);
    return el;
  }

  /** Wash claimed cities, roads and fields faintly in their holders' colours. */
  private tintClaims() {
    const s = this.state;
    const a = analyse(s);
    const parts = ['city', 'road', 'field'] as const;
    s.tiles.forEach((tile, t) => {
      const k = KIND[tile.k];
      const tint = !settings.landscaperClaims
        ? ''
        : parts
            .flatMap((part) =>
              k[part === 'city' ? 'cities' : part === 'road' ? 'roads' : 'fields'].map((_, i) => {
                const f = a.features[a.of.get(`${t}:${part}:${i}`) ?? -1];
                const who = f ? owners(f, s.options.players) : [];
                return who.length ? `${part}${i}=${who.map((p) => PLAYER_COLOURS[p]).join('+')}` : '';
              }),
            )
            .filter(Boolean)
            .join(';');
      if (tint === (this.tints[t] ?? '')) return;
      this.tints[t] = tint;
      const img = this.tileEls[t]?.querySelector('img');
      if (img) paintTile(img, BITMAP, tile.k, this.look(tile.k, t), tile.r, tint);
    });
  }

  /** Animate a tile in: flying from the panel if it came from there, else dropping into place. */
  private arrive(el: HTMLElement, x: number, y: number) {
    el.addEventListener('animationend', () => el.classList.remove('fly', 'drop'), { once: true });
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
      this.tints = [];
      this.shownFollowers.clear();
    }
    for (let i = this.tileEls.length; i < s.tiles.length; i++) {
      const tile = s.tiles[i];
      const el = this.tileEl(tile.k, tile.x, tile.y, tile.r, this.look(tile.k, i));
      if (animate && i > 0) this.arrive(el, tile.x, tile.y);
      this.tilesEl.appendChild(el);
      this.tileEls.push(el);
    }
    this.tileEls.forEach((el, i) => el.classList.toggle('latest', i === s.tiles.length - 1 && i > 0));
    this.tintClaims();

    // Followers: new ones pop in; ones that scored float away.
    const now = new Map<number, { x: number; y: number; html: string; big?: boolean }>();
    s.tiles.forEach((tile, i) => {
      if (!tile.f) return;
      const [fx, fy] = turnedSpot(spotOf(tile.k, tile.f.part, tile.f.i), tile.r);
      now.set(i, { x: tile.x * TILE + (fx / 100) * TILE, y: tile.y * TILE + (fy / 100) * TILE, html: followerSvg(tile.f.p, tile.f.part, tile.f.big), big: !!tile.f.big });
    });
    this.followersEl.innerHTML = [...now]
      .map(([i, f]) => `<div class="ls-follower${f.big ? ' big' : ''}${animate && !this.shownFollowers.has(i) ? ' pop' : ''}" style="left:${f.x}px;top:${f.y}px">${f.html}</div>`)
      .join('');
    if (animate) {
      for (const [i, f] of this.shownFollowers) {
        if (now.has(i)) continue;
        const el = document.createElement('div');
        el.className = 'ls-follower leave';
        el.style.cssText = `left:${f.x}px;top:${f.y}px`;
        el.innerHTML = f.html;
        this.popsEl.appendChild(el);
        window.setTimeout(() => el.remove(), 1200);
      }
    }
    this.shownFollowers = now;

    // Marks (redrawn each time): where your tile fits, and where a follower could go.
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
    }
    if (myTurn && st.at === 'follow') {
      const laid = this.laid(st.x, st.y, st.r);
      for (const sp of followerSpots(laid, analyse(laid))) {
        const [fx, fy] = turnedSpot(spotOf(s.current!, sp.part, sp.i), st.r);
        const on = st.pick?.part === sp.part && st.pick.i === sp.i;
        const el = document.createElement('div');
        el.className = `ls-spot${on ? ' on' : ''}`;
        el.dataset.part = sp.part;
        el.dataset.i = String(sp.i);
        el.style.cssText = `left:${st.x * TILE + (fx / 100) * TILE}px;top:${st.y * TILE + (fy / 100) * TILE}px`;
        el.innerHTML = on ? followerSvg(0, sp.part, st.pick?.big) : '';
        el.classList.toggle('big', on && !!st.pick?.big);
        mark(el);
      }
    }

    // The tile in hand (yours, or an opponent's about to go down).
    let lift: Lift | null = null;
    if (myTurn && st.at === 'lay' && st.ghost) lift = { k: s.current!, ...st.ghost, hover: false, placed: false };
    if (myTurn && st.at === 'follow') lift = { k: s.current!, x: st.x, y: st.y, r: st.r, hover: false, placed: true };
    if (this.aiShow && s.current) lift = { k: s.current, x: this.aiShow.m.x, y: this.aiShow.m.y, r: this.aiShow.r, hover: true, placed: false };
    this.syncLift(lift);
    this.renderPanel();
    this.applyView();
  }

  /**
   * The tile in hand is one element kept between redraws, so it flies in once, then turns and
   * settles smoothly instead of starting its animation over.
   */
  private lift: { el: HTMLElement; at: string; deg: number } | null = null;
  private syncLift(want: Lift | null) {
    if (!want) {
      this.lift?.el.remove();
      this.lift = null;
      return;
    }
    const at = `${want.k}@${want.x},${want.y}`;
    if (!this.lift || this.lift.at !== at) {
      this.lift?.el.remove();
      const el = this.tileEl(want.k, want.x, want.y, want.r, this.look(want.k), 'ghost');
      if (this.flyFrom) this.arrive(el, want.x, want.y);
      this.liftEl.appendChild(el);
      this.lift = { el, at, deg: want.r * 90 };
    } else {
      this.lift.deg = clockwise(this.lift.deg, want.r);
      const face = this.lift.el.querySelector<HTMLElement>('.ls-face')!;
      face.style.rotate = `${this.lift.deg}deg`;
      face.style.setProperty('--deg', String(this.lift.deg));
    }
    this.lift.el.classList.toggle('hover', want.hover);
    this.lift.el.classList.toggle('placed', want.placed);
  }

  private trayDeg = 0;

  /**
   * Your new tile: off the pile, up to the middle of the screen and turned face up for a moment
   * in the spotlight, then down into your tray.
   */
  private pullTile(id: string) {
    const preview = this.panel.querySelector<HTMLElement>('.ls-preview')!;
    const pile = this.panel.querySelector<HTMLElement>('.ls-pile')!.getBoundingClientRect();
    const to = preview.getBoundingClientRect();
    const box = this.root.getBoundingClientRect();
    this.root.querySelector('.ls-pull')?.remove();
    const el = this.el('ls-pull');
    el.style.cssText = `left:${to.left - box.left}px;top:${to.top - box.top}px;width:${to.width}px;height:${to.height}px`;
    // A bitmap, not live SVG: it's scaled up big and shadowed all the way, which SVG makes heavy.
    el.innerHTML = `<div class="ls-card"><div class="ls-card-front"><img alt="" decoding="sync" draggable="false"></div><div class="ls-card-back"></div></div>`;
    paintTile(el.querySelector('img')!, BITMAP, id, this.look(id), 0);
    const from = { x: pile.left + pile.width / 2 - (to.left + to.width / 2), y: pile.top + pile.height / 2 - (to.top + to.height / 2) };
    const mid = { x: box.left + box.width / 2 - (to.left + to.width / 2), y: box.top + box.height * 0.42 - (to.top + to.height / 2) };
    const big = Math.min(2.8, (box.width * 0.42) / to.width);
    const ms = 1700;
    preview.style.visibility = 'hidden';
    el.animate(
      [
        { transform: `translate(${from.x}px, ${from.y}px) scale(0.7)`, easing: 'cubic-bezier(0.25, 0.9, 0.35, 1)' },
        { transform: `translate(${mid.x}px, ${mid.y}px) scale(${big})`, offset: 0.3, easing: 'ease-in-out' },
        { transform: `translate(${mid.x}px, ${mid.y - 6}px) scale(${big * 1.03})`, offset: 0.72, easing: 'cubic-bezier(0.5, 0, 0.3, 1)' },
        { transform: 'none' },
      ],
      { duration: ms },
    ).onfinish = () => {
      el.remove();
      preview.style.visibility = '';
    };
    el.firstElementChild!.animate(
      [{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(180deg)', offset: 0.22, easing: 'ease-in-out' }, { transform: 'rotateY(0deg)', offset: 0.46 }, { transform: 'rotateY(0deg)' }],
      { duration: ms },
    );
    sfx.flip(0.36);
    window.setTimeout(() => sfx.drop(), ms - 80);
  }

  private renderPanel() {
    const s = this.state;
    const st = this.stage;
    const pile = this.panel.querySelector<HTMLElement>('.ls-pile')!;
    const preview = this.panel.querySelector<HTMLElement>('.ls-preview')!;
    const card = preview.querySelector<HTMLElement>('.ls-card')!;
    pile.innerHTML = '<i></i>'.repeat(Math.min(4, Math.ceil(s.pile.length / 18)));

    // What the panel shows depends on the moment (see .ls-panel[data-mode] in the CSS): your tile
    // while you hold it, just the buttons once it's on the board, a word while others play.
    // Set first: the tile pull below measures the tray, which only shows while you hold.
    const mode = s.over ? (this.counting ? 'count' : 'over') : s.turn !== 0 ? 'wait' : st.at === 'lay' && !st.ghost ? 'hold' : 'act';
    this.panel.dataset.mode = mode;

    // A new tile: pulled off the pile, flipping face up, then straight in the tray.
    const shown = this.aiShow ? null : s.current;
    const key = `${s.tiles.length}:${shown}`;
    if (key !== this.drawnKey) {
      this.drawnKey = key;
      preview.style.transition = 'none';
      this.trayDeg = 0;
      preview.style.rotate = '0deg';
      preview.style.setProperty('--deg', '0');
      void preview.offsetWidth;
      preview.style.transition = '';
      card.querySelector('.ls-card-front')!.innerHTML = shown ? tileSvg(shown, this.look(shown)) : '';
      card.classList.remove('draw');
      // Your tile is a little ceremony: pulled up to the middle, turned over, then into your tray.
      if (shown && s.turn === 0 && !this.lineup && !s.over) this.pullTile(shown);
      else if (shown) {
        void card.offsetWidth;
        card.classList.add('draw');
      }
    }
    preview.classList.toggle('empty', !shown);
    // Turning your tile on the board turns it in the tray too (always clockwise).
    const turned = s.turn === 0 ? (st.at === 'lay' ? (st.ghost?.r ?? 0) : st.r) : 0;
    this.trayDeg = clockwise(this.trayDeg, turned);
    preview.style.rotate = `${this.trayDeg}deg`;
    preview.style.setProperty('--deg', String(this.trayDeg));

    // How-to lines only on your first turn.
    this.panel.classList.toggle('helping', s.tiles.length - 1 < s.options.players);
    this.panel.querySelector('.ls-left')!.textContent = String(s.pile.length + (s.current ? 1 : 0));
    const tip = (key: Key) => `<p class="ls-tip">${t(key)}</p>`;
    let body = '';
    if (mode === 'count')
      body = `<p>${this.countingWho === null ? t('landscaper.finalTally') : `${this.name(this.countingWho)}${this.countingPart ? ` · ${t(`landscaper.count.${this.countingPart}` as Key)}` : ''}`}</p>
        <div class="ls-actions"><button type="button" class="btn" data-act="skip">${t('landscaper.skipCount')}</button></div>`;
    else if (mode === 'wait') body = `<p>${t('landscaper.thinking', { who: this.who(s.turn) })}</p>`;
    else if (mode === 'hold') body = tip('landscaper.pickSpot');
    else if (mode === 'act' && st.at === 'lay')
      body = `${tip('landscaper.turnOrPlace')}
        <div class="ls-actions"><button type="button" class="btn" data-act="rotate">↻ ${t('landscaper.rotate')}</button>
        <button type="button" class="btn primary" data-act="place">${t('landscaper.place')}</button></div>`;
    else if (mode === 'act' && st.at === 'follow')
      body = `${tip(s.followers[0] || s.big?.[0] ? 'landscaper.pickFollower' : 'landscaper.noFollowers')}
        <div class="ls-actions"><button type="button" class="btn" data-act="back">${t('landscaper.back')}</button>${
          st.pick && s.big?.[0] && s.followers[0] > 0
            ? `<button type="button" class="btn ls-big${st.pick.big ? ' on' : ''}" data-act="big" aria-pressed="${!!st.pick.big}">${t('landscaper.bigBoy')}</button>`
            : ''
        }
        <button type="button" class="btn primary" data-act="done">${st.pick ? t('landscaper.done') : t('landscaper.skip')}</button></div>`;
    this.panel.querySelector('.ls-info')!.innerHTML = body.trim();
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (W && H) this.hooks.occupied?.([{ x0: this.panel.offsetLeft / W - 0.5 * (this.panel.offsetWidth / W), x1: (this.panel.offsetLeft + this.panel.offsetWidth / 2) / W, y: 1 }]);
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
