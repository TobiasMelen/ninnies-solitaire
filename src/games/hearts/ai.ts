import { type Card, mulberry32, shuffle } from '../../core/cards';
import {
  type HeartsState,
  type Seat,
  SEATS,
  handPoints,
  isQueenOfSpades,
  legalPlays,
  passTarget,
  playCard,
  playedCards,
  points,
  trickPoints,
  value,
  winnerOf,
} from './rules';

/**
 * Hearts AI. Every level shares the classic rules of thumb (pass away the Q♠/A♠/K♠ and high
 * hearts, void short suits, duck under the current winner, dump the Q♠ on a higher spade, lead
 * low spades to flush the queen). Weaker levels sometimes play a random legal card and rarely
 * notice a moon shot. The sharp level also thinks ahead: it imagines where the unseen cards
 * might be, plays the hand out for each card it could play, and picks the best on average.
 */
export interface Skill {
  /** Chance of a random legal play instead of the considered one. */
  mistakes: number;
  /** Chance per decision of noticing (and trying to stop) a moon shot. */
  moonAwareness: number;
  /** How many imagined layouts of the unseen cards to play out per decision (0: none). */
  samples: number;
}

export const EASY: Skill = { mistakes: 0.2, moonAwareness: 0.2, samples: 0 };
export const STEADY: Skill = { mistakes: 0.04, moonAwareness: 0.6, samples: 0 };
export const SHARP: Skill = { mistakes: 0, moonAwareness: 1, samples: 30 };
/** Used for the player's hints. */
export const ADVISOR: Skill = { mistakes: 0, moonAwareness: 1, samples: 40 };
/** How imagined hands are played out. */
const PLAYOUT: Skill = { mistakes: 0, moonAwareness: 1, samples: 0 };

const LEVELS = [EASY, STEADY, SHARP];
/** Each opponent's level is drawn from the game's seed: random per game, the same on resume. */
export const skillFor = (seed: number, seat: Seat): Skill =>
  LEVELS[Math.floor(mulberry32((seed ^ Math.imul(seat, 0x9e3779b1)) >>> 0)() * LEVELS.length)];

const pick = <T>(xs: T[], rand: () => number) => xs[Math.floor(rand() * xs.length)];
const highest = (cs: Card[]) => cs.reduce((a, b) => (value(b) > value(a) ? b : a));
const lowest = (cs: Card[]) => cs.reduce((a, b) => (value(b) < value(a) ? b : a));

/** Choose three cards to pass: the most dangerous first, with a nudge toward voiding short suits. */
export function choosePassCards(hand: Card[], rand: () => number, skill: Skill = STEADY): Card[] {
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

export function chooseCard(s: HeartsState, seat: Seat, rand: () => number, skill: Skill = STEADY): Card {
  const legal = legalPlays(s, seat);
  if (legal.length === 1) return legal[0];
  if (rand() < skill.mistakes) return pick(legal, rand);
  return skill.samples ? lookAhead(s, seat, legal, rand, skill.samples) : byRules(s, seat, legal, rand, skill);
}

/**
 * One way the cards `seat` can't see might be dealt among the other players. Respects what the
 * seat knows: how many cards each player holds, suits they've shown out of, and the cards it
 * passed (still with whoever received them until played).
 */
function imagine(s: HeartsState, seat: Seat, rand: () => number): HeartsState {
  const others = SEATS.filter((x) => x !== seat);
  const unseen = others.flatMap((x) => s.hands[x]);
  const passed = new Set(s.passDir !== 'none' ? (s.passes[seat] ?? []).map((c) => c.id) : []);
  const receiver = passTarget(s, seat);
  const allowed = (c: Card) =>
    passed.has(c.id) ? [receiver] : others.filter((x) => !(s.voids?.[x] ?? '').includes(c.suit));
  let hands: Card[][] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const strict = attempt < 29;
    hands = SEATS.map((x) => (x === seat ? s.hands[seat].slice() : []));
    // Most constrained cards first, so they still find room.
    const order = shuffle(unseen.slice(), rand)
      .map((c) => ({ c, seats: strict ? allowed(c) : others }))
      .sort((a, b) => a.seats.length - b.seats.length);
    const dealt = order.every(({ c, seats }) => {
      const room = seats.filter((x) => hands[x].length < s.hands[x].length);
      if (!room.length) return false;
      // Weighted by space left, which keeps the deal close to uniform.
      let r = rand() * room.reduce<number>((n, x) => n + s.hands[x].length - hands[x].length, 0);
      const to = room.find((x) => (r -= s.hands[x].length - hands[x].length) < 0) ?? room[room.length - 1];
      hands[to].push(c);
      return true;
    });
    if (dealt) break;
  }
  return { ...s, hands };
}

/** Copy enough of a state to play the hand out on it. */
const fork = (s: HeartsState): HeartsState => ({
  ...s,
  hands: s.hands.map((h) => h.slice()),
  trick: s.trick.slice(),
  taken: s.taken.map((t) => t.slice()),
  voids: s.voids?.slice(),
  scores: s.scores.slice(),
  history: s.history.slice(),
});

/** Try each legal card against imagined layouts of the unseen cards; keep the best on average. */
function lookAhead(s: HeartsState, seat: Seat, legal: Card[], rand: () => number, samples: number): Card {
  const totals = legal.map(() => 0);
  for (let i = 0; i < samples; i++) {
    const world = imagine(s, seat, rand);
    legal.forEach((card, k) => {
      const w = fork(world);
      playCard(w, seat, card);
      while (w.phase === 'play') {
        const turn = w.turn;
        const options = legalPlays(w, turn);
        playCard(w, turn, options.length === 1 ? options[0] : byRules(w, turn, options, rand, PLAYOUT));
      }
      const pts = handPoints(w).points;
      // Own points against the others' average, so shooting the moon counts as a win.
      totals[k] += pts[seat] - (pts.reduce((a, b) => a + b, 0) - pts[seat]) / 3;
    });
  }
  let best = 0;
  totals.forEach((t, k) => t < totals[best] && (best = k));
  return legal[best];
}

/** The considered play by rules of thumb alone. */
function byRules(s: HeartsState, seat: Seat, legal: Card[], rand: () => number, skill: Skill): Card {

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
