import { t } from '../../i18n';
import { type Card, type Suit, mulberry32, shuffle } from '../../core/cards';

/** 0 = you (south), then clockwise: 1 = west, 2 = north, 3 = east. Play also goes in this order. */
export type Seat = 0 | 1 | 2 | 3;
export const SEATS: Seat[] = [0, 1, 2, 3];

export type PassDir = 'left' | 'right' | 'across' | 'none';
const PASS_CYCLE: PassDir[] = ['left', 'right', 'across', 'none'];
const PASS_OFFSET: Record<PassDir, number> = { left: 1, right: 3, across: 2, none: 0 };

export type Phase = 'pass' | 'play' | 'handOver' | 'gameOver';

export interface HeartsOptions {
  passing: boolean;
  target: number;
  /** Shooting the moon: false = everyone else +26 (classic), true = shooter −26. */
  moonSubtracts: boolean;
}

export interface Play {
  seat: Seat;
  card: Card;
}

export interface HeartsState {
  seed: number;
  handNo: number;
  options: HeartsOptions;
  phase: Phase;
  passDir: PassDir;
  hands: Card[][];
  /** Cards each seat has chosen to pass (pass phase only). */
  passes: (Card[] | null)[];
  /** Cards that arrived by passing, so the UI can point them out. */
  received: number[];
  trick: Play[];
  /** The last completed trick, kept for display while it is swept away. */
  lastTrick: Play[];
  lastWinner: Seat | null;
  leader: Seat;
  turn: Seat;
  trickNo: number;
  heartsBroken: boolean;
  /** Suits each seat has shown to be out of this hand (e.g. 'CD'), for the AI's card counting. */
  voids?: string[];
  /** All cards won in tricks this hand, per seat. */
  taken: Card[][];
  scores: number[];
  /** Points per seat for each finished hand. */
  history: number[][];
  /** Seat that shot the moon in the last finished hand, if any. */
  moon: Seat | null;
}

const SUITS: Suit[] = ['C', 'D', 'S', 'H'];

/** Ace high. */
export const value = (c: Card) => (c.rank === 1 ? 14 : c.rank);
export const isQueenOfSpades = (c: Card) => c.suit === 'S' && c.rank === 12;
export const points = (c: Card) => (c.suit === 'H' ? 1 : isQueenOfSpades(c) ? 13 : 0);
export const trickPoints = (cards: Card[]) => cards.reduce((n, c) => n + points(c), 0);
const isTwoOfClubs = (c: Card) => c.suit === 'C' && c.rank === 2;

/** Hand order on screen: clubs, diamonds, spades, hearts; low to high. */
export function sortHand(cards: Card[]) {
  return cards.sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || value(a) - value(b));
}

function dealHand(seed: number, handNo: number) {
  const cards: Card[] = [];
  let id = 0;
  for (const suit of SUITS) for (let rank = 1; rank <= 13; rank++) cards.push({ id: id++, suit, rank, faceUp: false });
  shuffle(cards, mulberry32((seed + handNo * 7919) >>> 0));
  return SEATS.map((s) => sortHand(cards.slice(s * 13, s * 13 + 13)));
}

export function newGame(seed: number, options: HeartsOptions): HeartsState {
  const s: HeartsState = {
    seed,
    handNo: -1,
    options,
    phase: 'pass',
    passDir: 'left',
    hands: [],
    passes: [],
    received: [],
    trick: [],
    lastTrick: [],
    lastWinner: null,
    leader: 0,
    turn: 0,
    trickNo: 0,
    heartsBroken: false,
    taken: [],
    scores: [0, 0, 0, 0],
    history: [],
    moon: null,
  };
  startHand(s);
  return s;
}

export function startHand(s: HeartsState) {
  s.handNo++;
  s.hands = dealHand(s.seed, s.handNo);
  s.passDir = s.options.passing ? PASS_CYCLE[s.handNo % 4] : 'none';
  s.passes = [null, null, null, null];
  s.received = [];
  s.trick = [];
  s.lastTrick = [];
  s.lastWinner = null;
  s.trickNo = 0;
  s.heartsBroken = false;
  s.taken = [[], [], [], []];
  s.voids = ['', '', '', ''];
  s.moon = null;
  if (s.passDir === 'none') beginPlay(s);
  else s.phase = 'pass';
}

export const passTarget = (s: HeartsState, from: Seat) => ((from + PASS_OFFSET[s.passDir]) % 4) as Seat;

/** Record a seat's three cards to pass; once all four have chosen, swap them and start play. */
export function choosePass(s: HeartsState, seat: Seat, cards: Card[]) {
  if (s.phase !== 'pass' || cards.length !== 3) throw new Error('Bad pass');
  s.passes[seat] = cards;
  if (s.passes.every(Boolean)) {
    const moving = s.passes as Card[][];
    for (const from of SEATS) {
      const ids = new Set(moving[from].map((c) => c.id));
      s.hands[from] = s.hands[from].filter((c) => !ids.has(c.id));
    }
    for (const from of SEATS) {
      const to = passTarget(s, from);
      s.hands[to].push(...moving[from]);
      if (to === 0) s.received = moving[from].map((c) => c.id);
    }
    s.hands.forEach(sortHand);
    beginPlay(s);
  }
}

function beginPlay(s: HeartsState) {
  s.phase = 'play';
  const opener = SEATS.find((seat) => s.hands[seat].some(isTwoOfClubs))!;
  s.leader = opener;
  s.turn = opener;
}

export function legalPlays(s: HeartsState, seat: Seat): Card[] {
  const hand = s.hands[seat];
  if (s.phase !== 'play' || s.turn !== seat) return [];
  if (!s.trick.length) {
    if (s.trickNo === 0) return hand.filter(isTwoOfClubs);
    if (!s.heartsBroken) {
      const nonHearts = hand.filter((c) => c.suit !== 'H');
      if (nonHearts.length) return nonHearts;
    }
    return hand;
  }
  const lead = s.trick[0].card.suit;
  const follow = hand.filter((c) => c.suit === lead);
  if (follow.length) return follow;
  if (s.trickNo === 0) {
    // No points on the first trick, unless that's all you have.
    const clean = hand.filter((c) => !points(c));
    if (clean.length) return clean;
  }
  return hand;
}

/** Why a card can't be played right now, for a friendly message. */
export function whyIllegal(s: HeartsState, seat: Seat, card: Card): string | null {
  if (legalPlays(s, seat).some((c) => c.id === card.id)) return null;
  if (s.turn !== seat) return t('hearts.waitTurn');
  if (!s.trick.length && s.trickNo === 0) return t('hearts.lead2c');
  if (!s.trick.length) return t('hearts.notBroken');
  if (s.hands[seat].some((c) => c.suit === s.trick[0].card.suit)) return t('hearts.followSuit');
  return t('hearts.noPointsFirst');
}

export function winnerOf(trick: Play[]): Seat {
  const lead = trick[0].card.suit;
  return trick.filter((p) => p.card.suit === lead).reduce((a, b) => (value(b.card) > value(a.card) ? b : a)).seat;
}

/** Play a card. Returns the trick winner when this card completed a trick. */
export function playCard(s: HeartsState, seat: Seat, card: Card): Seat | null {
  if (!legalPlays(s, seat).some((c) => c.id === card.id)) throw new Error('Illegal play');
  s.hands[seat] = s.hands[seat].filter((c) => c.id !== card.id);
  const lead = s.trick[0]?.card.suit;
  if (lead && card.suit !== lead && s.voids && !s.voids[seat].includes(lead)) s.voids[seat] += lead;
  s.trick.push({ seat, card });
  if (card.suit === 'H') s.heartsBroken = true;
  if (s.trick.length < 4) {
    s.turn = ((seat + 1) % 4) as Seat;
    return null;
  }
  const winner = winnerOf(s.trick);
  s.taken[winner].push(...s.trick.map((p) => p.card));
  s.lastTrick = s.trick;
  s.lastWinner = winner;
  s.trick = [];
  s.trickNo++;
  s.leader = winner;
  s.turn = winner;
  if (s.trickNo === 13) finishHand(s);
  return winner;
}

/** Points per seat for the current hand (moon applied). */
export function handPoints(s: HeartsState): { points: number[]; moon: Seat | null } {
  const raw = s.taken.map(trickPoints);
  const moon = raw.findIndex((p) => p === 26);
  if (moon < 0) return { points: raw, moon: null };
  const pts = s.options.moonSubtracts ? raw.map((_, i) => (i === moon ? -26 : 0)) : raw.map((_, i) => (i === moon ? 0 : 26));
  return { points: pts, moon: moon as Seat };
}

function finishHand(s: HeartsState) {
  const { points: pts, moon } = handPoints(s);
  s.moon = moon;
  s.history.push(pts);
  s.scores = s.scores.map((n, i) => n + pts[i]);
  s.phase = s.scores.some((n) => n >= s.options.target) ? 'gameOver' : 'handOver';
}

/** Seats with the lowest score (ties share the win). */
export const leaders = (s: HeartsState) => {
  const best = Math.min(...s.scores);
  return SEATS.filter((seat) => s.scores[seat] === best);
};

/** Every card already played this hand (for the AI's card counting). */
export const playedCards = (s: HeartsState) => [...s.taken.flat(), ...s.trick.map((p) => p.card)];
