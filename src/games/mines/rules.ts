import { mulberry32, shuffle } from '../../core/cards';

export type MinesLevel = 'easy' | 'medium' | 'hard';

export const SIZES: Record<MinesLevel, { w: number; h: number; mines: number }> = {
  easy: { w: 9, h: 9, mines: 10 },
  medium: { w: 16, h: 16, mines: 40 },
  hard: { w: 30, h: 16, mines: 99 },
};

export interface Cell {
  mine: boolean;
  open: boolean;
  flag: boolean;
  /** Mines among the eight neighbours. */
  n: number;
}

export interface MinesState {
  seed: number;
  level: MinesLevel;
  w: number;
  h: number;
  mines: number;
  cells: Cell[];
  /** Mines are laid on the first reveal, so the first tap is always safe. */
  placed: boolean;
  /** Index of the mine that went off. */
  lost: number | null;
  won: boolean;
}

export function newGame(seed: number, level: MinesLevel): MinesState {
  const { w, h, mines } = SIZES[level];
  return {
    seed,
    level,
    w,
    h,
    mines,
    cells: Array.from({ length: w * h }, () => ({ mine: false, open: false, flag: false, n: 0 })),
    placed: false,
    lost: null,
    won: false,
  };
}

export function neighbours(s: MinesState, i: number): number[] {
  const x = i % s.w;
  const y = Math.floor(i / s.w);
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < s.w && ny < s.h) out.push(ny * s.w + nx);
    }
  return out;
}

/** Lay mines anywhere except the first tap and its neighbours, so it always opens an area. */
function place(s: MinesState, safe: number) {
  const keepClear = new Set([safe, ...neighbours(s, safe)]);
  const spots = shuffle(
    s.cells.map((_, i) => i).filter((i) => !keepClear.has(i)),
    mulberry32(s.seed),
  ).slice(0, s.mines);
  for (const i of spots) s.cells[i].mine = true;
  s.cells.forEach((c, i) => (c.n = neighbours(s, i).filter((j) => s.cells[j].mine).length));
  s.placed = true;
}

const over = (s: MinesState) => s.lost !== null || s.won;

/**
 * Open a cell (flood-filling from blanks). Returns the cells opened, each with its distance
 * from where the player tapped, so they can ripple open in order.
 */
export function reveal(s: MinesState, start: number): { i: number; d: number }[] {
  if (over(s)) return [];
  const first = s.cells[start];
  if (first.open || first.flag) return [];
  if (!s.placed) place(s, start);
  if (first.mine) {
    first.open = true;
    s.lost = start;
    return [{ i: start, d: 0 }];
  }
  const opened: { i: number; d: number }[] = [];
  const queue: { i: number; d: number }[] = [{ i: start, d: 0 }];
  first.open = true;
  while (queue.length) {
    const cur = queue.shift()!;
    opened.push(cur);
    if (s.cells[cur.i].n) continue;
    for (const j of neighbours(s, cur.i)) {
      const c = s.cells[j];
      if (c.open || c.flag || c.mine) continue;
      c.open = true;
      queue.push({ i: j, d: cur.d + 1 });
    }
  }
  checkWin(s);
  return opened;
}

/** Tap on a number whose flags are all placed: open every other neighbour. */
export function chord(s: MinesState, i: number): { i: number; d: number }[] {
  const c = s.cells[i];
  if (over(s) || !c.open || !c.n) return [];
  const around = neighbours(s, i);
  if (around.filter((j) => s.cells[j].flag).length !== c.n) return [];
  const opened: { i: number; d: number }[] = [];
  for (const j of around) {
    const n = s.cells[j];
    if (n.open || n.flag) continue;
    for (const o of reveal(s, j)) opened.push({ i: o.i, d: o.d + 1 });
    if (s.lost !== null) break;
  }
  return opened;
}

export function toggleFlag(s: MinesState, i: number): boolean {
  const c = s.cells[i];
  if (over(s) || c.open) return false;
  c.flag = !c.flag;
  return true;
}

function checkWin(s: MinesState) {
  if (s.lost !== null) return;
  const hidden = s.cells.filter((c) => !c.open).length;
  if (hidden === s.mines) {
    s.won = true;
    s.cells.forEach((c) => c.mine && (c.flag = true));
  }
}

export const flagsLeft = (s: MinesState) => s.mines - s.cells.filter((c) => c.flag).length;

/**
 * A cell that is certainly safe given what's showing (the classic single-number rule: a
 * number whose flags are complete makes its other neighbours safe; a number whose hidden
 * neighbours all must be mines makes them mines, which can complete other numbers).
 * Returns null when nothing is certain and the player has to guess.
 */
export function safeCell(s: MinesState): number | null {
  if (!s.placed) return Math.floor(s.cells.length / 2);
  // Deduce mines from the numbers alone (never from the player's flags, which may be wrong),
  // then look for a safe cell.
  const known = new Set<number>();
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    s.cells.forEach((c, i) => {
      if (!c.open || !c.n) return;
      const hidden = neighbours(s, i).filter((j) => !s.cells[j].open);
      if (hidden.length === c.n) for (const j of hidden) if (!known.has(j)) (known.add(j), (changed = true));
    });
    if (!changed) break;
  }
  for (let i = 0; i < s.cells.length; i++) {
    const c = s.cells[i];
    if (!c.open || !c.n) continue;
    const hidden = neighbours(s, i).filter((j) => !s.cells[j].open);
    const mines = hidden.filter((j) => known.has(j)).length;
    if (mines === c.n) {
      const safe = hidden.find((j) => !known.has(j) && !s.cells[j].flag);
      if (safe !== undefined) return safe;
    }
  }
  return null;
}
