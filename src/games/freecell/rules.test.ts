import { describe, expect, it } from 'vitest';
import type { Card, Suit } from '../../core/cards';
import { type FreeCellState, applyMove, autoPlay, canMove, isWon, maxMove, newGame, replay, runLength } from './rules';
import { solve } from './solver';

let nextId = 500;
const c = (rank: number, suit: Suit): Card => ({ id: nextId++, rank, suit, faceUp: true });

function board(cascades: Card[][], cells: (Card | null)[] = [null, null, null, null], found = [0, 0, 0, 0]): FreeCellState {
  while (cascades.length < 8) cascades.push([]);
  const suits: Suit[] = ['S', 'H', 'D', 'C'];
  return { seed: 1, cascades, cells, foundations: found.map((n, i) => Array.from({ length: n }, (_, r) => c(r + 1, suits[i]))), moves: 0 };
}

describe('deal', () => {
  it('deals 52 different cards 7,7,7,7,6,6,6,6', () => {
    const s = newGame(9);
    expect(s.cascades.map((col) => col.length)).toEqual([7, 7, 7, 7, 6, 6, 6, 6]);
    expect(new Set(s.cascades.flat().map((x) => `${x.suit}${x.rank}`)).size).toBe(52);
  });
});

describe('moves', () => {
  it('stacks one lower in the other colour only', () => {
    const s = board([[c(9, 'S')], [c(10, 'H')], [c(10, 'C')]]);
    expect(canMove(s, { from: { t: 'col', i: 0 }, to: { t: 'col', i: 1 }, n: 1 })).toBe(true);
    expect(canMove(s, { from: { t: 'col', i: 0 }, to: { t: 'col', i: 2 }, n: 1 })).toBe(false);
  });

  it('moves as many cards together as free cells and empty columns allow', () => {
    const run = [c(9, 'S'), c(8, 'H'), c(7, 'C'), c(6, 'D')];
    const s = board([run, [c(10, 'D')], [c(2, 'C')], [c(3, 'C')], [c(4, 'C')], [c(5, 'C')], [c(6, 'C')], [c(7, 'H')]], [c(12, 'S'), c(12, 'H'), null, null]);
    expect(runLength(s.cascades[0])).toBe(4);
    expect(maxMove(s, false)).toBe(3);
    expect(canMove(s, { from: { t: 'col', i: 0 }, to: { t: 'col', i: 1 }, n: 4 })).toBe(false);
    s.cells[0] = null;
    expect(maxMove(s, false)).toBe(4);
    expect(canMove(s, { from: { t: 'col', i: 0 }, to: { t: 'col', i: 1 }, n: 4 })).toBe(true);
  });

  it('sends safe cards home on its own, but keeps ones still needed', () => {
    const s = board([[c(3, 'H'), c(2, 'S')], [c(1, 'S')]], undefined, [0, 2, 0, 0]);
    autoPlay(s);
    // A♠ and 2♠ go up; 3♥ waits while the black foundations are still low.
    expect(s.foundations[0]).toHaveLength(2);
    expect(s.cascades[0].map((x) => x.rank)).toEqual([3]);
  });
});

describe('solver', () => {
  it('finds a legal, winning line for real deals', () => {
    for (const seed of [11, 22, 33]) {
      const s = newGame(seed);
      autoPlay(s);
      const line = solve(s);
      expect(line).not.toBeNull();
      for (const m of line!) {
        expect(canMove(s, m)).toBe(true);
        applyMove(s, m);
        autoPlay(s);
      }
      expect(isWon(s)).toBe(true);
      // And the game's own replay agrees.
      expect(isWon(replay(seed, line!))).toBe(true);
    }
  }, 30000);
});
