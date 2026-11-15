import { describe, expect, it } from 'vitest';
import { chord, flagsLeft, neighbours, newGame, reveal, safeCell, toggleFlag } from './rules';

describe('minesweeper', () => {
  it('never puts a mine under or around the first tap, and opens an area', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const s = newGame(seed, 'hard');
      const start = 7 * s.w + 12;
      const opened = reveal(s, start);
      expect(s.lost).toBeNull();
      expect(s.cells.filter((c) => c.mine)).toHaveLength(99);
      for (const j of [start, ...neighbours(s, start)]) expect(s.cells[j].mine).toBe(false);
      expect(opened.length).toBeGreaterThan(1);
      // distances ripple outward from the tap
      expect(opened[0]).toEqual({ i: start, d: 0 });
    }
  });

  it('loses on a mine and wins when only mines are left', () => {
    const s = newGame(3, 'easy');
    reveal(s, 40);
    const mine = s.cells.findIndex((c) => c.mine);
    const t = structuredClone(s);
    reveal(t, mine);
    expect(t.lost).toBe(mine);
    s.cells.forEach((c, i) => !c.mine && reveal(s, i));
    expect(s.won).toBe(true);
    expect(flagsLeft(s)).toBe(0);
  });

  it('chords around a satisfied number', () => {
    const s = newGame(9, 'medium');
    reveal(s, 8 * 16 + 8);
    const num = s.cells.findIndex((c, i) => c.open && c.n === 1 && neighbours(s, i).some((j) => !s.cells[j].open));
    const mine = neighbours(s, num).find((j) => s.cells[j].mine)!;
    toggleFlag(s, mine);
    const before = s.cells.filter((c) => c.open).length;
    chord(s, num);
    expect(s.lost).toBeNull();
    expect(s.cells.filter((c) => c.open).length).toBeGreaterThanOrEqual(before);
  });

  it('only ever suggests cells that are truly safe', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = newGame(seed, 'medium');
      reveal(s, 120);
      for (let k = 0; k < 200 && !s.won; k++) {
        const i = safeCell(s);
        if (i === null) break;
        expect(s.cells[i].mine).toBe(false);
        reveal(s, i);
        expect(s.lost).toBeNull();
      }
    }
  });
});
