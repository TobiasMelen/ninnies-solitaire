import { type FreeCellState, type Loc, type Move, CASCADES, CELLS, FOUND_SUITS } from './rules';

/**
 * FreeCell solver for the Hint Bunny. Every card is face up, so it can solve the actual deal:
 * a best-first search over positions (each player move followed by the automatic moves home),
 * guided by how much is left to do and how deeply the next cards needed are buried.
 *
 * Cards are numbers here: rank + 16 × suit (suit in FOUND_SUITS order), 0 for "none".
 */

type Pos = {
  cols: number[][];
  cells: number[];
  /** Top rank on each foundation. */
  found: number[];
};

interface Node {
  pos: Pos;
  g: number;
  f: number;
  parent: Node | null;
  move: Move | null;
}

const rank = (c: number) => c & 15;
const suit = (c: number) => c >> 4;
const red = (c: number) => suit(c) === 1 || suit(c) === 2;
const stacks = (a: number, b: number) => rank(b) === rank(a) + 1 && red(a) !== red(b);

function fromState(s: FreeCellState): Pos {
  const code = (c: { rank: number; suit: string }) => c.rank + 16 * FOUND_SUITS.indexOf(c.suit as never);
  return {
    cols: s.cascades.map((col) => col.map(code)),
    cells: s.cells.map((c) => (c ? code(c) : 0)),
    found: s.foundations.map((f) => f.length),
  };
}

const clone = (p: Pos): Pos => ({ cols: p.cols.map((c) => c.slice()), cells: p.cells.slice(), found: p.found.slice() });

/** Same rule as rules.autoPlay: aces and twos, or both other-colour piles at most one behind. */
function safeUp(p: Pos, c: number) {
  const r = rank(c);
  if (p.found[suit(c)] !== r - 1) return false;
  if (r <= 2) return true;
  const isRed = red(c);
  for (let s = 0; s < 4; s++) if ((s === 1 || s === 2) !== isRed && p.found[s] < r - 1) return false;
  return true;
}

function autoPlay(p: Pos) {
  for (let again = true; again; ) {
    again = false;
    for (let i = 0; i < CELLS; i++) {
      const c = p.cells[i];
      if (c && safeUp(p, c)) (p.found[suit(c)]++, (p.cells[i] = 0), (again = true));
    }
    for (const col of p.cols) {
      const c = col[col.length - 1];
      if (c && safeUp(p, c)) (p.found[suit(c)]++, col.pop(), (again = true));
    }
  }
}

function runLength(col: number[]) {
  let n = col.length ? 1 : 0;
  while (n < col.length && stacks(col[col.length - n], col[col.length - n - 1])) n++;
  return n;
}

function maxMove(p: Pos, toEmpty: boolean) {
  let cells = 0;
  for (const c of p.cells) if (!c) cells++;
  let empties = toEmpty ? -1 : 0;
  for (const col of p.cols) if (!col.length) empties++;
  return (cells + 1) * 2 ** Math.max(0, empties);
}

function keyOf(p: Pos) {
  // Free cells and columns are interchangeable, so equal layouts in another order are one position.
  const cells = p.cells.filter(Boolean).sort((a, b) => a - b).join(',');
  const cols = p.cols.map((c) => c.join(',')).sort().join('|');
  return `${cells}/${cols}`;
}

/** Estimated work left: cards still out, plus how deep the next card of each suit is buried. */
function estimate(p: Pos) {
  let left = 52;
  for (const f of p.found) left -= f;
  let buried = 0;
  for (let s = 0; s < 4; s++) {
    const next = p.found[s] + 1 + 16 * s;
    if (p.found[s] === 13) continue;
    for (const col of p.cols) {
      const at = col.indexOf(next);
      if (at >= 0) {
        buried += col.length - 1 - at;
        break;
      }
    }
  }
  let full = 0;
  for (const c of p.cells) if (c) full++;
  let empty = 0;
  for (const col of p.cols) if (!col.length) empty++;
  return left + buried * 1.5 + full * 0.5 - empty;
}

function* movesOf(p: Pos): Generator<Move> {
  const firstEmpty = p.cols.findIndex((c) => !c.length);
  const firstCell = p.cells.indexOf(0);
  for (let i = 0; i < CASCADES; i++) {
    const col = p.cols[i];
    if (!col.length) continue;
    const top = col[col.length - 1];
    const from: Loc = { t: 'col', i };
    if (p.found[suit(top)] === rank(top) - 1) yield { from, to: { t: 'found', i: suit(top) }, n: 1 };
    const run = runLength(col);
    for (let j = 0; j < CASCADES; j++) {
      if (j === i) continue;
      const dest = p.cols[j];
      if (!dest.length) {
        if (j !== firstEmpty) continue;
        const most = Math.min(run, maxMove(p, true), col.length - 1);
        for (let n = most; n >= 1; n--) yield { from, to: { t: 'col', i: j }, n };
        continue;
      }
      const n = rank(dest[dest.length - 1]) - rank(top);
      if (n >= 1 && n <= run && stacks(col[col.length - n], dest[dest.length - 1]) && n <= maxMove(p, false)) {
        yield { from, to: { t: 'col', i: j }, n };
      }
    }
    if (firstCell >= 0) yield { from, to: { t: 'cell', i: firstCell }, n: 1 };
  }
  for (let i = 0; i < CELLS; i++) {
    const c = p.cells[i];
    if (!c) continue;
    const from: Loc = { t: 'cell', i };
    if (p.found[suit(c)] === rank(c) - 1) yield { from, to: { t: 'found', i: suit(c) }, n: 1 };
    for (let j = 0; j < CASCADES; j++) {
      const dest = p.cols[j];
      if (!dest.length ? j === firstEmpty : stacks(c, dest[dest.length - 1])) yield { from, to: { t: 'col', i: j }, n: 1 };
    }
  }
}

function apply(p: Pos, m: Move): Pos {
  const q = clone(p);
  let cards: number[];
  if (m.from.t === 'col') cards = q.cols[m.from.i].splice(-m.n);
  else (cards = [q.cells[m.from.i]]), (q.cells[m.from.i] = 0);
  if (m.to.t === 'col') q.cols[m.to.i].push(...cards);
  else if (m.to.t === 'cell') q.cells[m.to.i] = cards[0];
  else q.found[m.to.i]++;
  autoPlay(q);
  return q;
}

/** Binary min-heap on f. */
class Heap {
  private a: Node[] = [];
  get size() {
    return this.a.length;
  }
  push(n: Node) {
    const a = this.a;
    a.push(n);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): Node {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Weight of moves made so far against the estimate: low finds solutions fast, high finds short ones. */
const PATH_WEIGHT = 0.4;

/**
 * Solves the position: the player's moves (each followed by the automatic ones) that win, or
 * null if none was found within `budget` positions.
 */
export function solve(s: FreeCellState, budget = 150_000): Move[] | null {
  const start = fromState(s);
  autoPlay(start);
  const seen = new Set<string>([keyOf(start)]);
  const open = new Heap();
  open.push({ pos: start, g: 0, f: estimate(start), parent: null, move: null });
  while (open.size && budget-- > 0) {
    const n = open.pop();
    if (n.pos.found.every((f) => f === 13)) {
      const line: Move[] = [];
      for (let x: Node | null = n; x?.move; x = x.parent) line.unshift(x.move);
      return line;
    }
    for (const m of movesOf(n.pos)) {
      const pos = apply(n.pos, m);
      const key = keyOf(pos);
      if (seen.has(key)) continue;
      seen.add(key);
      const g = n.g + 1;
      open.push({ pos, g, f: estimate(pos) + g * PATH_WEIGHT, parent: n, move: m });
    }
  }
  return null;
}
