import type { Card } from '../../core/cards';
import {
  type HeartsState,
  type Seat,
  isQueenOfSpades,
  legalPlays,
  playedCards,
  points,
  trickPoints,
  value,
  winnerOf,
} from './rules';

/**
 * Rule-based Hearts AI built on the classic heuristics (pass away the Q♠/A♠/K♠ and high
 * hearts, void short suits, duck under the current winner, dump the Q♠ on a higher spade,
 * lead low spades to flush the queen). It is deliberately imperfect: it sometimes plays a
 * random legal card, and it only occasionally notices someone going for the moon.
 */
export interface Skill {
  /** Chance of a random legal play instead of the considered one. */
  mistakes: number;
  /** Chance per decision of noticing (and trying to stop) a moon shot. */
  moonAwareness: number;
}

export const OPPONENT: Skill = { mistakes: 0.12, moonAwareness: 0.25 };
/** Used for the player's hints: no deliberate mistakes. */
export const ADVISOR: Skill = { mistakes: 0, moonAwareness: 0.8 };

const pick = <T>(xs: T[], rand: () => number) => xs[Math.floor(rand() * xs.length)];
const highest = (cs: Card[]) => cs.reduce((a, b) => (value(b) > value(a) ? b : a));
const lowest = (cs: Card[]) => cs.reduce((a, b) => (value(b) < value(a) ? b : a));

/** Choose three cards to pass: the most dangerous first, with a nudge toward voiding short suits. */
export function choosePassCards(hand: Card[], rand: () => number, skill: Skill = OPPONENT): Card[] {
  const count = (suit: string) => hand.filter((c) => c.suit === suit).length;
  const spades = count('S');
  const danger = (c: Card) => {
    const v = value(c);
    let d = 0;
    if (c.suit === 'S') {
      // With plenty of spades to hide behind, the Q♠ and its guards are safe to keep.
      if (v >= 12) d = spades >= 5 ? 15 : isQueenOfSpades(c) ? 100 : 80;
      else d = v;
    } else if (c.suit === 'H') {
      d = v * 3;
    } else {
      d = v * 2;
      if (count(c.suit) <= 2) d += 25; // voiding a suit lets you dump points later
    }
    return d + rand() * 4;
  };
  const ranked = [...hand].sort((a, b) => danger(b) - danger(a));
  const chosen = ranked.slice(0, 3);
  if (rand() < skill.mistakes) chosen[2] = pick(ranked.slice(3), rand);
  return chosen;
}

/** Is someone (other than `seat`) sweeping every point card so far? */
function moonSuspect(s: HeartsState, seat: Seat): Seat | null {
  const pts = s.taken.map(trickPoints);
  const total = pts.reduce((a, b) => a + b, 0);
  if (total < 10 || s.trickNo < 6) return null;
  const holder = pts.findIndex((p) => p === total);
  return holder >= 0 && holder !== seat ? (holder as Seat) : null;
}

export function chooseCard(s: HeartsState, seat: Seat, rand: () => number, skill: Skill = OPPONENT): Card {
  const legal = legalPlays(s, seat);
  if (legal.length === 1) return legal[0];
  if (rand() < skill.mistakes) return pick(legal, rand);

  const gone = playedCards(s);
  const queenOut = !gone.some(isQueenOfSpades) && !s.hands[seat].some(isQueenOfSpades);
  const stopMoon = moonSuspect(s, seat) !== null && rand() < skill.moonAwareness;

  // ── Leading ──
  if (!s.trick.length) {
    const spades = legal.filter((c) => c.suit === 'S');
    const holdsQueenOrGuard = s.hands[seat].some((c) => c.suit === 'S' && value(c) >= 12);
    // Flush the queen out with low spades while it's still in someone else's hand.
    if (queenOut && !holdsQueenOrGuard && spades.length && rand() < 0.6) return lowest(spades);
    // Otherwise lead low from the shortest safe suit, to void it.
    const safe = legal.filter((c) => c.suit !== 'H' && !(c.suit === 'S' && value(c) >= 12));
    const pool = safe.length ? safe : legal;
    const len = (c: Card) => s.hands[seat].filter((x) => x.suit === c.suit).length;
    return pool.reduce((a, b) => (value(b) + len(b) * 1.5 < value(a) + len(a) * 1.5 ? b : a));
  }

  const lead = s.trick[0].card.suit;
  const winning = s.trick.find((p) => p.seat === winnerOf(s.trick))!.card;
  const following = legal[0].suit === lead;
  const last = s.trick.length === 3;
  const pointsHere = trickPoints(s.trick.map((p) => p.card));

  // ── Following suit ──
  if (following) {
    const under = legal.filter((c) => value(c) < value(winning));
    const over = legal.filter((c) => value(c) > value(winning));
    // Trying to stop a moon: take a trick that has points in it.
    if (stopMoon && pointsHere > 0 && over.length) return lowest(over);
    // Classic: drop the queen on someone's ace or king of spades.
    const queen = legal.find(isQueenOfSpades);
    if (queen && lead === 'S' && value(winning) > 12) return queen;
    if (under.length) {
      // Duck as high as possible; never hand yourself the queen.
      const safeUnder = under.filter((c) => !isQueenOfSpades(c));
      return highest(safeUnder.length ? safeUnder : under);
    }
    // We're going to win this one (unless someone goes higher).
    const noQueen = legal.filter((c) => !isQueenOfSpades(c));
    const pool = noQueen.length ? noQueen : legal;
    return last ? highest(pool) : lowest(pool);
  }

  // ── Void in the led suit: discard ──
  if (stopMoon) {
    // Keep hearts back so the suspect can't collect them; shed something harmless instead.
    const harmless = legal.filter((c) => !points(c));
    if (harmless.length) return highest(harmless);
  }
  const queen = legal.find(isQueenOfSpades);
  if (queen) return queen;
  const bigSpades = legal.filter((c) => c.suit === 'S' && value(c) > 12);
  if (bigSpades.length && queenOut) return highest(bigSpades);
  const hearts = legal.filter((c) => c.suit === 'H');
  if (hearts.length) return highest(hearts);
  return highest(legal);
}
