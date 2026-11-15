import { type Card, type Suit, mulberry32, shuffle } from '../../core/cards';

/**
 * Spite and Malice for two players, with a custom numbered deck: two standard decks plus four
 * jokers, where every King and Joker is a wild ★ Star. Centre piles build 1 → 12 regardless of
 * suit and clear when they reach 12. First to empty their goal (pay-off) pile wins.
 */

export type Player = 0 | 1;
export const BUILD_PILES = 4;
export const DISCARD_PILES = 4;
export const HAND_SIZE = 5;
/** A centre pile is complete at 12 (the Queen). */
export const TOP_VALUE = 12;

export interface SpiteCard extends Card {
  /** Wild: plays as whatever the pile needs. */
  star?: boolean;
}

export interface Seat {
  goal: SpiteCard[]; // last element is the face-up top
  hand: SpiteCard[];
  discards: SpiteCard[][];
}

export interface SpiteOptions {
  goalSize: number;
}

export interface SpiteState {
  seed: number;
  options: SpiteOptions;
  stock: SpiteCard[]; // last element is drawn first
  /** Finished centre piles, shuffled back in when the stock runs out. */
  spent: SpiteCard[];
  builds: SpiteCard[][];
  seats: [Seat, Seat];
  turn: Player;
  /** A hand card has been played to a centre pile this turn (purely informational). */
  playedThisTurn: number;
  winner: Player | null;
  /** Neither player can do anything and nothing is left to draw. */
  stalemate: boolean;
  shuffles: number;
}

export type Source = { from: 'hand'; index: number } | { from: 'goal' } | { from: 'discard'; pile: number };

export type Move =
  | { t: 'build'; source: Source; pile: number }
  | { t: 'discard'; index: number; pile: number }
  /** Only when the hand is empty and nothing is left to draw: the turn has to end somehow. */
  | { t: 'pass' };

const SUITS: Suit[] = ['C', 'D', 'H', 'S'];

export function buildDeck(): SpiteCard[] {
  const cards: SpiteCard[] = [];
  let id = 0;
  for (let deck = 0; deck < 2; deck++)
    for (const suit of SUITS)
      for (let rank = 1; rank <= 13; rank++) cards.push({ id: id++, suit, rank, faceUp: false, star: rank === 13 });
  for (let j = 0; j < 4; j++) cards.push({ id: id++, suit: SUITS[j], rank: 0, faceUp: false, star: true });
  return cards;
}

export function newGame(seed: number, options: SpiteOptions): SpiteState {
  const rand = mulberry32(seed);
  const deck = shuffle(buildDeck(), rand);
  const seat = (): Seat => ({ goal: [], hand: [], discards: Array.from({ length: DISCARD_PILES }, () => []) });
  const s: SpiteState = {
    seed,
    options,
    stock: [],
    spent: [],
    builds: Array.from({ length: BUILD_PILES }, () => []),
    seats: [seat(), seat()],
    turn: 0,
    playedThisTurn: 0,
    winner: null,
    stalemate: false,
    shuffles: 0,
  };
  for (let i = 0; i < options.goalSize; i++) for (const p of [0, 1] as Player[]) s.seats[p].goal.push(deck.pop()!);
  s.stock = deck;
  for (const p of [0, 1] as Player[]) s.seats[p].goal.at(-1)!.faceUp = true;
  // The first player is whoever shows the higher goal card (stars count high); ties go to you.
  const v = (p: Player) => cardValue(s.seats[p].goal.at(-1)!);
  s.turn = v(1) > v(0) ? 1 : 0;
  startTurn(s);
  return s;
}

const cardValue = (c: SpiteCard) => (c.star ? 13 : c.rank);

/** The value a centre pile needs next (1 for an empty pile). */
export const needs = (pile: SpiteCard[]) => pile.length + 1;

/** What a card shows on screen: its number, or ★. */
export const label = (c: SpiteCard) => (c.star ? '★' : String(c.rank));

export function sourceCard(s: SpiteState, p: Player, src: Source): SpiteCard | undefined {
  const seat = s.seats[p];
  if (src.from === 'hand') return seat.hand[src.index];
  if (src.from === 'goal') return seat.goal.at(-1);
  return seat.discards[src.pile].at(-1);
}

export const fits = (card: SpiteCard, pile: SpiteCard[]) => card.star || card.rank === needs(pile);

export function canBuild(s: SpiteState, p: Player, src: Source, pile: number) {
  if (s.winner !== null || s.turn !== p) return false;
  const card = sourceCard(s, p, src);
  return !!card && fits(card, s.builds[pile]);
}

function draw(s: SpiteState, n: number) {
  const hand = s.seats[s.turn].hand;
  for (let i = 0; i < n; i++) {
    if (!s.stock.length && s.spent.length) {
      s.stock = shuffle(s.spent, mulberry32(s.seed + ++s.shuffles * 104729));
      s.spent = [];
    }
    const c = s.stock.pop();
    if (!c) break;
    c.faceUp = true;
    hand.push(c);
  }
}

function startTurn(s: SpiteState) {
  s.playedThisTurn = 0;
  draw(s, HAND_SIZE - s.seats[s.turn].hand.length);
}

/** Apply a move. Returns true if a centre pile was completed and cleared. */
export function apply(s: SpiteState, p: Player, m: Move): { cleared: boolean; goal: boolean } {
  if (s.winner !== null || s.turn !== p) throw new Error('Not your turn');
  const seat = s.seats[p];
  if (m.t === 'pass') {
    if (seat.hand.length) throw new Error('Discard to end your turn');
    endTurn(s);
    return { cleared: false, goal: false };
  }
  if (m.t === 'discard') {
    const card = seat.hand[m.index];
    if (!card) throw new Error('No such card');
    seat.hand.splice(m.index, 1);
    seat.discards[m.pile].push(card);
    endTurn(s);
    return { cleared: false, goal: false };
  }
  if (!canBuild(s, p, m.source, m.pile)) throw new Error('Illegal play');
  const src = m.source;
  const card =
    src.from === 'hand' ? seat.hand.splice(src.index, 1)[0] : src.from === 'goal' ? seat.goal.pop()! : seat.discards[src.pile].pop()!;
  const pile = s.builds[m.pile];
  pile.push(card);
  const goal = src.from === 'goal';
  if (goal) {
    if (seat.goal.length) seat.goal.at(-1)!.faceUp = true;
    else s.winner = p;
  }
  if (src.from === 'hand') {
    s.playedThisTurn++;
    // Played out the whole hand: draw five more and keep going.
    if (!seat.hand.length && s.winner === null) draw(s, HAND_SIZE);
  }
  let cleared = false;
  if (pile.length === TOP_VALUE) {
    s.spent.push(...pile.splice(0));
    cleared = true;
  }
  return { cleared, goal };
}

function endTurn(s: SpiteState) {
  s.turn = (1 - s.turn) as Player;
  startTurn(s);
  // Nothing can ever happen again: no cards to draw and the player to move has no hand.
  if (!s.seats[s.turn].hand.length && !s.stock.length && !s.spent.length) s.stalemate = true;
}

/** Every centre-pile play available right now. */
export function buildMoves(s: SpiteState, p: Player): Move[] {
  const seat = s.seats[p];
  const sources: Source[] = [
    { from: 'goal' },
    ...seat.discards.map((_, pile) => ({ from: 'discard' as const, pile })),
    ...seat.hand.map((_, index) => ({ from: 'hand' as const, index })),
  ];
  const out: Move[] = [];
  for (const source of sources) for (let pile = 0; pile < BUILD_PILES; pile++) if (canBuild(s, p, source, pile)) out.push({ t: 'build', source, pile });
  return out;
}

export const clone = (s: SpiteState): SpiteState => structuredClone(s);
