import { type Card, type Suit, mulberry32, shuffle } from '../../core/cards';

export type SuitCount = 1 | 2 | 4;

export const COLUMNS = 10;
export const RUNS_TO_WIN = 8;

export interface SpiderState {
  seed: number;
  suitCount: SuitCount;
  columns: Card[][];
  /** Last element is dealt first. */
  stock: Card[];
  /** Completed K→A runs, each stored A…K so the King is on top. */
  foundations: Card[][];
  moves: number;
  score: number;
}

export type Action = { t: 'move'; from: number; index: number; to: number } | { t: 'deal' };

export interface Completion {
  col: number;
  ids: number[];
  flipped: number | null;
}

export interface Move {
  from: number;
  index: number;
  to: number;
  priority: number;
}

const SUITS_FOR: Record<SuitCount, Suit[]> = {
  1: ['S'],
  2: ['S', 'H'],
  4: ['S', 'H', 'D', 'C'],
};

export function newGame(seed: number, suitCount: SuitCount): SpiderState {
  const suits = SUITS_FOR[suitCount];
  const cards: Card[] = [];
  let id = 0;
  for (let set = 0; set < 8; set++) {
    const suit = suits[set % suits.length];
    for (let rank = 1; rank <= 13; rank++) cards.push({ id: id++, suit, rank, faceUp: false });
  }
  shuffle(cards, mulberry32(seed));

  const columns: Card[][] = [];
  for (let c = 0; c < COLUMNS; c++) {
    const n = c < 4 ? 6 : 5;
    const col = cards.splice(0, n);
    col[n - 1].faceUp = true;
    columns.push(col);
  }
  return { seed, suitCount, columns, stock: cards, foundations: [], moves: 0, score: 500 };
}

/** Index where the movable same-suit descending run at the bottom of a column starts. */
export function runStart(col: Card[]): number {
  let i = col.length - 1;
  if (i < 0) return 0;
  if (!col[i].faceUp) return col.length;
  while (i > 0 && col[i - 1].faceUp && col[i - 1].suit === col[i].suit && col[i - 1].rank === col[i].rank + 1) i--;
  return i;
}

export const canPickUp = (s: SpiderState, from: number, index: number) => {
  const col = s.columns[from];
  return index < col.length && index >= runStart(col);
};

export function canMove(s: SpiderState, from: number, index: number, to: number): boolean {
  if (from === to || !canPickUp(s, from, index)) return false;
  const dest = s.columns[to];
  if (!dest.length) return true;
  return dest[dest.length - 1].rank === s.columns[from][index].rank + 1;
}

export type DealBlock = 'empty-stock' | 'empty-column' | null;

/** Classic rules forbid dealing while a column is empty; `allowEmpty` relaxes that. */
export function dealBlocked(s: SpiderState, allowEmpty = false): DealBlock {
  if (!s.stock.length) return 'empty-stock';
  if (!allowEmpty && s.columns.some((c) => !c.length)) return 'empty-column';
  return null;
}

function flipTop(col: Card[]): number | null {
  const top = col[col.length - 1];
  if (top && !top.faceUp) {
    top.faceUp = true;
    return top.id;
  }
  return null;
}

/**
 * Mutates state. Returns the id of a card that was turned face up by the move, if any.
 * Completed runs are not removed here; call completeRuns() afterwards (the UI waits a beat
 * so the player sees the card land before the run flies off).
 */
export function applyAction(s: SpiderState, a: Action): number[] {
  s.moves++;
  s.score = Math.max(0, s.score - 1);
  if (a.t === 'deal') {
    const dealt: number[] = [];
    for (const col of s.columns) {
      const card = s.stock.pop();
      if (!card) break;
      card.faceUp = true;
      col.push(card);
      dealt.push(card.id);
    }
    return dealt;
  }
  const run = s.columns[a.from].splice(a.index);
  s.columns[a.to].push(...run);
  const flipped = flipTop(s.columns[a.from]);
  return flipped === null ? [] : [flipped];
}

export function completeRuns(s: SpiderState): Completion[] {
  const out: Completion[] = [];
  s.columns.forEach((col, c) => {
    if (col.length < 13) return;
    const tail = col.slice(-13);
    const suit = tail[12].suit;
    const ok = tail.every((card, i) => card.faceUp && card.suit === suit && card.rank === 13 - i);
    if (!ok) return;
    col.splice(-13);
    s.foundations.push(tail.reverse());
    s.score += 100;
    out.push({ col: c, ids: tail.map((x) => x.id), flipped: flipTop(col) });
  });
  return out;
}

export const isWon = (s: SpiderState) => s.foundations.length === RUNS_TO_WIN;

export function replay(seed: number, suitCount: SuitCount, actions: Action[]): SpiderState {
  const s = newGame(seed, suitCount);
  for (const a of actions) {
    if (a.t === 'move' ? !canMove(s, a.from, a.index, a.to) : dealBlocked(s, true)) throw new Error('Invalid action in history');
    applyAction(s, a);
    completeRuns(s);
  }
  return s;
}

const sameSuitRunLength = (col: Card[]) => col.length - runStart(col);

/**
 * Moves that make progress. Pointless shuffles (e.g. moving a run between two equivalent
 * parents) are excluded so this doubles as "is the player stuck?" detection.
 */
export function findMoves(s: SpiderState): Move[] {
  const out: Move[] = [];
  const cols = s.columns;
  const firstEmpty = cols.findIndex((c) => !c.length);

  cols.forEach((col, from) => {
    if (!col.length) return;
    const rs = runStart(col);
    const runLen = col.length - rs;
    for (let i = rs; i < col.length; i++) {
      const card = col[i];
      const parent: Card | undefined = col[i - 1];
      const moved = col.length - i;

      if (firstEmpty >= 0 && i === rs && i > 0) {
        out.push({ from, index: i, to: firstEmpty, priority: parent.faceUp ? 5 : 25 });
      }

      cols.forEach((dest, to) => {
        if (to === from || !dest.length) return;
        const top = dest[dest.length - 1];
        if (top.rank !== card.rank + 1) return;
        const same = top.suit === card.suit;
        const destRun = same ? sameSuitRunLength(dest) : 0;
        let p = -1;
        if (i === 0) p = 60; // empties a column
        else if (!parent.faceUp) p = 50; // reveals a card
        else if (parent.rank !== card.rank + 1) p = 30; // frees the card underneath
        else if (parent.suit !== card.suit) p = same ? 40 : -1; // only worth it to build in suit
        else p = same && destRun + moved > runLen ? 45 : -1; // splitting a run must grow a longer one
        if (p < 0) return;
        if (same) p += 8;
        if (same && destRun + moved >= 13) p = 100;
        out.push({ from, index: i, to, priority: p });
      });
    }
  });

  return out.sort((a, b) => b.priority - a.priority);
}

/** Where a tapped run should go: same suit first, then any legal card, then an empty column. */
export function bestTarget(s: SpiderState, from: number, index: number): number | null {
  if (!canPickUp(s, from, index)) return null;
  const card = s.columns[from][index];
  let best: number | null = null;
  let bestScore = -Infinity;
  s.columns.forEach((dest, to) => {
    if (!canMove(s, from, index, to)) return;
    let score: number;
    if (!dest.length) {
      if (index === 0) return; // moving a whole column to an empty one does nothing
      score = 100;
    } else if (dest[dest.length - 1].suit === card.suit) {
      score = 300 + sameSuitRunLength(dest);
    } else {
      score = 200;
    }
    score -= Math.abs(to - from) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = to;
    }
  });
  return best;
}
