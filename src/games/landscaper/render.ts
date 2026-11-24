import type { Part } from './rules';
import { KIND, type TileKind } from './tiles';

/**
 * Landscaper's tiles drawn in code, as SVG on a 100 × 100 square, in a quaint storybook style
 * seen from a little above and in front. The ground (fields, winding roads and rivers, the
 * uneven stone walls of cities) turns with the tile. Everything standing on it (houses, towers,
 * trees, sheep, the chapel, the well) is a sprite drawn upright: the board turns each one back
 * by the tile's turn (`--deg`), so nothing ever stands on its side or upside down. Each kind has
 * a few looks, every one with its own wobble of road, river and wall.
 */

const COL = {
  field: '#8cbc62',
  fieldLight: '#9cc86f',
  speck: '#77a64f',
  bush: '#5c8f3d',
  bushLight: '#78a852',
  trunk: '#7a5634',
  road: '#ead9ad',
  roadEdge: '#9c8257',
  rut: '#c9b183',
  city: '#d9c49b',
  cobble: '#c8b386',
  wall: '#6d5636',
  stone: '#b9a57c',
  wallTop: '#cdb98f',
  line: '#5a452c',
  roofs: ['#a4553a', '#8f4a36', '#6d7480', '#86705a', '#b07a45', '#9a5a3c', '#64705d'],
  walls: ['#efe3c4', '#e6d6b0', '#f3ecd9', '#dccaa4'],
  shield: '#34508a',
};

type Pt = [number, number];
type Curve = [Pt, Pt, Pt, Pt];

const MID: readonly Pt[] = [
  [50, 0],
  [100, 50],
  [50, 100],
  [0, 50],
];
/** Straight in from each edge. */
const IN: readonly Pt[] = [
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 0],
];

const f1 = (n: number) => n.toFixed(1);
const add = (a: Pt, b: Pt, k = 1): Pt => [a[0] + b[0] * k, a[1] + b[1] * k];
const pick = <T>(rand: () => number, xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

function onCurve([a, b, c, d]: Curve, t: number): Pt {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [w[0] * a[0] + w[1] * b[0] + w[2] * c[0] + w[3] * d[0], w[0] * a[1] + w[1] * b[1] + w[2] * c[1] + w[3] * d[1]];
}

/** A point turned `deg` (a multiple of 90) clockwise about the tile's middle. */
function turnPt(p: Pt, deg: number): Pt {
  let q = p;
  for (let n = 0; n < (((deg / 90) % 4) + 4) % 4; n++) q = [100 - q[1], q[0]];
  return q;
}

// ───────────────────────── roads and rivers ─────────────────────────

/**
 * A winding course between two edges (or from an edge in to `stop`), as cubic pieces. It always
 * meets an edge square on at its middle, so it lines up with the next tile; in between it swings
 * from side to side `bends` times by up to `wig`. `pin` keeps the very middle in place (a bridge).
 */
function course(edges: number[], stop: Pt | null, rand: () => number, wig: number, bends = 1, pin = false): Curve[] {
  const [a, b] = edges;
  const A = MID[a];
  const ia = IN[a];
  if (b === undefined) {
    const S = stop!;
    const dist = Math.hypot(S[0] - A[0], S[1] - A[1]);
    const side: Pt = [-ia[1], ia[0]];
    const j = (rand() - 0.5) * wig;
    return [[A, add(A, ia, dist * 0.4), add(add(S, ia, -dist * 0.35), side, j), S]];
  }
  const B = MID[b];
  // The plain course: a straight line, or a quarter curve round the middle of the tile.
  const C: Pt = (b - a) % 2 === 0 ? [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2] : [50, 50];
  const base = (t: number): Pt => [(1 - t) ** 2 * A[0] + 2 * (1 - t) * t * C[0] + t * t * B[0], (1 - t) ** 2 * A[1] + 2 * (1 - t) * t * C[1] + t * t * B[1]];
  const heading = (t: number): Pt => {
    const d: Pt = [(1 - t) * (C[0] - A[0]) + t * (B[0] - C[0]), (1 - t) * (C[1] - A[1]) + t * (B[1] - C[1])];
    const l = Math.hypot(d[0], d[1]);
    return [d[0] / l, d[1] / l];
  };
  const pts: { p: Pt; dir: Pt }[] = [{ p: A, dir: ia }];
  let side = rand() < 0.5 ? 1 : -1;
  for (let i = 1; i <= bends; i++) {
    const t = i / (bends + 1);
    const d = heading(t);
    const still = pin && i * 2 === bends + 1;
    const j = still ? 0 : side * (0.5 + rand() * 0.5) * wig;
    const turn = still ? 0 : (rand() - 0.5) * 0.5;
    const p = add(base(t), [-d[1], d[0]], j);
    pts.push({ p: [Math.min(90, Math.max(10, p[0])), Math.min(90, Math.max(10, p[1]))], dir: [d[0] * Math.cos(turn) - d[1] * Math.sin(turn), d[0] * Math.sin(turn) + d[1] * Math.cos(turn)] });
    side = -side;
  }
  pts.push({ p: B, dir: [-IN[b][0], -IN[b][1]] });
  const out: Curve[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const { p: P, dir: dp } = pts[i];
    const { p: Q, dir: dq } = pts[i + 1];
    const h = Math.hypot(Q[0] - P[0], Q[1] - P[1]) / 2.6;
    out.push([P, add(P, dp, h), add(Q, dq, -h), Q]);
  }
  return out;
}

const courseD = (c: Curve[]) => `M${f1(c[0][0][0])} ${f1(c[0][0][1])}${c.map(([, p, q, e]) => `C${f1(p[0])} ${f1(p[1])} ${f1(q[0])} ${f1(q[1])} ${f1(e[0])} ${f1(e[1])}`).join('')}`;

/** `n` points spread along a course. */
function along(c: Curve[], n: number): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const t = ((i + 0.5) / n) * c.length;
    const seg = Math.min(c.length - 1, Math.floor(t));
    return onCurve(c[seg], t - seg);
  });
}

/**
 * A stretch of river as layered outlines: grassy bank, sandy shore, water, a paler current down
 * the middle and little white waves. It swells and narrows as it goes, but meets the tile's edges
 * at the standard width so it always joins its neighbours.
 */
function riverParts(c: Curve[], rand: () => number) {
  const n = 64;
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const t = (i / n) * c.length;
    const seg = Math.min(c.length - 1, Math.floor(t));
    return onCurve(c[seg], t - seg);
  });
  const normal = (i: number): Pt => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  };
  // Width: two slow swells per side, faded out toward the tile's edges.
  const ph = [rand() * 6.3, rand() * 6.3, rand() * 6.3, rand() * 6.3];
  const swell = (u: number, a: number, b: number) => Math.sin(Math.PI * u) * (2.4 * Math.sin(u * 7 + a) + 1.6 * Math.sin(u * 13 + b));
  const outline = (grow: number, shift = 0) => {
    const left: Pt[] = [];
    const right: Pt[] = [];
    pts.forEach((p, i) => {
      const u = i / n;
      const [nx, ny] = normal(i);
      const l = Math.max(0.6, 7.5 + swell(u, ph[0], ph[1]) + grow + shift * Math.sin(Math.PI * u));
      const r = Math.max(0.6, 7.5 + swell(u, ph[2], ph[3]) + grow - shift * Math.sin(Math.PI * u));
      left.push([p[0] + nx * l, p[1] + ny * l]);
      right.push([p[0] - nx * r, p[1] - ny * r]);
    });
    return `M${[...left, ...right.reverse()].map((q) => `${f1(q[0])} ${f1(q[1])}`).join('L')}Z`;
  };
  const waves = pts
    .filter((_, i) => i % 4 === 2 && i < n - 4 && rand() < 0.6)
    .map((p) => {
      const i = pts.indexOf(p);
      const [nx, ny] = normal(i);
      const off = (rand() < 0.5 ? -1 : 1) * (1.5 + rand() * 3);
      const deg = (Math.atan2(nx, -ny) * 180) / Math.PI;
      return `<path transform="translate(${f1(p[0] + nx * off)} ${f1(p[1] + ny * off)}) rotate(${f1(deg)})" d="M-2.2 0q1.1-1.1 2.2 0t2.2 0"/>`;
    })
    .join('');
  // Pebbles here and there on the shore.
  const stones = pts
    .filter((_, i) => i % 3 === 1 && rand() < 0.35)
    .map((p) => {
      const [nx, ny] = normal(pts.indexOf(p));
      const side = rand() < 0.5 ? 1 : -1;
      const d = side * (8.2 + rand() * 1.2);
      return `<ellipse cx="${f1(p[0] + nx * d)}" cy="${f1(p[1] + ny * d)}" rx="${f1(1 + rand() * 0.8)}" ry="${f1(0.7 + rand() * 0.4)}" fill="#b9b2a2" stroke="#8a8372" stroke-width=".35"/>`;
    })
    .join('');
  return {
    bank: `<path d="${outline(2.6)}" fill="#7aa553" opacity=".7"/><path d="${outline(1.2)}" fill="#c9bb8c" opacity=".75"/>${stones}`,
    water: `<path d="${outline(0)}" fill="#4f8fc0"/><path d="${outline(-2.2, 0.8)}" fill="#6aa7d4"/><path d="${outline(-5)}" fill="#8cc2e4" opacity=".75"/>`,
    waves: `<g fill="none" stroke="#f4fbff" stroke-width=".75" stroke-linecap="round" opacity=".75">${waves}</g>`,
  };
}

/**
 * Still water in the river's style: an uneven round pond (the spring, or the lake the river ends
 * in) with the same soft grass edge, sandy shore and paler middle.
 */
function pondParts([cx, cy]: Pt, rx: number, ry: number, rand: () => number) {
  const a = rand() * 6.3;
  const b = rand() * 6.3;
  const shape = (grow: number, k = 1) =>
    `M${Array.from({ length: 48 }, (_, i) => {
      const th = (i / 48) * Math.PI * 2;
      const w = 1 + 0.08 * Math.sin(3 * th + a) + 0.05 * Math.sin(5 * th + b);
      return `${f1(cx + Math.cos(th) * (rx * w * k + grow))} ${f1(cy + Math.sin(th) * (ry * w * k + grow))}`;
    }).join('L')}Z`;
  return {
    bank: `<path d="${shape(2.6)}" fill="#7aa553" opacity=".7"/><path d="${shape(1.2)}" fill="#c9bb8c" opacity=".75"/>`,
    water: `<path d="${shape(0)}" fill="#4f8fc0"/><path d="${shape(-2.2)}" fill="#6aa7d4"/><path d="${shape(0, 0.55)}" fill="#8cc2e4" opacity=".75"/>`,
  };
}

/** Where a road ending on this tile stops: at the cloister, the city, or the hamlet at a junction. */
function roadStop(edge: number, k: TileKind): Pt {
  const [x, y] = MID[edge];
  const stop = k.cloister ? (k.rivers ? 0.45 : 0.7) : k.roads.length === 1 ? 0.5 : k.roads.length > 2 ? 0.66 : 1;
  return [x + (50 - x) * stop, y + (50 - y) * stop];
}

/** Where the chapel stands: the middle, or beside the river on a riverside cloister. */
const chapelAt = (k: TileKind): Pt => (k.rivers ? [42, 48] : [50, 50]);

// ───────────────────────── cities ─────────────────────────

/**
 * A city part's outline, unturned, then turned by `deg`: tile corners and the wall curves between
 * them (inside the tile, never along its edges).
 */
function cityOutline(edges: number[]): { outline: (Pt | Curve)[]; deg: number } {
  const e = [...edges].sort();
  if (e.length === 4) return { outline: [[0, 0], [100, 0], [100, 100], [0, 100]], deg: 0 };
  if (e.length === 3) {
    const missing = [0, 1, 2, 3].find((x) => !e.includes(x))!;
    return { outline: [[0, 0], [100, 0], [[100, 100], [70, 68], [30, 68], [0, 100]]], deg: (missing - 2) * 90 };
  }
  if (e.length === 2 && (e[1] - e[0]) % 2 === 0) {
    return {
      outline: [
        [[0, 0], [30, 28], [70, 28], [100, 0]],
        [[100, 100], [70, 72], [30, 72], [0, 100]],
      ],
      deg: e[0] === 0 ? 90 : 0,
    };
  }
  if (e.length === 2) {
    const first = e[0] === 0 && e[1] === 3 ? 3 : e[0];
    return { outline: [[0, 0], [[100, 0], [60, 25], [25, 60], [0, 100]]], deg: ((first - 3 + 4) % 4) * 90 };
  }
  return { outline: [[[100, 0], [78, 32], [22, 32], [0, 0]]], deg: e[0] * 90 };
}

interface City {
  poly: Pt[];
  /** The walls as runs of straight stretches, corner to corner. */
  walls: Pt[][];
}

/**
 * A city part with its walls built: each wall curve becomes a few straight stretches with
 * jittered corners, so no two walls run quite alike. `gate` keeps the wall's middle in place,
 * where a road comes through.
 */
function buildCity(edges: number[], rand: () => number, gate: boolean): City {
  const { outline, deg } = cityOutline(edges);
  const poly: Pt[] = [];
  const walls: Pt[][] = [];
  for (const piece of outline) {
    if (typeof piece[0] === 'number') {
      poly.push(piece as Pt);
      continue;
    }
    const c = piece as Curve;
    const n = gate ? 4 : 3 + Math.floor(rand() * 3);
    const run: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const p = onCurve(c, i / n);
      const fixed = i === 0 || i === n || (gate && i * 2 === n);
      run.push(fixed ? p : [Math.min(97, Math.max(3, p[0] + (rand() - 0.5) * 8)), Math.min(97, Math.max(3, p[1] + (rand() - 0.5) * 8))]);
    }
    walls.push(run);
    poly.push(...run);
  }
  const at = (p: Pt) => turnPt(p, deg);
  return { poly: poly.map(at), walls: walls.map((w) => w.map(at)) };
}

function inside([x, y]: Pt, poly: Pt[]) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
/** Comfortably inside: the point and everything within `r` of it. */
const wellInside = ([x, y]: Pt, poly: Pt[], r: number) => [[x, y], [x - r, y], [x + r, y], [x, y - r], [x, y + r]].every((p) => inside(p as Pt, poly));

// ───────────────────────── upright sprites ─────────────────────────
// Each is drawn standing on (0, 0), seen from a little above and in front, light from the top left.

const shadow = (rx: number, ry = rx * 0.38) => `<ellipse cx="${f1(rx * 0.3)}" cy="${f1(ry * 0.35)}" rx="${f1(rx)}" ry="${f1(ry)}" fill="rgba(40,30,10,.2)"/>`;
const SHADE = 'rgba(40,25,10,.2)';

/** A plain little house: front wall, a side going back, and a gable or hipped roof. */
function house(rand: () => number): string {
  const w = 7 + rand() * 3.5;
  const h = 3 + rand() * 1.6;
  const D: Pt = [1.6 + rand() * 0.9, -(2.8 + rand() * 1.4)];
  const hip = rand() < 0.55;
  const l = -w / 2;
  const r = w / 2;
  const eave = -h;
  const ridgeY = eave + D[1] / 2 - (-D[1] / 2 + 1.4 + rand() * 1.4);
  const inset = hip ? Math.min(2.4, w * 0.26) : 0;
  const rl: Pt = [l + inset + D[0] / 2, ridgeY];
  const rr: Pt = [r - inset + D[0] / 2, ridgeY];
  const roof = pick(rand, COL.roofs);
  const wall = pick(rand, COL.walls);
  const P = (...pts: Pt[]) => pts.map((p) => `${f1(p[0])} ${f1(p[1])}`).join(' ');
  const end = hip
    ? `<polygon points="${P([r + 0.6, eave + 0.4], [r + 0.6 + D[0], eave + D[1] + 0.4], rr)}" fill="${roof}"/><polygon points="${P([r + 0.6, eave + 0.4], [r + 0.6 + D[0], eave + D[1] + 0.4], rr)}" fill="${SHADE}"/>`
    : `<polygon points="${P([r, eave], [r + D[0], eave + D[1]], rr)}" fill="${wall}"/><polygon points="${P([r, eave], [r + D[0], eave + D[1]], rr)}" fill="${SHADE}"/>`;
  const door = rand() < 0.5 ? `<rect x="${f1(l + w * (0.2 + rand() * 0.45))}" y="-2.3" width="1.4" height="2.3" fill="#5a4330" stroke="none"/>` : '';
  return `${shadow(w * 0.62)}<g stroke="${COL.line}" stroke-width=".45" stroke-linejoin="round">
    <polygon points="${P([r, 0], [r + D[0], D[1]], [r + D[0], eave + D[1]], [r, eave])}" fill="${wall}"/><polygon points="${P([r, 0], [r + D[0], D[1]], [r + D[0], eave + D[1]], [r, eave])}" fill="${SHADE}" stroke="none"/>
    <rect x="${f1(l)}" y="${f1(eave)}" width="${f1(w)}" height="${f1(h)}" fill="${wall}"/>${door}
    ${end}<polygon points="${P([l - 0.6, eave + 0.4], [r + 0.6, eave + 0.4], rr, rl)}" fill="${roof}"/></g>`;
}

/** A round tower: conical roof and pennant, or a flat crenellated top. */
function tower(rand: () => number, tall = false): string {
  const w = tall ? 4.4 : 3.3;
  const h = tall ? 13 : 7 + rand() * 2;
  const cone = tall || rand() < 0.6;
  const top = cone
    ? `<path d="M${f1(-w - 0.8)} ${f1(-h)}L0 ${f1(-h - (tall ? 8 : 6))}L${f1(w + 0.8)} ${f1(-h)}Q0 ${f1(-h + 1.8)} ${f1(-w - 0.8)} ${f1(-h)}Z" fill="${pick(rand, COL.roofs)}"/>${
        rand() < 0.6 ? `<path d="M0 ${f1(-h - (tall ? 8 : 6))}v-3.4" fill="none"/><path d="M0 ${f1(-h - (tall ? 11.4 : 9.4))}l3.4 1.1l-3.4 1.2z" fill="${COL.shield}" stroke="none"/>` : ''
      }`
    : `<rect x="${f1(-w - 0.5)}" y="${f1(-h - 1.4)}" width="${f1(2 * w + 1)}" height="1.8" fill="${COL.wallTop}"/>${[-w - 0.5, -0.8, w - 1.1].map((x) => `<rect x="${f1(x)}" y="${f1(-h - 3)}" width="1.6" height="1.8" fill="${COL.wallTop}"/>`).join('')}`;
  return `${shadow(w + 1.6)}<g stroke="${COL.wall}" stroke-width=".55" stroke-linejoin="round">
    <path d="M${f1(-w)} ${f1(-h)}V0Q0 1.4 ${f1(w)} 0V${f1(-h)}Z" fill="${COL.wallTop}"/><path d="M${f1(w * 0.25)} ${f1(-h)}V.9Q${f1(w * 0.7)} .6 ${f1(w)} 0V${f1(-h)}Z" fill="${SHADE}" stroke="none"/>
    <rect x="-.6" y="${f1(-h * 0.62)}" width="1.2" height="1.9" rx=".6" fill="#4a3a26" stroke="none"/>${top}</g>`;
}

/** The gatehouse where a road comes through a city wall. */
const GATE = `${shadow(7)}<g stroke="${COL.wall}" stroke-width=".6" stroke-linejoin="round"><polygon points="5 0 6.8 -2.4 6.8 -9.4 5 -7" fill="${COL.wallTop}"/><polygon points="5 0 6.8 -2.4 6.8 -9.4 5 -7" fill="${SHADE}" stroke="none"/><rect x="-5" y="-7" width="10" height="7" fill="${COL.wallTop}"/><path d="M-2 0v-3a2 2 0 0 1 4 0v3z" fill="#4a3a26"/><path d="M-5 -7v-1.8h2v1.8M-1 -7v-1.8h2v1.8M3 -7v-1.8h2v1.8" fill="${COL.wallTop}"/></g>`;

function tree(rand: () => number): string {
  if (rand() < 0.4) {
    const s = 0.85 + rand() * 0.4;
    return `${shadow(4.5 * s)}<rect x="-.7" y="-2.4" width="1.4" height="2.4" fill="${COL.trunk}"/><path d="M0 ${f1(-15 * s)}L${f1(4.6 * s)} ${f1(-6.5 * s)}H${f1(-4.6 * s)}Z" fill="#4f7f37"/><path d="M0 ${f1(-11 * s)}L${f1(5.8 * s)} -1.6H${f1(-5.8 * s)}Z" fill="#5c8f3d"/><path d="M0 ${f1(-11 * s)}L${f1(5.8 * s)} -1.6H${f1(2 * s)}Z" fill="${SHADE}"/>`;
  }
  const r = 4.6 + rand() * 1.8;
  return `${shadow(r)}<rect x="-.9" y="-4.5" width="1.8" height="4.5" fill="${COL.trunk}"/><circle cx="0" cy="${f1(-4.5 - r * 0.8)}" r="${f1(r)}" fill="${COL.bush}"/><circle cx="${f1(r * 0.5)}" cy="${f1(-4 - r * 0.5)}" r="${f1(r * 0.6)}" fill="#4f7f37"/><circle cx="${f1(-r * 0.35)}" cy="${f1(-4.5 - r * 1.1)}" r="${f1(r * 0.5)}" fill="${COL.bushLight}"/>`;
}

const BUSH = `${shadow(4.6)}<circle cx="-2" cy="-2.6" r="2.9" fill="${COL.bush}"/><circle cx="2" cy="-3" r="3.2" fill="#4f7f37"/><circle cx=".2" cy="-4.4" r="2.1" fill="${COL.bushLight}"/>`;
const SHEEP = `${shadow(3.4, 1)}<ellipse cx="0" cy="-2.5" rx="3.2" ry="2.3" fill="#fbf8f0" stroke="#bdb6a6" stroke-width=".4"/><ellipse cx="3" cy="-3.1" rx="1.3" ry="1.1" fill="#3b332b"/><path d="M-1.6 -.5v.9M1.4 -.5v.9" stroke="#3b332b" stroke-width=".6"/>`;
const HAYSTACK = `${shadow(5, 1.8)}<path d="M-4.5 0Q0 -10.5 4.5 0Z" fill="#e3c56b" stroke="#b8963d" stroke-width=".6"/><path d="M-2.5 -3.5q2.5-2 5 0" stroke="#b8963d" stroke-width=".6" fill="none"/>`;
const FENCE = `<g stroke="#8a6a45" stroke-width=".9" stroke-linecap="round"><path d="M-10 -3.4h20M-10 -1.6h20"/>${[-10, -5, 0, 5, 10].map((d) => `<path d="M${d} 0v-5"/>`).join('')}</g>`;
const DUCK = `<ellipse cx="0" cy="0" rx="2.6" ry="1.6" fill="#f4f0e0"/><circle cx="2" cy="-1.2" r="1.1" fill="#2f6b3a"/><path d="M3 -1.2l1.2 .3" stroke="#e8a33d" stroke-width=".8"/>`;

function windmill(rand: () => number): string {
  const spin = Math.round(rand() * 90);
  return `<g stroke="#5a3e24" stroke-width=".6">${shadow(6, 2)}<path d="M-3.5 0L-2.2 -11H2.2L3.5 0Z" fill="#f0e4c6"/><path d="M-2.8 -11L0 -14L2.8 -11Z" fill="${COL.roofs[2]}"/><g transform="rotate(${spin} 0 -11.5)"><path d="M0 -11.5v-8M0 -11.5v8M0 -11.5h-8M0 -11.5h8" stroke="#6b5030" stroke-width="1"/><path d="M.6 -19h2.2v6.5h-2.2zM-2.8 -10h2.2v6.5h-2.2z" fill="#f6efdd" stroke-width=".4"/></g></g>`;
}

function shield(): string {
  // White with a blue bend, on a post, casting a shadow.
  return `${shadow(8, 2.6)}<g stroke="${COL.shield}" stroke-linejoin="round"><path d="M0 0v-4" stroke="${COL.wall}" stroke-width="1.4"/><path d="M-7.5 -21h15v9c0 6.2-7.5 10.5-7.5 10.5s-7.5-4.3-7.5-10.5z" fill="#f4efe2" stroke-width="1.5"/><path d="M0 -21h7.5v9c0 6.2-7.5 10.5-7.5 10.5z" fill="${SHADE}" stroke="none"/><path d="M-6.6 -12.6L6.6 -18.4V-15.2L-6.6 -9.4Z" fill="${COL.shield}" stroke="none"/></g>`;
}

/** The chapel: nave, bell tower, cross, and a vegetable garden; stands on (50, 60). */
const CHAPEL = `<g transform="translate(-50 -60)" stroke="${COL.wall}" stroke-width=".8" stroke-linejoin="round">
  <ellipse cx="53" cy="66" rx="20" ry="4" fill="rgba(40,30,10,.2)" stroke="none"/>
  <ellipse cx="33" cy="71" rx="9" ry="4.6" fill="#93734a" stroke="none"/><ellipse cx="33" cy="70.4" rx="8" ry="3.8" fill="#a5845a" stroke="none"/>
  ${[[28, 69], [32, 68.4], [36, 69], [27.5, 72], [31.5, 72.4], [35.5, 72], [39, 70.6]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.5" fill="#6faa4a" stroke="#4f7f37" stroke-width=".5"/>`).join('')}
  <circle cx="68" cy="70" r="1.2" fill="#f2a5b5" stroke="none"/><circle cx="71" cy="72" r="1.2" fill="#f6d55c" stroke="none"/><circle cx="66" cy="73" r="1.2" fill="#fff8e6" stroke="none"/>
  <polygon points="62 66 65 62 65 45 62 49" fill="#f0e4c6"/><polygon points="62 66 65 62 65 45 62 49" fill="${SHADE}" stroke="none"/>
  <rect x="40" y="49" width="22" height="17" fill="#f0e4c6"/><path d="M38 49.5L42 40H61L65 45.5L64 49.5Z" fill="${COL.roofs[0]}"/>
  <rect x="54" y="36" width="9" height="30" fill="#e9dcbd"/><path d="M63 36V64" stroke="none"/><rect x="59" y="36" width="4" height="30" fill="${SHADE}" stroke="none"/>
  <path d="M52.5 36.5L58.5 26L64.5 36.5Z" fill="${COL.roofs[2]}"/>
  <path d="M58.5 26V20M56.4 22.2h4.2" stroke="${COL.wall}" stroke-width="1.1" fill="none"/>
  <circle cx="58.5" cy="42" r="2" fill="#fff8e6"/><path d="M48 66v-7a3 3 0 0 1 6 0v7" fill="${COL.wall}"/>
  <rect x="43" y="53" width="3" height="4" rx="1.5" fill="#7fb0d9"/></g>`;

/** An inn by the road: two timbered storeys, lit windows, a hanging sign and a barrel. */
const INN = `${shadow(9)}<g stroke="${COL.line}" stroke-width=".5" stroke-linejoin="round">
  <polygon points="6 0 8.2 -2.8 8.2 -13 6 -10.2" fill="#e8d9b4"/><polygon points="6 0 8.2 -2.8 8.2 -13 6 -10.2" fill="${SHADE}" stroke="none"/>
  <rect x="-6" y="-10.2" width="12" height="10.2" fill="#f3e6c4"/>
  <path d="M-6 -5.2h12M-3 -10.2v10.2M3 -10.2v10.2M-6 -10.2l3 5M3 -10.2l3 5" stroke="#6b4a2b" stroke-width=".6" fill="none"/>
  <rect x="-1" y="-3.4" width="2" height="3.4" fill="#5a4330"/>
  <rect x="-5" y="-8.6" width="1.6" height="1.8" fill="#f6d983" stroke="none"/><rect x="3.6" y="-8.6" width="1.6" height="1.8" fill="#f6d983" stroke="none"/>
  <polygon points="6.6 -9.8 8.8 -12.6 5.6 -16.6" fill="#6f5238"/><polygon points="6.6 -9.8 8.8 -12.6 5.6 -16.6" fill="${SHADE}" stroke="none"/>
  <polygon points="-6.8 -9.8 6.6 -9.8 5.6 -16.6 -5.2 -16.6" fill="#7d5a3c"/>
  <path d="M6.2 -7.2h4.4" stroke="#4a3a26" stroke-width=".7" fill="none"/><rect x="8.4" y="-6.8" width="3.4" height="2.8" rx=".5" fill="#c9a15a"/>
  <circle cx="-8.4" cy="-1.4" r="1.6" fill="#8a5a2b"/></g>`;

/** A cathedral: twin spired towers, a long nave and a rose window. */
const CATHEDRAL = `${shadow(15, 4.5)}<g stroke="${COL.wall}" stroke-width=".6" stroke-linejoin="round">
  <polygon points="9 0 11.5 -3 11.5 -15 9 -12" fill="#ddcca4"/><polygon points="9 0 11.5 -3 11.5 -15 9 -12" fill="${SHADE}" stroke="none"/>
  <rect x="-9" y="-12" width="18" height="12" fill="#ece0c3"/>
  <polygon points="-9.6 -11.8 9.6 -11.8 11.6 -15 6 -19 -6 -19" fill="${COL.roofs[1]}"/>
  <rect x="-13" y="-25" width="6.4" height="25" fill="#e4d6b2"/><rect x="6.6" y="-25" width="6.4" height="25" fill="#e4d6b2"/>
  <rect x="9.8" y="-25" width="3.2" height="25" fill="${SHADE}" stroke="none"/><rect x="-9.8" y="-25" width="3.2" height="25" fill="${SHADE}" stroke="none"/>
  <path d="M-13.6 -25L-9.8 -35L-6 -25ZM6 -25L9.8 -35L13.6 -25Z" fill="${COL.roofs[2]}"/>
  <path d="M-9.8 -35v-3M-11 -37h2.4M9.8 -35v-3M8.6 -37h2.4" fill="none" stroke-width=".8"/>
  <circle cx="0" cy="-7.6" r="2.8" fill="#7fb0d9"/><path d="M0 -10.4v5.6M-2.8 -7.6h5.6" stroke-width=".4" fill="none"/>
  <path d="M-2.2 0v-3.2a2.2 2.2 0 0 1 4.4 0V0z" fill="#5a3e24"/>
  <rect x="-10.6" y="-19" width="1.6" height="2.6" rx=".8" fill="#7fb0d9"/><rect x="9" y="-19" width="1.6" height="2.6" rx=".8" fill="#7fb0d9"/></g>`;


interface Sprite {
  at: Pt;
  svg: string;
  scale?: number;
}

/**
 * Sprites in back-to-front order, each turned back upright: by the board as the tile turns (see
 * `.up` in the CSS), or once and for all for a tile laid with turn `fixed`.
 */
const spritesSvg = (all: Sprite[], fixed?: number) => {
  const up = fixed === undefined ? 'class="up"' : fixed ? `transform="rotate(${-fixed * 90})"` : '';
  return all
    .map((s) => ({ s, y: fixed === undefined ? s.at[1] : turnPt(s.at, (fixed ?? 0) * 90)[1] }))
    .sort((a, b) => a.y - b.y)
    .map(({ s }) => `<g transform="translate(${f1(s.at[0])} ${f1(s.at[1])})"><g ${up}>${s.scale ? `<g transform="scale(${s.scale})">${s.svg}</g>` : s.svg}</g></g>`)
    .join('');
};

// ───────────────────────── the tile ─────────────────────────

const cache = new Map<string, string>();

function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
}

/**
 * The SVG for a tile kind, unturned, in its own look `variant` (any number; each gives its own
 * wobble). Its sprites turn upright live with `--deg`; or, given `fixed`, are drawn upright for a
 * tile laid with that turn.
 */
export function tileSvg(id: string, variant = 0, fixed?: number, tint = ''): string {
  const key = `${id}${variant}${fixed ?? ''}${tint}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const k = KIND[id];
  const rand = rng(`${id}${variant}`);
  const sprites: Sprite[] = [];

  // Roads and rivers. Where they cross at a bridge, or the river passes the chapel, they run true.
  const bridge = !!k.rivers && k.roads.length > 0 && k.rivers.some((r) => r.edges.length === 2 && (r.edges[1] - r.edges[0]) % 2 === 0) && k.roads.some((r) => r.edges.length === 2 && (r.edges[1] - r.edges[0]) % 2 === 0);
  const gated = k.cities.length > 0 && !k.cloister && k.roads.length === 1 && k.roads[0].edges.length === 1;
  const turning = (e: number[]) => e.length === 2 && (e[1] - e[0]) % 2 !== 0;
  const roads = k.roads.map((r) =>
    r.edges.length === 1
      ? course(r.edges, roadStop(r.edges[0], k), rand, gated ? 0 : 5)
      : bridge
        ? course(r.edges, null, rand, 5, 3, true)
        : course(r.edges, null, rand, 6, turning(r.edges) ? 2 : 1),
  );
  const rivers = (k.rivers ?? []).map((r) => {
    const [x, y] = MID[r.edges[0]];
    if (r.edges.length === 1) return course(r.edges, [x + (50 - x) * 0.8, y + (50 - y) * 0.8], rand, 5);
    // Meanders: a few swings on the straight, two on a bend; past the chapel, just a gentle wave.
    if (bridge) return course(r.edges, null, rand, 9, 3, true);
    // Bowing away east to leave the chapel room.
    if (k.cloister) return course(r.edges, null, rand, 4, 2).map((c) => c.map(([x, y]) => [x + 28 * Math.sin((Math.PI * y) / 100), y]) as Curve);
    // Squeezed between city walls, it has less room to wander.
    return turning(r.edges) ? course(r.edges, null, rand, 9, 2) : course(r.edges, null, rand, k.cities.length ? 6 : 11, 3);
  });
  const cities = k.cities.map((c) => buildCity(c.edges, rand, gated));

  // What's already taken, so trees and sheep keep to open ground.
  const busy: [Pt, number][] = [...roads.flatMap((c) => along(c, 22).map((p) => [p, 9] as [Pt, number])), ...rivers.flatMap((c) => along(c, 22).map((p) => [p, 12] as [Pt, number]))];
  if (k.cloister) busy.push([chapelAt(k), k.rivers ? 28 : 30]);
  if (k.roads.length > 2) busy.push([[50, 50], 24]);
  if (k.id === 'rL') busy.push([[50, 56], 36]);
  else if (k.rivers?.some((r) => r.edges.length === 1)) busy.push([[50, 46], 22]);
  const open = (p: Pt) => busy.every(([q, r]) => Math.hypot(p[0] - q[0], p[1] - q[1]) > r) && cities.every((c) => !inside(p, c.poly) && !wellInside(p, c.poly, 7));
  const spot = (margin = 10): Pt | null => {
    for (let i = 0; i < 12; i++) {
      const p: Pt = [margin + rand() * (100 - 2 * margin), margin + rand() * (100 - 2 * margin)];
      if (open(p)) {
        busy.push([p, 7]);
        return p;
      }
    }
    return null;
  };

  // An inn beside its road, on whichever side has room.
  k.roads.forEach((r, i) => {
    if (!r.inn) return;
    const [p0, p1, p2] = along(roads[i], 5).slice(1, 4);
    const len = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]) || 1;
    const side: Pt = [-(p2[1] - p0[1]) / len, (p2[0] - p0[0]) / len];
    const spots = [1, -1].map((d): Pt => [Math.min(84, Math.max(16, p1[0] + side[0] * d * 15)), Math.min(88, Math.max(20, p1[1] + side[1] * d * 15))]);
    const at = spots.find((q) => cities.every((c) => !inside(q, c.poly))) ?? spots[0];
    sprites.push({ at, svg: INN });
    busy.push([at, 13]);
  });
  // The ground: grass specks and flowers, the odd crop strip or pond.
  let ground = '';
  for (let i = 0; i < 30; i++) ground += `<ellipse cx="${f1(3 + rand() * 94)}" cy="${f1(3 + rand() * 94)}" rx="1.3" ry=".8" fill="${rand() < 0.6 ? COL.speck : COL.fieldLight}"/>`;
  const blooms = ['#fff8e6', '#f6d55c', '#f2a5b5', '#ffffff'];
  for (let i = 0; i < 9; i++) ground += `<circle cx="${f1(4 + rand() * 92)}" cy="${f1(4 + rand() * 92)}" r="1.1" fill="${pick(rand, blooms)}"/>`;
  for (let i = 0; i < 4; i++) {
    const x = 8 + rand() * 84;
    const y = 8 + rand() * 84;
    const c = pick(rand, blooms);
    ground += [0, 1, 2].map((j) => `<circle cx="${f1(x + Math.cos(j * 2.1) * 1.8)}" cy="${f1(y + Math.sin(j * 2.1) * 1.8)}" r="1" fill="${c}"/>`).join('');
  }
  if (rand() < 0.3) {
    const p = spot(22);
    if (p) {
      const tilt = Math.round(rand() * 60 - 30);
      ground += `<g transform="rotate(${tilt} ${f1(p[0])} ${f1(p[1])})"><rect x="${f1(p[0] - 12)}" y="${f1(p[1] - 8)}" width="24" height="16" rx="2" fill="#d9c36a"/>${[-5, -1, 3].map((d) => `<path d="M${f1(p[0] - 10)} ${f1(p[1] + d + 0.5)}h20" stroke="#bfa24a" stroke-width="1.4" stroke-linecap="round"/>`).join('')}</g>`;
      busy.push([p, 14]);
    }
  }
  // A pond of its own would muddle a river tile.
  if (rand() < 0.16 && !k.rivers) {
    const p = spot(20);
    if (p) {
      ground += `<g><ellipse cx="${f1(p[0])}" cy="${f1(p[1])}" rx="9" ry="5.5" fill="#6ea1c4" stroke="#5a8a4a" stroke-width="1.4"/><ellipse cx="${f1(p[0] - 2.5)}" cy="${f1(p[1] - 1.5)}" rx="4" ry="1.4" fill="#a9d0e8" opacity=".8"/></g>`;
      busy.push([p, 12]);
    }
  }

  // Things standing in the fields.
  const put = (svg: string, margin?: number, room = 0) => {
    const p = spot(margin);
    if (p) sprites.push({ at: p, svg });
    if (p && room) busy.push([p, room]);
  };
  // The big things first, so the small ones fit around them.
  if (rand() < 0.06) put(windmill(rand), 18, 10);
  if (rand() < 0.12) put(FENCE, 16, 13);
  if (rand() < 0.12) put(HAYSTACK, 14);
  for (let i = 0, n = 2 + Math.floor(rand() * 3); i < n; i++) put(rand() < 0.45 ? BUSH : tree(rand));
  if (rand() < 0.3) for (let i = 0, n = 1 + Math.floor(rand() * 2); i < n; i++) put(SHEEP, 12);

  // The river: banks, water, ripples; a spring or a lake; lily pads and the odd duck.
  let river = '';
  if (rivers.length) {
    // The river's start (a spring: a little pond fed from the rocks) or its end (a lake).
    const pond = k.id === 'rL' ? pondParts([50, 56], 31, 24, rand) : k.rivers!.some((r) => r.edges.length === 1) ? pondParts([50, 48], 17, 13, rand) : null;
    const rocks =
      pond && k.id !== 'rL'
        ? [[36, 42, 3.6], [41, 36.5, 2.8], [49, 34.5, 3.4], [57, 35.5, 2.6], [63.5, 40, 3.2], [33, 49, 2.4]].map(([x, y, r]) => `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${f1(r * 0.75)}" fill="#a8a192" stroke="#7a7466" stroke-width=".5"/><ellipse cx="${f1(x - r * 0.3)}" cy="${f1(y - r * 0.3)}" rx="${f1(r * 0.4)}" ry="${f1(r * 0.25)}" fill="#c9c3b5"/>`).join('')
        : '';
    const pts = rivers.flatMap((c) => along(c, 5));
    const pads = pts
      .filter(() => rand() < 0.35)
      .map(([x, y]) => `<circle cx="${f1(x + (rand() - 0.5) * 6)}" cy="${f1(y + (rand() - 0.5) * 6)}" r="2" fill="#6fae4f"/>`)
      .join('');
    if (rand() < 0.45 && !bridge) sprites.push({ at: pick(rand, pts), svg: DUCK });
    const parts = rivers.map((c) => riverParts(c, rand));
    river = `${parts.map((x) => x.bank).join('')}${pond?.bank ?? ''}${parts.map((x) => x.water).join('')}${pond?.water ?? ''}${parts.map((x) => x.waves).join('')}${rocks}${pads}`;
    if (k.id === 'rL') for (const p of [[26, 70], [30, 72], [73, 68], [69, 71]] as Pt[]) sprites.push({ at: p, svg: '<path d="M0 0l-1-7M1 0l1.5-6.5" stroke="#4f7f37" stroke-width="1.2" stroke-linecap="round"/>' });
  }

  // Roads: verge, edge, sandy middle, ruts and pebbles.
  let road = '';
  if (roads.length) {
    const paths = roads.map(courseD);
    const layer = (stroke: string, width: number, extra = '') => `<g fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"${extra}>${paths.map((d) => `<path d="${d}"/>`).join('')}</g>`;
    const pebbles = roads
      .flatMap((c) => along(c, 9))
      .map(([x, y]) => `<circle cx="${f1(x + (rand() - 0.5) * 7)}" cy="${f1(y + (rand() - 0.5) * 7)}" r="${f1(0.5 + rand() * 0.5)}" fill="#bba98a"/>`)
      .join('');
    road = `${layer('rgba(70,110,40,.3)', 19)}${layer(COL.roadEdge, 15)}${layer(COL.road, 11)}${layer(COL.rut, 1.1, ' stroke-dasharray="2.4 3"')}${pebbles}`;
  }
  const plaza =
    k.roads.length > 2
      ? `<circle cx="50" cy="52" r="20" fill="${COL.roadEdge}"/><circle cx="50" cy="52" r="18.4" fill="${COL.city}"/>${Array.from({ length: 14 }, () => `<rect x="${f1(36 + rand() * 26)}" y="${f1(38 + rand() * 26)}" width="3" height="2" rx=".8" fill="${COL.cobble}" opacity=".7"/>`).join('')}`
      : '';
  const bridgeSvg = bridge
    ? `<g transform="rotate(${k.roads[0].edges.includes(1) ? 0 : 90} 50 50)" stroke="#5a3e24" stroke-linecap="round"><path d="M37 42.5H63M37 57.5H63" stroke-width="2.4"/>${[39, 45, 51, 57, 61].map((x) => `<path d="M${x} 42.5v-2.2M${x} 57.5v2.2" stroke-width="1.4"/>`).join('')}<path d="M40 46H60M40 50H60M40 54H60" stroke="#c8a873" stroke-width=".7" opacity=".9"/></g>`
    : '';

  // Cities: paving, uneven walls with towers at their corners, packed little houses.
  const cityGround = cities
    .map((c, i) => {
      const clip = `lc-${key}-${i}`;
      const pts = c.poly.map((p) => `${f1(p[0])} ${f1(p[1])}`).join(' ');
      const wallD = c.walls.map((w) => `M${w.map((p) => `${f1(p[0])} ${f1(p[1])}`).join('L')}`).join('');
      return `<clipPath id="${clip}"><polygon points="${pts}"/></clipPath><polygon points="${pts}" fill="${COL.city}"/>
        <g clip-path="url(#${clip})" fill="${COL.cobble}" opacity=".6">${Array.from({ length: 30 }, () => `<rect x="${f1(rand() * 100)}" y="${f1(rand() * 100)}" width="3" height="2" rx=".8"/>`).join('')}</g>
        ${wallD ? `<g fill="none" stroke-linejoin="round" stroke-linecap="round"><path d="${wallD}" stroke="${COL.wall}" stroke-width="6.5"/><path d="${wallD}" stroke="${COL.stone}" stroke-width="4.3"/><path d="${wallD}" stroke="${COL.wallTop}" stroke-width="4.3" stroke-dasharray="2.4 2.2" stroke-linecap="butt"/></g>` : ''}`;
    })
    .join('');
  k.cities.forEach((kc, i) => {
    const c = cities[i];
    const taken: [Pt, number][] = [];
    const corners = c.walls.flatMap((w) => w.slice(1, -1));
    corners.forEach((p, j) => {
      if (j === 0 || rand() < 0.7) {
        sprites.push({ at: p, svg: tower(rand) });
        taken.push([p, 6]);
      }
    });
    if (gated) {
      const g = c.walls[0][2];
      sprites.push({ at: g, svg: GATE });
      taken.push([g, 8]);
    }
    const middle = anchor('city', kc.edges);
    if (kc.cathedral) {
      sprites.push({ at: [50, 60], svg: CATHEDRAL });
      taken.push([[50, 52], 21]);
    } else if (kc.edges.length >= 3) {
      const at: Pt = [middle[0] + 6, middle[1] - 6];
      sprites.push({ at, svg: tower(rand, true) });
      taken.push([at, 9]);
    }
    if (kc.shield) {
      const at: Pt = [middle[0] + 10, middle[1] + 14];
      sprites.push({ at, svg: shield() });
      taken.push([at, 11], [[at[0], at[1] - 10], 9]);
    }
    // Followers stand at the middle; leave them room.
    taken.push([middle, 6]);
    // Kept off the tile's edges, where a roof would be cut off whichever way the tile turns.
    for (let y = 10; y < 92; y += 10.5) {
      for (let x = 9 + (Math.round(y) % 2) * 6; x < 92; x += 12.5) {
        const p: Pt = [x + (rand() - 0.5) * 4, y + (rand() - 0.5) * 3];
        if (!wellInside(p, c.poly, 4.5) || taken.some(([q, r]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < r)) continue;
        sprites.push({ at: p, svg: house(rand) });
      }
    }
  });

  // Where three or four roads meet, they end at a hamlet: a little square closed in by houses.
  if (k.roads.length > 2) {
    for (const [at, scale] of [[[41, 47], 1.5], [[59, 46], 1.45], [[50, 52], 1.6], [[42, 61], 1.35], [[59, 61], 1.4]] as [Pt, number][]) sprites.push({ at, svg: house(rand), scale });
  }
  if (k.cloister) {
    const [x, y] = chapelAt(k);
    // By the river it stands a little off the middle, a touch smaller, so it stays on the tile whichever way that turns.
    sprites.push(k.rivers ? { at: [x, y + 10], svg: CHAPEL, scale: 0.92 } : { at: [x, y + 10], svg: CHAPEL });
  }

  const glow = `<circle cx="${f1(20 + rand() * 60)}" cy="${f1(20 + rand() * 60)}" r="38" fill="${COL.fieldLight}" opacity=".45"/>`;
  const claims = tint ? claimed(k, tint, cities, roads, rivers) : { fields: '', rest: '' };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true">
  <rect width="100" height="100" fill="${COL.field}"/>
  ${glow}${ground}${claims.fields}${river}${road}${plaza}${bridgeSvg}${cityGround}${claims.rest}${spritesSvg(sprites, fixed)}
  <radialGradient id="lv"><stop offset=".62" stop-color="#2a1d0e" stop-opacity="0"/><stop offset="1" stop-color="#2a1d0e" stop-opacity=".2"/></radialGradient>
  <rect width="100" height="100" fill="url(#lv)"/>
  <rect x=".6" y=".6" width="98.8" height="98.8" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1.2"/>
  <rect width="100" height="100" fill="none" stroke="rgba(0,0,0,.22)" stroke-width=".8"/>
</svg>`;
  cache.set(key, svg);
  return svg;
}

// ───────────────────────── claimed ground ─────────────────────────

/**
 * Who holds what on a tile, for a faint wash of their colour: parts as `city0`, `road1`,
 * `field0`, each with its holders' colours (more than one when they're tied), e.g.
 * `city0=#f2c94c;field1=#e67e22+#8e6bbf`.
 */
function parseTint(tint: string): Map<string, string[]> {
  return new Map(tint.split(';').filter(Boolean).map((x) => {
    const [part, colours] = x.split('=');
    return [part, colours.split('+')];
  }));
}

/**
 * The washes for a tile's claimed parts: fields go under the roads, rivers and cities (so they
 * only need to reach roughly up to them); cities and roads go over their paving, under the
 * houses. Fields are found by filling outward from their edge halves on a fine grid, stopping at
 * walls, roads and rivers.
 */
function claimed(k: TileKind, tint: string, cities: City[], roads: Curve[][], rivers: Curve[][]): { fields: string; rest: string } {
  const by = parseTint(tint);
  const defs: string[] = [];
  const paint = (colours: string[]) => {
    if (colours.length === 1) return colours[0];
    // Tied: their colours shading into each other across the tile.
    const id = `tie${defs.length}`;
    defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="20" y1="20" x2="80" y2="80">${colours.map((c, i) => `<stop offset="${f1((i / (colours.length - 1)) * 100)}%" stop-color="${c}"/>`).join('')}</linearGradient>`);
    return `url(#${id})`;
  };

  let fields = '';
  if (k.fields.some((_, j) => by.has(`field${j}`))) {
    const N = 50;
    const C = 100 / N;
    const lines = [...roads, ...rivers].flatMap((c) => along(c, 40));
    const grid = new Int8Array(N * N).fill(-1);
    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        const p: Pt = [(gx + 0.5) * C, (gy + 0.5) * C];
        if (cities.some((c) => inside(p, c.poly)) || lines.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 5)) grid[gy * N + gx] = -2;
      }
    }
    const queue: number[] = [];
    k.fields.forEach((f, j) => {
      for (const h of f.halves) {
        for (const amount of [0.04, 0.12, 0.2, 0.3]) {
          const [x, y] = toward(HALF_AT[h], amount);
          const cell = Math.min(N - 1, Math.floor(y / C)) * N + Math.min(N - 1, Math.floor(x / C));
          if (grid[cell] === -1) {
            grid[cell] = j;
            queue.push(cell);
            break;
          }
          if (grid[cell] !== -2) break;
        }
      }
    });
    for (let q = 0; q < queue.length; q++) {
      const cell = queue[q];
      const gx = cell % N;
      for (const next of [gx > 0 ? cell - 1 : -1, gx < N - 1 ? cell + 1 : -1, cell - N, cell + N]) {
        if (next < 0 || next >= N * N || grid[next] !== -1) continue;
        grid[next] = grid[cell];
        queue.push(next);
      }
    }
    // How far each cell is from a road, river or wall, so a field's border can be drawn bolder.
    const far = new Int8Array(N * N).fill(99);
    const near: number[] = [];
    grid.forEach((g, cell) => g === -2 && (far[cell] = 0, near.push(cell)));
    for (let q = 0; q < near.length; q++) {
      const cell = near[q];
      const gx = cell % N;
      for (const next of [gx > 0 ? cell - 1 : -1, gx < N - 1 ? cell + 1 : -1, cell - N, cell + N]) {
        if (next < 0 || next >= N * N || far[next] <= far[cell] + 1) continue;
        far[next] = far[cell] + 1;
        near.push(next);
      }
    }
    // Each row's runs of a field's cells, a touch overlapped so no seams show.
    const runs = (keep: (cell: number) => boolean) => {
      let d = '';
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          if (!keep(gy * N + gx)) continue;
          const start = gx;
          while (gx + 1 < N && keep(gy * N + gx + 1)) gx++;
          d += `M${f1(start * C)} ${f1(gy * C)}h${f1((gx - start + 1) * C)}v${f1(C + 0.3)}h${f1(-(gx - start + 1) * C)}z`;
        }
      }
      return d;
    };
    k.fields.forEach((_, j) => {
      const colours = by.get(`field${j}`);
      if (!colours) return;
      const fill = paint(colours);
      // A light wash over the whole field, and a stronger band along its borders.
      fields += `<path d="${runs((c) => grid[c] === j)}" fill="${fill}" opacity=".22" filter="url(#soft)"/>`;
      fields += `<path d="${runs((c) => grid[c] === j && far[c] <= 4)}" fill="${fill}" opacity=".6" filter="url(#soft)"/>`;
    });
  }

  let rest = '';
  k.cities.forEach((_, i) => {
    const colours = by.get(`city${i}`);
    if (!colours) return;
    // A wash over the paving, and the wall tops in their colours like banners.
    const fill = paint(colours);
    const wallD = cities[i].walls.map((w) => `M${w.map((p) => `${f1(p[0])} ${f1(p[1])}`).join('L')}`).join('');
    rest += `<polygon points="${cities[i].poly.map((p) => `${f1(p[0])} ${f1(p[1])}`).join(' ')}" fill="${fill}" opacity=".3"/>`;
    if (wallD) rest += `<path d="${wallD}" fill="none" stroke="${fill}" stroke-width="4.3" stroke-linejoin="round" stroke-dasharray="2.4 2.2" opacity=".85"/>`;
  });
  k.roads.forEach((_, i) => {
    const colours = by.get(`road${i}`);
    if (colours) rest += `<path d="${courseD(roads[i])}" fill="none" stroke="${paint(colours)}" stroke-width="10" stroke-linecap="round" opacity=".3"/><path d="${courseD(roads[i])}" fill="none" stroke="${paint(colours)}" stroke-width="3.2" stroke-linecap="round" opacity=".85"/>`;
  });
  const filter = fields ? '<filter id="soft" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="1.6"/></filter>' : '';
  return { fields: `${defs.length || filter ? `<defs>${filter}${defs.join('')}</defs>` : ''}${fields}`, rest };
}

const images = new Map<string, string>();
/**
 * A laid tile as a plain image (sprites already upright for turn `r`): one element to paint
 * instead of hundreds, which keeps a full board quick. `tint` washes its claimed parts.
 */
export function tileImage(id: string, variant: number, r: number, tint = ''): string {
  const key = `${id}${variant}@${r}${tint}`;
  let url = images.get(key);
  if (!url) images.set(key, (url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(tileSvg(id, variant, r, tint))}`));
  return url;
}

// ───────────────────────── where followers stand ─────────────────────────

const HALF_AT: [number, number][] = [
  [25, 0],
  [75, 0],
  [100, 25],
  [100, 75],
  [75, 100],
  [25, 100],
  [0, 75],
  [0, 25],
];

const toward = ([x, y]: [number, number], amount: number): [number, number] => [x + (50 - x) * amount, y + (50 - y) * amount];
const avg = (pts: [number, number][]): [number, number] => [pts.reduce((n, p) => n + p[0], 0) / pts.length, pts.reduce((n, p) => n + p[1], 0) / pts.length];

/** A good spot for a follower on a part, given the edges (cities, roads) it reaches. */
function anchor(part: 'city' | 'road', edges: number[]): [number, number] {
  const mids = edges.map((e) => [...MID[e]] as [number, number]);
  if (part === 'city') {
    if (edges.length === 4) return [50, 50];
    if (edges.length === 1) return toward(mids[0], 0.26);
    return toward(avg(mids), 0.1);
  }
  if (edges.length === 1) return toward(mids[0], 0.55);
  // Middle of the road's curve (or line).
  return [0.25 * mids[0][0] + 25 + 0.25 * mids[1][0], 0.25 * mids[0][1] + 25 + 0.25 * mids[1][1]];
}

const spots = new Map<string, Map<string, [number, number]>>();

/**
 * Where a follower on part `i` of a tile kind stands, on the unturned 100 × 100 tile. Cities,
 * roads and cloisters have natural spots; a field takes whichever of its candidate spots is
 * furthest from everything else on the tile, so no two spots overlap.
 */
export function spotOf(id: string, part: Part, i: number): [number, number] {
  let m = spots.get(id);
  if (!m) {
    m = new Map();
    const k = KIND[id];
    k.cities.forEach((c, j) => m!.set(`city${j}`, anchor('city', c.edges)));
    k.roads.forEach((r, j) => m!.set(`road${j}`, anchor('road', r.edges)));
    if (k.cloister) m.set('cloister0', chapelAt(k));
    k.fields.forEach((f, j) => {
      const pts = f.halves.map((h) => HALF_AT[h]);
      const candidates = [toward(avg(pts), 0.15), ...pts.map((p) => toward(p, 0.24))];
      const taken = [...m!.values()];
      const room = (c: [number, number]) => Math.min(...taken.map((t) => Math.hypot(t[0] - c[0], t[1] - c[1])), 99);
      m!.set(`field${j}`, candidates.reduce((a, b) => (room(b) > room(a) + 4 ? b : a)));
    });
    spots.set(id, m);
  }
  return m.get(`${part}${i}`)!;
}

/** That spot once the tile is turned `r` quarter turns clockwise. */
export function turnedSpot([x, y]: [number, number], r: number): [number, number] {
  let p: [number, number] = [x, y];
  for (let n = 0; n < r; n++) p = [100 - p[1], p[0]];
  return p;
}

/** Player colours for followers and score pop-ups: you, then the animals. */
export const PLAYER_COLOURS = ['#f2c94c', '#e67e22', '#8e6bbf', '#8b5a3c'];

/** A follower: a little pawn (the big boy is the same pawn, just bigger); farmers lie down in their field. */
export function followerSvg(p: number, part: Part, big = false): string {
  const c = PLAYER_COLOURS[p];
  return `<svg viewBox="0 0 20 24" aria-hidden="true"${big ? ' class="big"' : ''}${part === 'field' ? ' style="rotate:90deg"' : ''}><path d="M10 1.5a4.2 4.2 0 0 1 2.6 7.5l3.6 2.3c1.6 1 2.3 3 1.6 4.8L16 22.5H4l-1.8-6.4c-.7-1.8 0-3.8 1.6-4.8L7.4 9A4.2 4.2 0 0 1 10 1.5z" fill="${c}" stroke="#2b2117" stroke-width="${big ? 1.1 : 1.4}" stroke-linejoin="round"/></svg>`;
}
