import { type Card, randomSeed } from '../../core/cards';
import { type GameController, type GameHooks, type HudStat, store } from '../../core/game';
import { CardLayer, type Placement, courtUrl } from '../../ui/cardLayer';
import { type Cascade, runCascade } from '../../ui/cascade';
import { haptic, sfx, unlockAudio } from '../../ui/feedback';
import { settings } from '../../ui/settings';
import { ADVISOR, OPPONENT, chooseCard, choosePassCards } from './ai';
import {
  type HeartsOptions,
  type HeartsState,
  type Play,
  type Seat,
  SEATS,
  choosePass,
  isQueenOfSpades,
  leaders,
  legalPlays,
  newGame,
  playCard,
  startHand,
  trickPoints,
  whyIllegal,
} from './rules';

export const PLAYERS = [
  { name: 'You', emoji: '🙂' },
  { name: 'Fox', emoji: '🦊' },
  { name: 'Owl', emoji: '🦉' },
  { name: 'Bear', emoji: '🐻' },
];

const SAVE_KEY = 'ninnies.hearts.save.v1';
const PASS_ARROW = { left: '←', right: '→', across: '↑', none: '' } as const;
const PASS_TO = { left: 1, right: 3, across: 2, none: 0 } as const;

interface Layout {
  W: number;
  H: number;
  cw: number;
  ch: number;
  rows: 1 | 2;
  bottomY: number;
  raise: number;
  opp: { x: number; y: number; dx: number; dy: number }[];
  oppScale: number;
  trick: { x: number; y: number }[];
  trickScale: number;
  pile: { x: number; y: number }[];
  badge: { x: number; y: number }[];
  center: { x: number; y: number };
}

const options = (): HeartsOptions => ({
  passing: settings.heartsPassing,
  target: settings.heartsShort ? 50 : 100,
  moonSubtracts: settings.heartsMoonSubtract,
});

export class HeartsGame implements GameController {
  readonly id = 'hearts' as const;
  readonly restartLabel = 'Restart this game';

  private state!: HeartsState;
  private layer: CardLayer;
  private L!: Layout;
  private selected = new Set<number>();
  private raised: number | null = null;
  /** A finished trick held on the table for a moment before it is swept to the winner. */
  private sweeping: Play[] | null = null;
  private timer = 0;
  /**
   * Short pauses (looking at passed cards, the opening 2♣) run on their own timer: `step()`
   * clears `timer`, and cancelling a pause's end would leave the game waiting forever.
   */
  private beatTimer = 0;
  private paused = true;
  private cascade: Cascade | null = null;
  private receivedUntil = 0;
  /** After passing: the player looks over the cards they got before play starts. */
  private review = false;
  /** Who leads has been shown for this hand. */
  private announced = false;
  private announcing = false;
  /** A card in an opponent's hand turned face up for a moment (the opening 2♣). */
  private showing: number | null = null;
  /** A jump-scare is on screen; play waits for it. */
  private scaring = false;

  private badges: HTMLElement[] = [];
  private passBar: HTMLElement;
  private passBtn: HTMLButtonElement;
  private passText: HTMLElement;
  private brokenEl: HTMLElement;
  private dialog: HTMLDialogElement;

  constructor(
    private root: HTMLElement,
    private hooks: GameHooks,
  ) {
    root.classList.add('hearts-root');
    this.layer = new CardLayer(root);
    for (const seat of SEATS) {
      const b = document.createElement('div');
      b.className = 'hearts-seat';
      b.dataset.seat = String(seat);
      // Totals live in the toolbar; badges only show what each player has taken this hand.
      b.innerHTML = `<span class="emo">${PLAYERS[seat].emoji}</span><small class="pts"></small>`;
      root.appendChild(b);
      this.badges.push(b);
    }
    this.brokenEl = this.el('hearts-broken', '♥︎');
    this.brokenEl.title = 'Hearts broken';

    this.passBar = this.el('hearts-pass', '<span class="pass-text"></span><button type="button" class="btn primary pass-btn" disabled>Pass</button>');
    this.passText = this.passBar.querySelector('.pass-text')!;
    this.passBtn = this.passBar.querySelector('.pass-btn')!;
    this.passBtn.addEventListener('click', () => this.confirmPass());

    this.dialog = document.createElement('dialog');
    this.dialog.className = 'sheet center hearts-round';
    document.body.appendChild(this.dialog);
    this.dialog.addEventListener('close', () => this.afterRound());

    root.addEventListener('pointerdown', (e) => this.onDown(e));
    new ResizeObserver(() => this.relayout()).observe(root);
    document.addEventListener('visibilitychange', () => (document.hidden ? this.save() : null));
  }

  // ───────────────────────── controller ─────────────────────────

  get active() {
    return Boolean(this.state);
  }

  static saved(): string | null {
    const s = store.get<HeartsState>(SAVE_KEY);
    if (!s || s.phase === 'gameOver') return null;
    return `Hearts · hand ${s.handNo + 1} · you ${s.scores[0]} pts`;
  }

  status() {
    const s = this.state;
    return `Hearts · hand ${s.handNo + 1} · ${SEATS.map((i) => `${PLAYERS[i].emoji} ${s.scores[i]}`).join('  ')}`;
  }

  newGame(seed = randomSeed()) {
    this.stopCascade();
    clearTimeout(this.timer);
    this.state = newGame(seed, options());
    this.resetHandUi();
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
    const s = store.get<HeartsState>(SAVE_KEY);
    if (!s || s.phase === 'gameOver') return false;
    this.state = s;
    this.resetHandUi();
    this.relayout();
    return true;
  }

  pause() {
    this.paused = true;
    clearTimeout(this.timer);
    // Finish any pause now so returning to the game can't find it half-done.
    if (this.review) {
      clearTimeout(this.beatTimer);
      this.review = false;
    }
    if (this.announcing) {
      clearTimeout(this.beatTimer);
      this.announcing = false;
      this.showing = null;
    }
    this.save();
  }

  unpause() {
    this.paused = false;
    this.emitHud();
    this.step();
  }

  refresh() {
    if (!this.state) return;
    // Rule options apply from the next hand; the target applies to new games only.
    this.state.options = { ...options(), target: this.state.options.target };
    this.layer.setCourts(settings.courts);
    this.render(false);
  }

  undo() {
    /* Hearts has no undo. */
  }

  key(e: KeyboardEvent) {
    if (e.key === 'Enter' && this.state?.phase === 'pass' && this.selected.size === 3) {
      this.confirmPass();
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
    if (!s || this.cascade) return;
    if (s.phase === 'pass') {
      const pick = choosePassCards(s.hands[0], Math.random, ADVISOR);
      this.selected = new Set(pick.map((c) => c.id));
      this.render();
      pick.forEach((c) => flash(this.layer.els.get(c.id)!, 'hinted', 1600));
      this.hooks.hint?.({ from: this.handFraction(pick[0].id) }, 'move');
      this.updatePassBar();
      return;
    }
    if (s.phase !== 'play' || s.turn !== 0 || this.sweeping) {
      this.hooks.toast('Wait for your turn');
      return;
    }
    const card = chooseCard(s, 0, Math.random, ADVISOR);
    this.raised = card.id;
    this.render();
    flash(this.layer.els.get(card.id)!, 'hinted', 1600);
    this.hooks.hint?.({ from: this.handFraction(card.id), to: 0.5 }, 'move');
  }

  previewWin() {
    if (!this.state || this.cascade) return;
    this.pause();
    sfx.win();
    this.hooks.event?.('win');
    this.celebrate(() => {
      this.hooks.toast('Tap to return to your game');
      const back = () => {
        this.stopCascade();
        this.render(false);
        this.unpause();
      };
      this.root.addEventListener('pointerdown', back, { once: true, capture: true });
    });
  }

  // ───────────────────────── flow ─────────────────────────

  private speed() {
    return settings.heartsFast ? 280 : 620;
  }

  /** Decide what happens next: wait for the player, let an opponent play, or finish the hand. */
  private step() {
    clearTimeout(this.timer);
    const s = this.state;
    if (!s || this.paused || this.sweeping || this.cascade || this.review || this.announcing || this.scaring) return;
    if (s.phase === 'play' && !this.announced) {
      this.announceLeader();
      return;
    }
    this.updatePassBar();
    this.emitHud();
    if (s.phase === 'play' && s.turn !== 0) {
      this.timer = window.setTimeout(() => {
        const seat = s.turn;
        this.play(seat, chooseCard(s, seat, Math.random, OPPONENT));
      }, this.speed() * (0.8 + Math.random() * 0.5));
    } else if (s.phase === 'handOver' || s.phase === 'gameOver') {
      this.timer = window.setTimeout(() => this.showRound(), 300);
    }
    this.render();
  }

  private play(seat: Seat, card: Card) {
    const s = this.state;
    const before = [...s.trick, { seat, card }];
    const breaking = card.suit === 'H' && !s.heartsBroken;
    const winner = playCard(s, seat, card);
    if (breaking) this.heartsBroken();
    if (isQueenOfSpades(card)) this.queenScare();
    this.raised = null;
    if (seat === 0) {
      sfx.move(1, 0.12);
      haptic(8);
    } else {
      sfx.drop();
    }
    if (winner === null) {
      this.save();
      this.render();
      // A scare holds play until it's over (it calls step itself).
      if (!this.scaring) this.step();
      return;
    }
    // Leave the full trick on the table for a beat, then sweep it to the winner.
    this.sweeping = before;
    this.render();
    this.emitHud();
    const wait = this.speed() + 450 + (this.scaring ? 1500 : 0);
    this.timer = window.setTimeout(() => this.sweep(winner, before), wait);
  }

  private sweep(winner: Seat, trick: Play[]) {
    this.sweeping = null;
    sfx.undo();
    const cards = trick.map((p) => p.card);
    const pts = trickPoints(cards);
    const hadQueen = cards.some(isQueenOfSpades);
    if (winner === 0) {
      if (hadQueen) this.hooks.event?.('stuck', 0.5);
      else if (pts) this.hooks.event?.('invalid', 0.5);
      else this.hooks.event?.('suit', 0.5);
    } else if (hadQueen) {
      this.hooks.event?.('complete', this.seatFraction(winner));
    }
    this.save();
    this.render();
    this.timer = window.setTimeout(() => this.step(), 380);
  }

  private confirmPass() {
    const s = this.state;
    if (s.phase !== 'pass' || this.selected.size !== 3) return;
    const mine = s.hands[0].filter((c) => this.selected.has(c.id));
    for (const seat of [1, 2, 3] as Seat[]) choosePass(s, seat, choosePassCards(s.hands[seat], Math.random));
    choosePass(s, 0, mine);
    this.selected.clear();
    // Hold a moment: the cards that arrived stay lifted so the player sees what they got.
    this.review = true;
    sfx.deal(0);
    sfx.deal(0.08);
    sfx.deal(0.16);
    this.save();
    this.render();
    clearTimeout(this.beatTimer);
    this.beatTimer = window.setTimeout(() => this.endReview(), 1800);
  }

  private endReview() {
    if (!this.review) return;
    clearTimeout(this.beatTimer);
    this.review = false;
    this.render();
    this.step();
  }

  /** A beat before the first trick: the 2♣ turns face up in the starting player's hand. */
  private announceLeader() {
    const s = this.state;
    this.announced = true;
    this.announcing = true;
    this.passBar.hidden = true;
    const two = s.hands[s.turn].find((c) => c.suit === 'C' && c.rank === 2);
    this.showing = two?.id ?? null;
    if (s.turn === 0) this.raised = this.showing;
    this.render();
    clearTimeout(this.beatTimer);
    this.beatTimer = window.setTimeout(() => this.endAnnounce(), 1000);
  }

  private endAnnounce() {
    if (!this.announcing) return;
    clearTimeout(this.beatTimer);
    this.announcing = false;
    this.showing = null;
    this.step();
  }

  private heartsBroken() {
    sfx.heartsBreak();
    haptic([30, 30, 60]);
    flash(this.brokenEl, 'crack', 900);
  }

  /** The Queen of Spades: a flickering, sepia silent-movie jump scare. */
  private queenScare() {
    if (this.scaring) return;
    this.scaring = true;
    sfx.queenScare();
    // Impacts: two heavy hits with the timpani, then the long organ stab.
    haptic([40, 50, 40, 60, 160]);
    const fig = settings.courts === 'letters' ? '' : `<span class="scare-fig" style="background-image:url(${courtUrl(settings.courts, 'queen_spades')})"></span>`;
    const el = document.createElement('div');
    el.className = 'queen-scare';
    el.innerHTML = `<div class="scare-card" data-suit="S"><span class="scare-idx">Q<i>♠\uFE0E</i></span>${fig}<span class="scare-q">${fig ? '' : 'Q'}</span></div>`;
    this.root.parentElement!.appendChild(el);
    window.setTimeout(() => {
      el.remove();
      this.scaring = false;
      this.step();
    }, 1500);
  }

  private showRound() {
    const s = this.state;
    const last = s.history.at(-1)!;
    const moon = s.moon !== null ? `<p class="moon">🌙 ${PLAYERS[s.moon].emoji} ${s.moon === 0 ? 'You shot' : `${PLAYERS[s.moon].name} shot`} the moon!</p>` : '';
    const over = s.phase === 'gameOver';
    const best = leaders(s);
    const rows = SEATS.map(
      (i) => `<tr class="${best.includes(i) ? 'lead' : ''}"><td>${PLAYERS[i].emoji} ${PLAYERS[i].name}</td><td>${last[i] > 0 ? '+' : ''}${last[i]}</td><td><b>${s.scores[i]}</b></td></tr>`,
    ).join('');
    this.dialog.innerHTML = `<form method="dialog">
      <h2>${over ? 'Final scores' : `Hand ${s.handNo + 1}`}</h2>${moon}
      <table class="round-table"><thead><tr><th></th><th>Hand</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="actions"><button value="next" class="btn primary">${over ? 'See results' : 'Next hand'}</button></div>
    </form>`;
    if (s.moon === 0) this.hooks.event?.('win');
    else if (last[0] === 0) this.hooks.event?.('complete', 0.5);
    if (!this.dialog.open) this.dialog.showModal();
  }

  private afterRound() {
    const s = this.state;
    if (!s) return;
    if (s.phase === 'gameOver') return this.finish();
    if (s.phase !== 'handOver') return;
    startHand(s);
    this.resetHandUi();
    this.save();
    this.dealIn();
    this.step();
  }

  private finish() {
    const s = this.state;
    const best = leaders(s);
    const youWon = best.includes(0);
    const result = {
      title: youWon ? 'You won!' : `${best.map((i) => PLAYERS[i].emoji).join(' ')} ${PLAYERS[best[0]].name} wins`,
      line: `Hearts · ${s.handNo + 1} hands · first to ${s.options.target} loses`,
      stats: SEATS.map((i) => ({ label: PLAYERS[i].emoji, value: String(s.scores[i]) })),
      celebrate: youWon,
    };
    store.set(SAVE_KEY, null);
    if (youWon) {
      sfx.win();
      this.hooks.event?.('win');
      this.celebrate(() => this.hooks.finished(result));
    } else {
      sfx.invalid();
      this.hooks.event?.('stuck');
      this.hooks.finished(result);
    }
  }

  private resetHandUi() {
    clearTimeout(this.beatTimer);
    this.announcing = false;
    this.showing = null;
    this.selected.clear();
    this.raised = null;
    this.sweeping = null;
    this.review = false;
    // A restored game that's already under way doesn't need the "who leads" beat again.
    const s = this.state;
    this.announced = !!s && (s.trickNo > 0 || s.trick.length > 0);
  }

  private save() {
    if (this.state) store.set(SAVE_KEY, this.state);
  }

  private emitHud() {
    const s = this.state;
    if (!s) return;
    const stats: HudStat[] = SEATS.map((i) => ({
      label: i === 0 ? 'You' : PLAYERS[i].emoji,
      value: String(s.scores[i]),
      hot: s.phase === 'play' && s.turn === i && !this.sweeping,
    }));
    this.hooks.hud({ stats, canUndo: false, hasUndo: false });
  }

  // ───────────────────────── input ─────────────────────────

  private onDown(e: PointerEvent) {
    unlockAudio();
    const s = this.state;
    if (!s || this.cascade) return;
    const cardEl = (e.target as HTMLElement).closest<HTMLElement>('.card');
    const card = cardEl ? s.hands[0].find((c) => c.id === Number(cardEl.dataset.id)) : undefined;
    if (!card) {
      if (this.raised !== null) {
        this.raised = null;
        this.render();
      }
      return;
    }
    e.preventDefault();

    if (this.review) return this.endReview();
    if (this.announcing) this.endAnnounce();
    if (s.phase === 'pass') {
      if (this.selected.has(card.id)) this.selected.delete(card.id);
      else if (this.selected.size < 3) this.selected.add(card.id);
      else {
        this.layer.wiggle([card.id]);
        haptic(12);
        return;
      }
      sfx.pick();
      haptic(5);
      this.updatePassBar();
      this.render();
      return;
    }

    if (s.phase !== 'play' || this.sweeping) return;
    const why = whyIllegal(s, 0, card);
    if (why) {
      this.layer.wiggle([card.id]);
      sfx.invalid();
      haptic([15, 40, 15]);
      if (s.turn === 0) {
        this.hooks.toast(why);
        this.hooks.event?.('invalid', this.handFraction(card.id));
      }
      return;
    }
    // First tap lifts the card, a second tap plays it (unless single tap is enough).
    if (this.raised === card.id || settings.heartsOneTap) {
      this.play(0, card);
    } else {
      this.raised = card.id;
      sfx.pick();
      haptic(5);
      this.render();
    }
  }

  private updatePassBar() {
    const s = this.state;
    if (this.announcing) return;
    if (this.review) {
      const from = SEATS.find((seat) => seat !== 0 && (seat + PASS_TO[s.passDir]) % 4 === 0) ?? 0;
      this.passBar.hidden = false;
      this.passBtn.hidden = true;
      this.passText.textContent = `From ${PLAYERS[from].emoji}`;
      return;
    }
    const show = s.phase === 'pass' && !this.paused;
    this.passBar.hidden = !show;
    this.passBtn.hidden = false;
    if (!show) return;
    const to = PASS_TO[s.passDir];
    const arrow = PASS_ARROW[s.passDir];
    this.passText.textContent =
      s.passDir === 'left' ? `Pass 3 ${arrow} ${PLAYERS[to].emoji}` : s.passDir === 'right' ? `Pass 3 to ${PLAYERS[to].emoji} ${arrow}` : `Pass 3 ${arrow} ${PLAYERS[to].emoji}`;
    this.passBtn.disabled = this.selected.size !== 3;
    this.passBtn.textContent = this.selected.size === 3 ? 'Pass' : `${this.selected.size}/3`;
  }

  // ───────────────────────── layout & render ─────────────────────────

  private relayout() {
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (!W || !H) return;
    const pad = 10;
    const portrait = H > W * 1.05;
    const cw = Math.round(
      portrait ? clamp(Math.min((W - pad * 2) / 4.3, H * 0.14), 54, 118) : clamp(Math.min(H * 0.21, (W - pad * 2) / 6), 50, 110),
    );
    const ch = Math.round(cw * 1.4);
    const rows = portrait ? 2 : 1;
    const raise = Math.round(ch * 0.24);
    const bottomY = H - pad - ch;
    const handTop = (rows === 2 ? bottomY - ch * 0.52 : bottomY) - raise;

    const oppScale = portrait ? 0.42 : 0.4;
    const ow = cw * oppScale;
    const oh = ch * oppScale;
    const top = pad + oh + 34;
    const bottom = handTop - 8;
    const center = { x: W / 2, y: (top + bottom) / 2 };
    // Side fans (and their badges below) must fit between the north hand and the player's hand.
    const sideStep = Math.max(2, Math.min(oh * 0.16, (bottom - top - oh - 30) / 12));
    const sideLen = oh + 12 * sideStep;
    const sideY = Math.max(top - 10, center.y - (sideLen + 26) / 2);
    const northW = ow + 12 * ow * 0.3;
    const opp = [
      { x: 0, y: 0, dx: 0, dy: 0 },
      { x: pad, y: sideY, dx: 0, dy: sideStep },
      { x: W / 2 - northW / 2, y: pad, dx: ow * 0.3, dy: 0 },
      { x: W - pad - ow, y: sideY, dx: 0, dy: sideStep },
    ];
    const trickScale = Math.min(1, (bottom - top) / (ch * 1.75), (W - 2 * ow - 4 * pad) / (cw * 2.4));
    const tw = cw * trickScale;
    const th = ch * trickScale;
    const tx = center.x - tw / 2;
    const ty = center.y - th / 2;
    const trick = [
      { x: tx, y: ty + th * 0.32 },
      { x: tx - tw * 0.66, y: ty },
      { x: tx, y: ty - th * 0.32 },
      { x: tx + tw * 0.66, y: ty },
    ];
    const pile = [
      { x: W / 2 + cw * 0.9 + 80, y: handTop - oh * 0.8 },
      { x: pad + ow * 0.15, y: sideY + oh * 0.5 },
      { x: W / 2 - ow / 2, y: pad + oh * 0.2 },
      { x: W - pad - ow * 1.15, y: sideY + oh * 0.5 },
    ];
    const badge = [
      // The player's badge sits just above their hand, right of the bunny's spot.
      { x: W / 2 + cw * 0.9, y: handTop - 32 },
      { x: pad + ow / 2, y: sideY + sideLen + 4 },
      { x: W / 2 + northW / 2 + 8, y: pad + oh / 2 - 14 },
      { x: W - pad - ow / 2, y: sideY + sideLen + 4 },
    ];
    this.L = { W, H, cw, ch, rows, bottomY, raise, opp, oppScale, trick, trickScale, pile, badge, center };
    this.root.style.setProperty('--cw', `${cw}px`);
    this.root.style.setProperty('--ch', `${ch}px`);
    // The Hint Bunny (outside this layer) peeks over the top of the hand instead of covering it.
    this.root.parentElement?.style.setProperty('--bunny-lift', `${Math.round(H - handTop - raise * 0.6)}px`);
    this.brokenEl.style.transform = `translate(${center.x - 10}px, ${top - 28}px)`;
    this.passBar.style.setProperty('--pass-y', `${center.y}px`);
    this.badges.forEach((b, i) => {
      b.style.transform = `translate(${badge[i].x}px, ${badge[i].y}px)`;
      b.classList.toggle('side', i === 1 || i === 3);
    });
    if (this.state && !this.cascade) this.render(false);
  }

  /** Where each card in the player's hand sits (two overlapping rows in portrait). */
  private handSpots(hand: Card[]) {
    const { W, cw, ch, rows, bottomY } = this.L;
    const pad = 10;
    const split = rows === 2 ? Math.ceil(hand.length / 2) : hand.length;
    const lines = rows === 2 ? [hand.slice(0, split), hand.slice(split)] : [hand];
    const spots = new Map<number, { x: number; y: number; z: number }>();
    lines.forEach((line, r) => {
      const n = line.length;
      const maxStep = cw * 0.78;
      const step = n > 1 ? Math.min(maxStep, (W - pad * 2 - cw) / (n - 1)) : 0;
      const x0 = (W - (cw + (n - 1) * step)) / 2;
      const y = rows === 2 && r === 0 ? bottomY - ch * 0.52 : bottomY;
      line.forEach((c, i) => spots.set(c.id, { x: Math.round(x0 + i * step), y: Math.round(y), z: 600 + r * 40 + i }));
    });
    return spots;
  }

  private render(animate = true) {
    const s = this.state;
    if (!s) return;
    if (!this.L) this.relayout();
    if (!this.L) return;
    const L = this.L;
    const put = (card: Card, p: Placement) => {
      this.layer.sync({ ...card, faceUp: p.faceUp });
      this.layer.place(card.id, p, animate);
    };

    const myTurn = s.phase === 'play' && s.turn === 0 && !this.sweeping;
    const legal = new Set(myTurn ? legalPlays(s, 0).map((c) => c.id) : []);
    const fresh = this.review || performance.now() < this.receivedUntil ? new Set(s.received) : new Set<number>();
    const spots = this.handSpots(s.hands[0]);
    for (const c of s.hands[0]) {
      const p = spots.get(c.id)!;
      const up = this.selected.has(c.id) || this.raised === c.id || (this.review && fresh.has(c.id));
      put(c, { x: p.x, y: p.y - (up ? L.raise : 0), z: p.z, faceUp: true });
      const el = this.layer.els.get(c.id)!;
      el.classList.toggle('locked', myTurn && settings.dimLocked && !legal.has(c.id));
      el.classList.toggle('received', fresh.has(c.id));
      el.classList.toggle('picked', up);
    }

    for (const seat of [1, 2, 3] as Seat[]) {
      const o = L.opp[seat];
      s.hands[seat].forEach((c, i) => {
        const shown = c.id === this.showing;
        put(c, { x: o.x + i * o.dx, y: o.y + i * o.dy, z: shown ? 300 : 100 + i, faceUp: shown, scale: L.oppScale });
        this.clearMarks(c.id);
      });
    }

    const onTable = this.sweeping ?? s.trick;
    const showing = new Set(onTable.map((p) => p.card.id));
    onTable.forEach((p, i) => {
      const t = L.trick[p.seat];
      put(p.card, { x: t.x, y: t.y, z: 800 + i, faceUp: true, scale: L.trickScale });
      this.clearMarks(p.card.id);
    });

    SEATS.forEach((seat) => {
      const pl = L.pile[seat];
      s.taken[seat]
        .filter((c) => !showing.has(c.id))
        .forEach((c, i) => {
          put(c, { x: pl.x + (i % 4), y: pl.y - (i % 4), z: 40 + i, faceUp: false, scale: L.oppScale * 0.8 });
          this.clearMarks(c.id);
        });
    });

    // Seat badges: points taken this hand and whose turn.
    SEATS.forEach((seat) => {
      const b = this.badges[seat];
      const pts = trickPoints(s.taken[seat]);
      const q = s.taken[seat].some(isQueenOfSpades);
      const hearts = pts - (q ? 13 : 0);
      b.querySelector('.pts')!.textContent = [q ? 'Q♠' : '', hearts ? `♥${hearts}` : ''].filter(Boolean).join(' ');
      b.classList.toggle('clean', !pts);
      b.classList.toggle('turn', s.phase === 'play' && s.turn === seat && !this.sweeping && !this.review && !this.announcing);
      b.classList.toggle('you', seat === 0);
    });
    this.brokenEl.classList.toggle('on', s.heartsBroken);
    this.updatePassBar();
  }

  private clearMarks(id: number) {
    this.layer.els.get(id)?.classList.remove('locked', 'received', 'picked');
  }

  /** New hand: cards fly out from the middle of the table to each seat. */
  private dealIn() {
    if (!this.L) this.relayout();
    if (!this.L) return;
    const { center, cw, ch } = this.L;
    const all = this.state.hands.flat();
    for (const c of all) {
      this.layer.sync({ ...c, faceUp: false });
      this.layer.place(c.id, { x: center.x - cw / 2, y: center.y - ch / 2, z: 10, faceUp: false }, false);
      this.clearMarks(c.id);
    }
    void this.root.offsetWidth;
    const order = new Map<number, number>();
    for (let i = 0; i < 13; i++) for (const seat of SEATS) order.set(this.state.hands[seat][i]?.id ?? -1, (i * 4 + seat) * 18);
    const s = this.state;
    const spots = this.handSpots(s.hands[0]);
    const L = this.L;
    for (const seat of SEATS) {
      s.hands[seat].forEach((c, i) => {
        const delay = order.get(c.id) ?? 0;
        if (seat === 0) {
          const p = spots.get(c.id)!;
          this.layer.place(c.id, { x: p.x, y: p.y, z: p.z, faceUp: true, delay }, true);
        } else {
          const o = L.opp[seat];
          this.layer.place(c.id, { x: o.x + i * o.dx, y: o.y + i * o.dy, z: 100 + i, faceUp: false, scale: L.oppScale, delay }, true);
        }
      });
    }
    for (let i = 0; i < 52; i += 4) sfx.deal((i * 18) / 1000);
  }

  private celebrate(onDone: () => void) {
    this.stopCascade();
    const cards = [...this.state.hands.flat(), ...this.state.taken.flat(), ...this.state.trick.map((p) => p.card)];
    const order = cards.map((card) => {
      const p = this.layer.pos(card.id) ?? { x: this.L.center.x, y: this.L.center.y };
      return { card, x: p.x, y: p.y };
    });
    this.cascade = runCascade(this.root, order, { cw: this.L.cw, ch: this.L.ch }, settings.courts, onDone);
  }

  private stopCascade() {
    this.cascade?.clear();
    this.cascade = null;
  }

  private handFraction(id: number) {
    const p = this.layer.pos(id);
    return p ? (p.x + this.L.cw / 2) / this.L.W : 0.5;
  }

  private seatFraction(seat: Seat) {
    return (this.L.badge[seat].x + 20) / this.L.W;
  }

  private el(cls: string, html: string) {
    const e = document.createElement('div');
    e.className = cls;
    e.innerHTML = html;
    this.root.appendChild(e);
    return e;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function flash(el: HTMLElement, cls: string, ms: number) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), ms);
}
