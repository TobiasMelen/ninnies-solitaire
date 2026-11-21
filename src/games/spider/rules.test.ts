import { describe, expect, it } from 'vitest';
import type { Card, Suit } from '../../core/cards';
import {
  applyAction,
  bestTarget,
  canMove,
  completeRuns,
  dealBlocked,
  findMoves,
  isWon,
  freshMoves,
  newGame,
  positionKey,
  replay,
  runStart,
  type SpiderState,
} from './rules';

let nextId = 1000;
const c = (rank: number, suit: Suit = 'S', faceUp = true): Card => ({ id: nextId++, rank, suit, faceUp });

function board(columns: Card[][], stock: Card[] = []): SpiderState {
  while (columns.length < 10) columns.push([]);
  return { seed: 1, suitCount: 4, columns, stock, foundations: [], moves: 0, score: 500 };
}

describe('newGame', () => {
  it('deals 54 cards in 6/6/6/6/5… and leaves 50 in stock', () => {
    const s = newGame(42, 4);
    expect(s.columns.map((col) => col.length)).toEqual([6, 6, 6, 6, 5, 5, 5, 5, 5, 5]);
    expect(s.stock).toHaveLength(50);
    for (const col of s.columns) {
      expect(col.at(-1)!.faceUp).toBe(true);
      expect(col.slice(0, -1).every((x) => !x.faceUp)).toBe(true);
    }
  });

  it('is deterministic per seed and uses the right suits', () => {
    expect(newGame(7, 2)).toEqual(newGame(7, 2));
    const suits = new Set([...newGame(7, 1).stock].map((x) => x.suit));
    expect([...suits]).toEqual(['S']);
  });
});

describe('moves', () => {
  it('only lets same-suit descending runs be picked up', () => {
    const col = [c(9, 'S', false), c(8, 'H'), c(7, 'S'), c(6, 'S')];
    expect(runStart(col)).toBe(2);
  });

  it('allows dropping on rank+1 of any suit and on empty columns', () => {
    const s = board([[c(5, 'S')], [c(6, 'H')], [c(7, 'D')]]);
    expect(canMove(s, 0, 0, 1)).toBe(true);
    expect(canMove(s, 0, 0, 2)).toBe(false);
    expect(canMove(s, 0, 0, 5)).toBe(true);
  });

  it('flips the uncovered card', () => {
    const hidden = c(2, 'S', false);
    const s = board([[hidden, c(5, 'S')], [c(6, 'H')]]);
    expect(applyAction(s, { t: 'move', from: 0, index: 1, to: 1 })).toEqual([hidden.id]);
    expect(hidden.faceUp).toBe(true);
  });

  it('removes a completed K→A run and scores it', () => {
    const run = Array.from({ length: 12 }, (_, i) => c(13 - i, 'H'));
    const s = board([[c(3, 'S', false), ...run], [c(1, 'H')]]);
    applyAction(s, { t: 'move', from: 1, index: 0, to: 0 });
    const done = completeRuns(s);
    expect(done).toHaveLength(1);
    expect(s.foundations[0].at(-1)!.rank).toBe(13);
    expect(s.columns[0]).toHaveLength(1);
    expect(s.columns[0][0].faceUp).toBe(true);
    expect(s.score).toBe(599);
  });

  it('blocks dealing onto an empty column', () => {
    const s = board([[c(5)]], [c(1), c(2)]);
    expect(dealBlocked(s)).toBe('empty-column');
    expect(dealBlocked(s, true)).toBeNull();
  });
});

describe('findMoves', () => {
  it('reports no moves when nothing can make progress', () => {
    const cols = Array.from({ length: 10 }, (_, i) => [c(1 + (i % 2) * 6, 'S')]);
    // Aces and sevens alone: nothing fits anywhere and no empty columns.
    expect(findMoves(board(cols))).toEqual([]);
  });

  it('ignores shuffling a card between two equivalent parents', () => {
    const s = board([
      [c(9, 'H'), c(8, 'S')],
      [c(9, 'D')],
      ...Array.from({ length: 8 }, () => [c(1, 'C')]),
    ]);
    expect(findMoves(s)).toEqual([]);
  });

  it('prefers same-suit builds and completing runs', () => {
    const s = board([[c(4, 'S', false), c(8, 'H')], [c(9, 'D')], [c(9, 'H')], ...Array.from({ length: 7 }, () => [c(1, 'C')])]);
    const [top] = findMoves(s);
    expect(top).toMatchObject({ from: 0, index: 1, to: 2 });
    expect(bestTarget(s, 0, 1)).toBe(2);
  });
});

describe('replay', () => {
  it('reproduces state from seed + actions', () => {
    const s = newGame(3, 1);
    applyAction(s, { t: 'deal' });
    completeRuns(s);
    expect(replay(3, 1, [{ t: 'deal' }])).toEqual(s);
  });
});

describe('freshMoves', () => {
  it('never offers a move back to a position reached since the last deal', () => {
    // A run that can sit on either of two equal parents is the classic back-and-forth.
    const s = board([[c(9), c(5, 'H')], [c(9, 'D'), c(6, 'S')], [c(6, 'C')]]);
    const seen = new Set([positionKey(s)]);
    expect(findMoves(s).length).toBeGreaterThan(0);
    const first = freshMoves(s, seen)[0];
    applyAction(s, { t: 'move', ...first });
    seen.add(positionKey(s));
    expect(freshMoves(s, seen).some((m) => m.to === first.from)).toBe(false);
  });

  it('following the hint plays a 2-suit game to the end without looping', () => {
    const s = newGame(15838, 2);
    let seen = new Set([positionKey(s)]);
    let steps = 0;
    for (; steps < 1500 && !isWon(s); steps++) {
      const m = freshMoves(s, seen)[0];
      if (!m && dealBlocked(s, true)) break;
      const a = m ? ({ t: 'move', from: m.from, index: m.index, to: m.to } as const) : ({ t: 'deal' } as const);
      applyAction(s, a);
      completeRuns(s);
      if (a.t === 'deal') seen = new Set();
      seen.add(positionKey(s));
    }
    expect(steps).toBeLessThan(1500);
  });
});
