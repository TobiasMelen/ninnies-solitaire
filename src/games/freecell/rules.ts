import { type Card, type Suit, mulberry32, shuffle } from '../../core/cards';

export const CASCADES = 8;
export const CELLS = 4;
/** Foundation piles, one per suit, in this order. */
export const FOUND_SUITS: Suit[] = ['S', 'H', 'D', 'C'];

export interface FreeCellState {
  seed: number;
  cascades: Card[][];
  cells: (Card | null)[];
  /** Built Ace up to King, one pile per suit (see FOUND_SUITS). */
  foundations: Card[][];
  moves: number;
}

export type Loc = { t: 'col'; i: number } | { t: 'cell'; i: number } | { t: 'found'; i: number };

/** Move `n` cards (more than one only between columns) from one place to another. */
export interface Move {
  from: Loc;
  to: Loc;
  n: number;
}

export const isRed = (c: Card) => c.suit === 'H' || c.suit === 'D';
/** `a` may go on `b` in a column: one lower and the other colour. */
export const stacks = (a: Card, b: Card) => b.rank === a.rank + 1 && isRed(a) !== isRed(b);
export const foundFor = (c: Card) => FOUND_SUITS.indexOf(c.suit);

export function newGame(seed: number): FreeCellState {
  const cards: Card[] = [];
  let id = 0;
  for (const suit of FOUND_SUITS) for (let rank = 1; rank <= 13; rank++) cards.push({ id: id++, suit, rank, faceUp: true });
  shuffle(cards, mulberry32(seed));
  const cascades: Card[][] = Array.from({ length: CASCADES }, () => []);
  cards.forEach((c, i) => cascades[i % CASCADES].push(c));
  return { seed, cascades, cells: Array(CELLS).fill(null), foundations: FOUND_SUITS.map(() => []), moves: 0 };
}

/** Length of the alternating-colour descending run at the bottom of a column. */
export function runLength(col: Card[]): number {
  let n = col.length ? 1 : 0;
  while (n < col.length && stacks(col[col.length - n], col[col.length - n - 1])) n++;
  return n;
}

/**
 * How many cards can move together: one per free cell plus one, doubled for each empty column
 * (as if moved one at a time through them). An empty destination column doesn't count.
 */
export function maxMove(s: FreeCellState, toEmpty: boolean): number {
  const cells = s.cells.filter((c) => !c).length;
  const empties = s.cascades.filter((c) => !c.length).length - (toEmpty ? 1 : 0);
  return (cells + 1) * 2 ** Math.max(0, empties);
}

/** The card(s) a move would pick up. */
export function picked(s: FreeCellState, from: Loc, n: number): Card[] {
  if (from.t === 'col') return s.cascades[from.i].slice(-n);
  if (from.t === 'cell') return s.cells[from.i] ? [s.cells[from.i]!] : [];
  const pile = s.foundations[from.i];
  return pile.length ? [pile[pile.length - 1]] : [];
}

export function canMove(s: FreeCellState, m: Move): boolean {
  const { from, to, n } = m;
  if (n < 1 || (from.t === to.t && from.i === to.i)) return false;
  if (from.t === 'found') return false;
  const cards = picked(s, from, n);
  if (cards.length !== n) return false;
  if (from.t === 'col' && n > runLength(s.cascades[from.i])) return false;
  const lead = cards[0];
  if (to.t === 'found') return n === 1 && foundFor(lead) === to.i && s.foundations[to.i].length === lead.rank - 1;
  if (to.t === 'cell') return n === 1 && !s.cells[to.i];
  const dest = s.cascades[to.i];
  if (dest.length && !stacks(lead, dest[dest.length - 1])) return false;
  return n <= maxMove(s, !dest.length);
}

/** Mutates the state. Doesn't validate; call canMove first. */
export function applyMove(s: FreeCellState, m: Move) {
  let cards: Card[];
  if (m.from.t === 'col') cards = s.cascades[m.from.i].splice(-m.n);
  else if (m.from.t === 'cell') (cards = [s.cells[m.from.i]!]), (s.cells[m.from.i] = null);
  else cards = [s.foundations[m.from.i].pop()!];
  if (m.to.t === 'col') s.cascades[m.to.i].push(...cards);
  else if (m.to.t === 'cell') s.cells[m.to.i] = cards[0];
  else s.foundations[m.to.i].push(cards[0]);
  s.moves++;
}

/**
 * A card that can go to its foundation and will never be needed in a column: twos and aces
 * always, others once both foundations of the other colour are at most one rank behind.
 */
function safeUp(s: FreeCellState, c: Card) {
  if (s.foundations[foundFor(c)].length !== c.rank - 1) return false;
  if (c.rank <= 2) return true;
  const other = FOUND_SUITS.filter((suit) => (suit === 'H' || suit === 'D') !== isRed(c));
  return other.every((suit) => s.foundations[FOUND_SUITS.indexOf(suit)].length >= c.rank - 1);
}

/** Sends every safe card up to the foundations; returns those moves (applied). */
export function autoPlay(s: FreeCellState): Move[] {
  const done: Move[] = [];
  for (let again = true; again; ) {
    again = false;
    const sources: Loc[] = [
      ...s.cells.map((_, i) => ({ t: 'cell' as const, i })),
      ...s.cascades.map((_, i) => ({ t: 'col' as const, i })),
    ];
    for (const from of sources) {
      const c = picked(s, from, 1)[0];
      if (!c || !safeUp(s, c)) continue;
      const m: Move = { from, to: { t: 'found', i: foundFor(c) }, n: 1 };
      applyMove(s, m);
      s.moves--; // automatic moves don't count against the player
      done.push(m);
      again = true;
    }
  }
  return done;
}

export const isWon = (s: FreeCellState) => s.foundations.every((f) => f.length === 13);

/** Replays the player's moves (each followed by the automatic ones) from the deal. */
export function replay(seed: number, moves: Move[]): FreeCellState {
  const s = newGame(seed);
  autoPlay(s);
  for (const m of moves) {
    if (!canMove(s, m)) throw new Error('Invalid move in history');
    applyMove(s, m);
    autoPlay(s);
  }
  return s;
}

/** Every legal move, without pointless ones (moving a whole column to an empty one, cell to cell). */
export function legalMoves(s: FreeCellState): Move[] {
  const out: Move[] = [];
  const firstEmpty = s.cascades.findIndex((c) => !c.length);
  const firstCell = s.cells.findIndex((c) => !c);
  s.cascades.forEach((col, i) => {
    if (!col.length) return;
    const from: Loc = { t: 'col', i };
    const top = col[col.length - 1];
    if (s.foundations[foundFor(top)].length === top.rank - 1) out.push({ from, to: { t: 'found', i: foundFor(top) }, n: 1 });
    if (firstCell >= 0) out.push({ from, to: { t: 'cell', i: firstCell }, n: 1 });
    const run = runLength(col);
    s.cascades.forEach((dest, j) => {
      if (j === i) return;
      if (!dest.length) {
        if (j !== firstEmpty) return;
        // Any tail of the run may go to an empty column, but not the whole column.
        for (let n = 1; n <= Math.min(run, maxMove(s, true)); n++) if (n < col.length) out.push({ from, to: { t: 'col', i: j }, n });
        return;
      }
      // Only one length of the run fits a given card.
      const target = dest[dest.length - 1];
      const n = target.rank - col[col.length - 1].rank;
      if (n >= 1 && n <= run && stacks(col[col.length - n], target) && n <= maxMove(s, false)) out.push({ from, to: { t: 'col', i: j }, n });
    });
  });
  s.cells.forEach((c, i) => {
    if (!c) return;
    const from: Loc = { t: 'cell', i };
    if (s.foundations[foundFor(c)].length === c.rank - 1) out.push({ from, to: { t: 'found', i: foundFor(c) }, n: 1 });
    s.cascades.forEach((dest, j) => {
      if (!dest.length ? j === firstEmpty : stacks(c, dest[dest.length - 1])) out.push({ from, to: { t: 'col', i: j }, n: 1 });
    });
  });
  return out;
}

/** Where a tapped card (with everything below it) should go: home, onto a column, a free cell. */
export function bestTarget(s: FreeCellState, from: Loc, n: number): Loc | null {
  const options = [
    ...(n === 1 ? FOUND_SUITS.map((_, i) => ({ t: 'found' as const, i })) : []),
    ...s.cascades.map((c, i) => ({ loc: { t: 'col' as const, i }, empty: !c.length })).sort((a, b) => Number(a.empty) - Number(b.empty)).map((o) => o.loc),
    ...(n === 1 && from.t !== 'cell' ? s.cells.map((_, i) => ({ t: 'cell' as const, i })) : []),
  ];
  return options.find((to) => canMove(s, { from, to, n })) ?? null;
}
