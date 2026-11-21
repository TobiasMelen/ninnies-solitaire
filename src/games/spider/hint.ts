import { type SpiderState, dealBlocked } from './rules';

/**
 * The Hint Bunny's planner for Spider.
 *
 * It only uses what the player can see. From the current position it searches the sequences of
 * moves that are possible without new information (a beam search, stopping wherever a face-down
 * card would be turned over), scores each position it reaches, and returns the route to the
 * best one. When nothing reachable is better than the current position, the advice is to deal.
 */

export type Step = { t: 'move'; from: number; index: number; to: number } | { t: 'deal' };

// Cards are rank + 16 × suit, so a suited "one higher" card is simply code + 1.
const SUIT_CODE = { S: 0, H: 1, D: 2, C: 3 } as const;
/** A card about to be turned over: nothing can be planned on it. */
const UNKNOWN = 0;

// What a position is worth. Turning cards over and completing runs dominate; order comes next.
// The numbers were tuned by playing thousands of simulated games (see the test).
const RUN = 1000;
/** Cost of a column's face-down cards; the last ones cost most, so short columns get cleared first. */
const HIDDEN = [0, 200, 390, 570, 740, 900, 1050];
const EMPTY = 60;
const SUITED = 12;
const OFF_SUIT = 3;
const BREAK = 6;
/** A break is worse when face-down cards are waiting underneath it. */
const BREAK_OVER_HIDDEN = 4;
/** Per move, so the shortest route to the same result wins. */
const STEP_COST = 0.25;

const BEAM_WIDTH = 400;
const MAX_DEPTH = 10;

interface Pile {
  /** Face-down cards (always at the top of the column, under the face-up ones). */
  h: number;
  c: number[];
  score: number;
  k1: number;
  k2: number;
}

interface Node {
  p: Pile[];
  found: number;
  ev: number;
  a: number;
  b: number;
  depth: number;
  parent: Node | null;
  move: Step | null;
  /** A card was turned over: what follows depends on it, so the search stops here. */
  leaf: boolean;
}

function pile(h: number, c: number[]): Pile {
  let score = h || c.length ? -HIDDEN[Math.min(h, HIDDEN.length - 1)] : EMPTY;
  let k1 = h + 1;
  let k2 = h + 7;
  for (let i = 0; i < c.length; i++) {
    k1 = (Math.imul(k1, 31) + c[i] + 1) | 0;
    k2 = (Math.imul(k2, 131) + c[i] + 5) | 0;
    if (!i || c[i - 1] === UNKNOWN) continue;
    if (c[i - 1] === c[i] + 1) score += SUITED;
    else if ((c[i - 1] & 15) === (c[i] & 15) + 1) score += OFF_SUIT;
    else score -= BREAK + (h ? BREAK_OVER_HIDDEN : 0);
  }
  return { h, c, score, k1, k2 };
}

const mixA = (i: number, p: Pile) => Math.imul(p.k1 ^ Math.imul(i + 1, 0x9e3779b1), 0x85ebca6b);
const mixB = (i: number, p: Pile) => Math.imul(p.k2 ^ Math.imul(i + 1, 0x27d4eb2f), 0xc2b2ae35);
const keyOf = (n: Node) => (n.a >>> 0) * 2097152 + (n.b >>> 11);

function rootOf(s: SpiderState): Node {
  const p = s.columns.map((col) => {
    const h = col.filter((c) => !c.faceUp).length;
    return pile(
      h,
      col.slice(h).map((c) => c.rank + 16 * SUIT_CODE[c.suit]),
    );
  });
  let ev = s.foundations.length * RUN;
  let a = 0;
  let b = 0;
  p.forEach((x, i) => ((ev += x.score), (a = (a + mixA(i, x)) | 0), (b = (b + mixB(i, x)) | 0)));
  return { p, found: s.foundations.length, ev, a, b, depth: 0, parent: null, move: null, leaf: false };
}

/** Length of the suited descending run at the bottom of a column. */
function suitedRun(c: number[]): number {
  let i = c.length - 1;
  if (i < 0 || c[i] === UNKNOWN) return 0;
  while (i > 0 && c[i - 1] === c[i] + 1) i--;
  return c.length - i;
}

function completesRun(c: number[]): boolean {
  const n = c.length;
  if (n < 13 || (c[n - 1] & 15) !== 1) return false;
  for (let j = 1; j < 13; j++) if (c[n - 1 - j] !== c[n - 1] + j) return false;
  return true;
}

function child(n: Node, from: number, i: number, to: number): Node {
  const src = n.p[from];
  const dst = n.p[to];
  let leaf = false;
  let found = n.found;
  let sc = src.c.slice(0, i);
  let sh = src.h;
  if (!sc.length && sh) (sh--, (sc = [UNKNOWN]), (leaf = true));
  let dc = dst.c.concat(src.c.slice(i));
  let dh = dst.h;
  if (completesRun(dc)) {
    found++;
    dc = dc.slice(0, -13);
    if (!dc.length && dh) (dh--, (dc = [UNKNOWN]), (leaf = true));
  }
  const ns = pile(sh, sc);
  const nd = pile(dh, dc);
  const p = n.p.slice();
  p[from] = ns;
  p[to] = nd;
  return {
    p,
    found,
    ev: n.ev - src.score - dst.score + ns.score + nd.score + (found - n.found) * RUN,
    a: (n.a - mixA(from, src) - mixA(to, dst) + mixA(from, ns) + mixA(to, nd)) | 0,
    b: (n.b - mixB(from, src) - mixB(to, dst) + mixB(from, ns) + mixB(to, nd)) | 0,
    depth: n.depth + 1,
    parent: n,
    // The game counts from the top of the column, face-down cards included.
    move: { t: 'move', from, index: src.h + i, to },
    leaf,
  };
}

function expand(n: Node, out: Node[]) {
  const p = n.p;
  let firstEmpty = -1;
  for (let i = 0; i < p.length; i++)
    if (!p[i].c.length) {
      firstEmpty = i;
      break;
    }
  for (let from = 0; from < p.length; from++) {
    const s = p[from];
    const c = s.c;
    const len = c.length;
    const run = suitedRun(c);
    if (!run) continue;
    const rs = len - run;
    for (let i = rs; i < len; i++) {
      const card = c[i];
      for (let to = 0; to < p.length; to++) {
        if (to === from) continue;
        const d = p[to].c;
        if (!d.length) {
          // One empty column is as good as another; only whole runs go there, and moving an
          // entire column into one changes nothing.
          if (to !== firstEmpty || i !== rs || (i === 0 && !s.h)) continue;
        } else {
          const top = d[d.length - 1];
          if ((top & 15) !== (card & 15) + 1) continue;
          // Splitting a suited run only pays when it builds a longer one.
          if (i > rs && (top !== card + 1 || suitedRun(d) + (len - i) <= run)) continue;
        }
        out.push(child(n, from, i, to));
      }
    }
  }
}

/** The moves to the best position within reach, or none if the current one is already the best. */
export function bestLine(s: SpiderState, width = BEAM_WIDTH, maxDepth = MAX_DEPTH): Step[] {
  const root = rootOf(s);
  const seen = new Set<number>([keyOf(root)]);
  let best: Node | null = null;
  let bestValue = root.ev;
  let level = [root];
  const kids: Node[] = [];
  for (let depth = 1; depth <= maxDepth && level.length; depth++) {
    const next: Node[] = [];
    for (const n of level) {
      kids.length = 0;
      expand(n, kids);
      for (const k of kids) {
        const key = keyOf(k);
        if (seen.has(key)) continue;
        seen.add(key);
        const value = k.ev - depth * STEP_COST;
        if (value > bestValue) (bestValue = value), (best = k);
        if (!k.leaf) next.push(k);
      }
    }
    if (next.length > width) {
      next.sort((x, y) => y.ev - x.ev);
      next.length = width;
    }
    level = next;
  }
  const line: Step[] = [];
  for (let n = best; n?.move; n = n.parent) line.unshift(n.move);
  return line;
}

/**
 * What to do next, as a line of moves: the route to the best reachable position; otherwise deal;
 * otherwise (when an empty column blocks the deal) the least harmful way to fill it. Empty when
 * nothing can be done.
 */
export function plan(s: SpiderState, allowEmptyDeal = false): Step[] {
  const line = bestLine(s);
  if (line.length) return line;
  const block = dealBlocked(s, allowEmptyDeal);
  if (!block) return [{ t: 'deal' }];
  if (block === 'empty-column') {
    // Fill every empty column, then deal, as one line: taken alone, a filling move looks like
    // a step backwards and the next hint would undo it. Any card may go across here, even one
    // split off a run, as long as it leaves something behind.
    const line: Step[] = [];
    let node = rootOf(s);
    for (;;) {
      const at = node;
      const to = at.p.findIndex((x) => !x.c.length);
      if (to < 0) return [...line, { t: 'deal' }];
      let pick: Node | null = null;
      at.p.forEach((src, from) => {
        const len = src.c.length;
        for (let i = len - suitedRun(src.c); i < len; i++) {
          if (i === 0 && !src.h) continue;
          const k = child(at, from, i, to);
          if (!pick || k.ev > pick.ev) pick = k;
        }
      });
      if (!pick) break;
      node = pick as Node;
      line.push(node.move!);
    }
  }
  return [];
}
