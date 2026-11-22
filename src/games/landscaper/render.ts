import type { Part } from './rules';
import { KIND, type TileKind } from './tiles';

/**
 * Landscaper's tiles drawn in code, as flat SVG on a 100 × 100 square: green fields, pale roads,
 * stone cities with shields, and a little chapel for cloisters. Drawn unturned; the board turns
 * the whole tile.
 */

const COL = {
  field: '#86b25f',
  fieldDark: '#77a352',
  road: '#f3e7c6',
  roadEdge: '#a98f63',
  city: '#d8c49a',
  cityInner: '#e7d8b4',
  wall: '#7a6544',
  roof: '#b4482f',
  shield: '#2f5fa8',
};

const MID = [
  [50, 0],
  [100, 50],
  [50, 100],
  [0, 50],
] as const;

const turn = (deg: number) => (deg ? ` transform="rotate(${deg} 50 50)"` : '');

/** Path for a city touching `edges`, drawn for its base orientation and turned into place. */
function cityPath(edges: number[]): string {
  const e = [...edges].sort();
  if (e.length === 4) return '<rect x="0" y="0" width="100" height="100"/>';
  if (e.length === 3) {
    const missing = [0, 1, 2, 3].find((x) => !e.includes(x))!;
    return `<path d="M0 0H100V100C70 68 30 68 0 100Z"${turn((missing - 2) * 90)}/>`;
  }
  if (e.length === 2 && (e[1] - e[0]) % 2 === 0) {
    // A band across the tile (east–west as drawn).
    return `<path d="M0 0C30 28 70 28 100 0V100C70 72 30 72 0 100Z"${turn(e[0] === 0 ? 90 : 0)}/>`;
  }
  if (e.length === 2) {
    // Two neighbouring edges: drawn as north + west.
    const first = e[0] === 0 && e[1] === 3 ? 3 : e[0];
    return `<path d="M0 0H100C60 25 25 60 0 100Z"${turn(((first - 3 + 4) % 4) * 90)}/>`;
  }
  return `<path d="M0 0H100C78 32 22 32 0 0Z"${turn(e[0] * 90)}/>`;
}

function roadPath(edges: number[], k: TileKind): string {
  const [a, b] = edges;
  if (b !== undefined) {
    const [x1, y1] = MID[a];
    const [x2, y2] = MID[b];
    return (b - a) % 2 === 0 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}Q50 50 ${x2} ${y2}`;
  }
  // A road ending on this tile: at the cloister, the city, or the junction in the middle.
  const [x, y] = MID[a];
  const stop = k.cloister ? 0.7 : k.roads.length === 1 ? 0.5 : 1;
  return `M${x} ${y}L${x + (50 - x) * stop} ${y + (50 - y) * stop}`;
}

/** Shield position for a city: towards the middle of its part. */
function shieldAt(edges: number[]): [number, number] {
  const p = anchor('city', edges);
  return [p[0] + 9, p[1] + 9];
}

/** A small deterministic sprinkle of darker grass so fields aren't flat. */
function tufts(seed: string) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  const rand = () => ((h = (h * 1103515245 + 12345) | 0) >>> 8) / 16777216;
  return Array.from({ length: 7 }, () => `<circle cx="${(8 + rand() * 84).toFixed(1)}" cy="${(8 + rand() * 84).toFixed(1)}" r="${(1.4 + rand() * 1.6).toFixed(1)}"/>`).join('');
}

const cache = new Map<string, string>();

/** The SVG for a tile kind, unturned. */
export function tileSvg(id: string): string {
  const hit = cache.get(id);
  if (hit) return hit;
  const k = KIND[id];
  const roads = k.roads.map((r) => roadPath(r.edges, k));
  const svg = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <rect width="100" height="100" fill="${COL.field}"/>
  <g fill="${COL.fieldDark}" opacity="0.6">${tufts(id)}</g>
  ${roads.length ? `<g fill="none" stroke-linecap="round"><g stroke="${COL.roadEdge}" stroke-width="15">${roads.map((d) => `<path d="${d}"/>`).join('')}</g><g stroke="${COL.road}" stroke-width="10.5">${roads.map((d) => `<path d="${d}"/>`).join('')}</g></g>` : ''}
  ${k.roads.length > 2 ? `<circle cx="50" cy="50" r="7" fill="${COL.roadEdge}"/><circle cx="50" cy="50" r="4.5" fill="${COL.road}"/>` : ''}
  <g fill="${COL.city}" stroke="${COL.wall}" stroke-width="2.5" stroke-linejoin="round">${k.cities.map((c) => cityPath(c.edges)).join('')}</g>
  ${k.cities
    .filter((c) => c.shield)
    .map((c) => {
      const [x, y] = shieldAt(c.edges);
      return `<path d="M${x - 5} ${y - 6}h10v6c0 4-5 7-5 7s-5-3-5-7z" fill="${COL.shield}" stroke="#fff" stroke-width="1.2"/>`;
    })
    .join('')}
  ${k.cloister ? `<g stroke="${COL.wall}" stroke-width="1.6" stroke-linejoin="round"><rect x="38" y="44" width="24" height="18" fill="#efe4c8"/><path d="M35 45L50 32L65 45Z" fill="${COL.roof}"/><rect x="47" y="52" width="6" height="10" fill="${COL.wall}"/></g>` : ''}
  <rect width="100" height="100" fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1"/>
</svg>`;
  cache.set(id, svg);
  return svg;
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
    if (k.cloister) m.set('cloister0', [50, 50]);
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

/** A follower: a little pawn; farmers lie down in their field. */
export function followerSvg(p: number, part: Part): string {
  const c = PLAYER_COLOURS[p];
  return `<svg viewBox="0 0 20 24" aria-hidden="true"${part === 'field' ? ' style="rotate:90deg"' : ''}><path d="M10 1.5a4.2 4.2 0 0 1 2.6 7.5l3.6 2.3c1.6 1 2.3 3 1.6 4.8L16 22.5H4l-1.8-6.4c-.7-1.8 0-3.8 1.6-4.8L7.4 9A4.2 4.2 0 0 1 10 1.5z" fill="${c}" stroke="#2b2117" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
}
