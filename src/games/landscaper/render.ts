import type { Part } from './rules';
import { KIND, type TileKind } from './tiles';

/**
 * Landscaper's tiles drawn in code, as SVG on a 100 × 100 square, in a quaint storybook style:
 * fields with grass, flowers, bushes and trees; rutted sandy roads; walled cities packed with
 * red-roofed houses and pennant shields; a chapel with a bell tower and garden for cloisters; a
 * well at crossroads. Each kind has a few variants so repeated tiles don't look stamped. Drawn
 * unturned; the board turns the whole tile.
 */

const COL = {
  field: '#8cbc62',
  fieldLight: '#9cc86f',
  grass: '#6f9e48',
  bush: '#5c8f3d',
  bushLight: '#78a852',
  trunk: '#7a5634',
  road: '#ead9ad',
  roadEdge: '#9c8257',
  rut: '#c9b183',
  city: '#d9c49b',
  cobble: '#c8b386',
  wall: '#6d5636',
  wallTop: '#cdb98f',
  house: '#f1e5c6',
  roofs: ['#b4482f', '#c45d36', '#9e3b2a', '#b8683a'],
  shield: '#2e5aa6',
};

const MID = [
  [50, 0],
  [100, 50],
  [50, 100],
  [0, 50],
] as const;

const turn = (deg: number) => (deg ? ` transform="rotate(${deg} 50 50)"` : '');

type Pt = [number, number];
type Curve = [Pt, Pt, Pt, Pt];

/**
 * A city part's shape: its filled area, the wall curves (inside the tile, not along its edges),
 * where towers stand on them (as fractions along each curve), and the turn that puts it in place.
 */
function cityShape(edges: number[]): { fill: string; walls: Curve[]; towers: number[]; deg: number } {
  const e = [...edges].sort();
  if (e.length === 4) return { fill: 'M0 0H100V100H0Z', walls: [], towers: [], deg: 0 };
  if (e.length === 3) {
    const missing = [0, 1, 2, 3].find((x) => !e.includes(x))!;
    return { fill: 'M0 0H100V100C70 68 30 68 0 100Z', walls: [[[100, 100], [70, 68], [30, 68], [0, 100]]], towers: [0.3, 0.7], deg: (missing - 2) * 90 };
  }
  if (e.length === 2 && (e[1] - e[0]) % 2 === 0) {
    return {
      fill: 'M0 0C30 28 70 28 100 0V100C70 72 30 72 0 100Z',
      walls: [
        [[0, 0], [30, 28], [70, 28], [100, 0]],
        [[100, 100], [70, 72], [30, 72], [0, 100]],
      ],
      towers: [0.5],
      deg: e[0] === 0 ? 90 : 0,
    };
  }
  if (e.length === 2) {
    const first = e[0] === 0 && e[1] === 3 ? 3 : e[0];
    return { fill: 'M0 0H100C60 25 25 60 0 100Z', walls: [[[100, 0], [60, 25], [25, 60], [0, 100]]], towers: [0.3, 0.7], deg: ((first - 3 + 4) % 4) * 90 };
  }
  return { fill: 'M0 0H100C78 32 22 32 0 0Z', walls: [[[100, 0], [78, 32], [22, 32], [0, 0]]], towers: [0.5], deg: e[0] * 90 };
}

const curveD = ([a, b, c, d]: Curve) => `M${a[0]} ${a[1]}C${b[0]} ${b[1]} ${c[0]} ${c[1]} ${d[0]} ${d[1]}`;
function onCurve([a, b, c, d]: Curve, t: number): Pt {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [w[0] * a[0] + w[1] * b[0] + w[2] * c[0] + w[3] * d[0], w[0] * a[1] + w[1] * b[1] + w[2] * c[1] + w[3] * d[1]];
}

/** A river's course: like a road between two edges; from an edge to the middle for the spring or lake. */
function riverPath(edges: number[]): string {
  const [a, b] = edges;
  const [x1, y1] = MID[a];
  if (b === undefined) return `M${x1} ${y1}L${x1 + (50 - x1) * 0.8} ${y1 + (50 - y1) * 0.8}`;
  const [x2, y2] = MID[b];
  return (b - a) % 2 === 0 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}Q50 50 ${x2} ${y2}`;
}

/** Points along a river or road between two edges (or from an edge in to `stop`). */
function along(edges: number[], n: number, stop = 0.8): Pt[] {
  const [a, b] = edges;
  const [x1, y1] = MID[a];
  const end: Pt = b !== undefined ? [MID[b][0], MID[b][1]] : [x1 + (50 - x1) * stop, y1 + (50 - y1) * stop];
  const curved = b !== undefined && (b - a) % 2 !== 0;
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / n;
    if (!curved) return [x1 + (end[0] - x1) * t, y1 + (end[1] - y1) * t];
    const u = 1 - t;
    return [u * u * x1 + 2 * u * t * 50 + t * t * end[0], u * u * y1 + 2 * u * t * 50 + t * t * end[1]];
  });
}

/** The river layer: banks, water, ripples; a spring or a lake; lily pads and the odd duck. */
function riverLayer(k: TileKind, rand: () => number): string {
  if (!k.rivers) return '';
  const paths = k.rivers.map((r) => riverPath(r.edges));
  const stroke = (c: string, w: number, extra = '') => `<g fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round"${extra}>${paths.map((d) => `<path d="${d}"/>`).join('')}</g>`;
  const end = k.rivers.find((r) => r.edges.length === 1);
  let pool = '';
  if (end && k.id === 'rL') {
    pool = `<g><ellipse cx="50" cy="56" rx="34" ry="27" fill="#6d8f4c" opacity=".55"/><ellipse cx="50" cy="56" rx="31" ry="24" fill="#5c9cc9"/><ellipse cx="45" cy="52" rx="20" ry="12" fill="#8cc2e4" opacity=".7"/>
      <path d="M26 70l-2-8M29 71l1-9M73 68l2-8M70 70l-1-9" stroke="#4f7f37" stroke-width="1.3" stroke-linecap="round"/><circle cx="62" cy="62" r="2.6" fill="#5c8f3d"/><circle cx="38" cy="47" r="2.2" fill="#5c8f3d"/></g>`;
  } else if (end) {
    pool = `<g><circle cx="50" cy="50" r="12" fill="#6d8f4c" opacity=".5"/><circle cx="50" cy="50" r="10" fill="#5c9cc9"/><circle cx="47" cy="47" r="5" fill="#8cc2e4" opacity=".8"/>${[0, 1, 2, 3, 4, 5].map((i) => `<circle cx="${f1(50 + Math.cos(i * 1.05) * 11)}" cy="${f1(50 + Math.sin(i * 1.05) * 11)}" r="2.2" fill="#b9b2a2" stroke="#7f7867" stroke-width=".5"/>`).join('')}</g>`;
  }
  const pts = k.rivers.flatMap((r) => along(r.edges, 4));
  const pads = pts
    .filter(() => rand() < 0.35)
    .map(([x, y]) => `<circle cx="${f1(x + (rand() - 0.5) * 6)}" cy="${f1(y + (rand() - 0.5) * 6)}" r="2" fill="#6fae4f"/>`)
    .join('');
  const duck =
    rand() < 0.45 && pts.length
      ? (() => {
          const [x, y] = pts[Math.floor(rand() * pts.length)];
          return `<g transform="translate(${f1(x)} ${f1(y)})"><ellipse cx="0" cy="0" rx="2.6" ry="1.6" fill="#f4f0e0"/><circle cx="2" cy="-1.2" r="1.1" fill="#2f6b3a"/><path d="M3 -1.2l1.2 .3" stroke="#e8a33d" stroke-width=".8"/></g>`;
        })()
      : '';
  return `${stroke('rgba(80,110,60,.55)', 20)}${stroke('#5c9cc9', 15)}${stroke('#8cc2e4', 6, ' opacity=".8"')}${stroke('#ffffff', 0.9, ' stroke-dasharray="3 5" opacity=".7"')}${pool}${pads}${duck}`;
}

/** A timber bridge where a road crosses the river. */
function bridges(k: TileKind): string {
  if (!k.rivers || !k.roads.length) return '';
  const crossing = k.rivers.some((r) => r.edges.length === 2 && (r.edges[1] - r.edges[0]) % 2 === 0) && k.roads.some((r) => r.edges.length === 2 && (r.edges[1] - r.edges[0]) % 2 === 0);
  if (!crossing) return '';
  const deg = k.roads[0].edges.includes(1) ? 0 : 90;
  return `<g transform="rotate(${deg} 50 50)" stroke="#5a3e24" stroke-linecap="round"><path d="M37 42.5H63M37 57.5H63" stroke-width="2.4"/>${[39, 45, 51, 57, 61].map((x) => `<path d="M${x} 42.5v-2.2M${x} 57.5v2.2" stroke-width="1.4"/>`).join('')}<path d="M40 46H60M40 50H60M40 54H60" stroke="#c8a873" stroke-width=".7" opacity=".9"/></g>`;
}

/** Points along a road's middle, for pebbles. */
function roadPoints(edges: number[], k: TileKind, n: number): Pt[] {
  const [a, b] = edges;
  const [x1, y1] = MID[a];
  const end: Pt =
    b !== undefined ? [MID[b][0], MID[b][1]] : (() => {
      const stop = k.cloister ? 0.7 : k.roads.length === 1 ? 0.5 : 1;
      return [x1 + (50 - x1) * stop, y1 + (50 - y1) * stop];
    })();
  const curved = b !== undefined && (b - a) % 2 !== 0;
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / n;
    if (!curved) return [x1 + (end[0] - x1) * t, y1 + (end[1] - y1) * t];
    const u = 1 - t;
    return [u * u * x1 + 2 * u * t * 50 + t * t * end[0], u * u * y1 + 2 * u * t * 50 + t * t * end[1]];
  });
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
  const stop = k.cloister ? (k.rivers ? 0.28 : 0.7) : k.roads.length === 1 ? 0.5 : 1;
  return `M${x} ${y}L${x + (50 - x) * stop} ${y + (50 - y) * stop}`;
}

/** Where the chapel stands: the middle, or beside the river on a riverside cloister. */
const chapelAt = (k: TileKind): Pt => (k.rivers ? [27, 50] : [50, 50]);

function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
}
const f1 = (n: number) => n.toFixed(1);

/** Grass tufts, flowers, bushes and the odd tree, all over; roads and cities are drawn on top. */
function countryside(rand: () => number) {
  let out = '';
  for (let i = 0; i < 26; i++) {
    const x = 4 + rand() * 92;
    const y = 4 + rand() * 92;
    out += `<path d="M${f1(x - 1.6)} ${f1(y)}l1.6-3.2l1.6 3.2M${f1(x)} ${f1(y)}l.4-3.8" stroke="${COL.grass}" stroke-width=".8" fill="none" stroke-linecap="round"/>`;
  }
  const blooms = ['#fff8e6', '#f6d55c', '#f2a5b5', '#ffffff'];
  for (let i = 0; i < 9; i++) {
    out += `<circle cx="${f1(4 + rand() * 92)}" cy="${f1(4 + rand() * 92)}" r="1.1" fill="${blooms[Math.floor(rand() * blooms.length)]}"/>`;
  }
  for (let i = 0; i < 3; i++) {
    const x = 10 + rand() * 80;
    const y = 10 + rand() * 80;
    out += `<g><ellipse cx="${f1(x + 1)}" cy="${f1(y + 2.5)}" rx="5" ry="2" fill="rgba(0,0,0,.15)"/><circle cx="${f1(x - 2)}" cy="${f1(y)}" r="3" fill="${COL.bush}"/><circle cx="${f1(x + 2)}" cy="${f1(y - 0.5)}" r="3.4" fill="${COL.bush}"/><circle cx="${f1(x + 0.6)}" cy="${f1(y - 1.6)}" r="2" fill="${COL.bushLight}"/></g>`;
  }
  if (rand() < 0.25) {
    // A strip of crops, rows and all.
    const x = 14 + rand() * 50;
    const y = 14 + rand() * 50;
    const tilt = Math.round(rand() * 40 - 20);
    out += `<g transform="rotate(${tilt} ${f1(x + 12)} ${f1(y + 8)})"><rect x="${f1(x)}" y="${f1(y)}" width="24" height="16" rx="2" fill="#d9c36a"/>${[3, 7, 11].map((d) => `<path d="M${f1(x + 2)} ${f1(y + d + 0.5)}h20" stroke="#bfa24a" stroke-width="1.4" stroke-linecap="round"/>`).join('')}</g>`;
  }
  if (rand() < 0.16) {
    const x = 18 + rand() * 64;
    const y = 18 + rand() * 64;
    out += `<g><ellipse cx="${f1(x)}" cy="${f1(y)}" rx="9" ry="5.5" fill="#6ea1c4" stroke="#5a8a4a" stroke-width="1.4"/><ellipse cx="${f1(x - 2.5)}" cy="${f1(y - 1.5)}" rx="4" ry="1.4" fill="#a9d0e8" opacity=".8"/><circle cx="${f1(x + 5)}" cy="${f1(y + 1)}" r="1.3" fill="#7fbf6a"/></g>`;
  }
  for (let i = 0; i < 4; i++) {
    const x = 8 + rand() * 84;
    const y = 8 + rand() * 84;
    const c = blooms[Math.floor(rand() * blooms.length)];
    out += [0, 1, 2].map((j) => `<circle cx="${f1(x + Math.cos(j * 2.1) * 1.8)}" cy="${f1(y + Math.sin(j * 2.1) * 1.8)}" r="1" fill="${c}"/>`).join('');
  }
  if (rand() < 0.7) {
    const x = 12 + rand() * 76;
    const y = 14 + rand() * 72;
    out +=
      rand() < 0.5
        ? `<g><ellipse cx="${f1(x + 2)}" cy="${f1(y + 7)}" rx="6" ry="2.2" fill="rgba(0,0,0,.18)"/><rect x="${f1(x - 1)}" y="${f1(y + 1)}" width="2" height="6" rx=".6" fill="${COL.trunk}"/><circle cx="${f1(x)}" cy="${f1(y - 2)}" r="6" fill="${COL.bush}"/><circle cx="${f1(x - 1.8)}" cy="${f1(y - 3.6)}" r="3.2" fill="${COL.bushLight}"/></g>`
        : `<g><ellipse cx="${f1(x + 2)}" cy="${f1(y + 6)}" rx="5" ry="2" fill="rgba(0,0,0,.18)"/><path d="M${f1(x)} ${f1(y - 9)}L${f1(x + 5)} ${f1(y + 1)}H${f1(x - 5)}Z" fill="#4f7f37"/><path d="M${f1(x)} ${f1(y - 5)}L${f1(x + 6)} ${f1(y + 5)}H${f1(x - 6)}Z" fill="#5c8f3d"/><rect x="${f1(x - 0.8)}" y="${f1(y + 5)}" width="1.6" height="2.4" fill="${COL.trunk}"/></g>`;
  }
  if (rand() < 0.12) {
    const x = 16 + rand() * 68;
    const y = 18 + rand() * 66;
    out += `<g><ellipse cx="${f1(x)}" cy="${f1(y + 4)}" rx="5" ry="1.8" fill="rgba(0,0,0,.15)"/><path d="M${f1(x - 4.5)} ${f1(y + 3.5)}Q${f1(x)} ${f1(y - 7)} ${f1(x + 4.5)} ${f1(y + 3.5)}Z" fill="#e3c56b" stroke="#b8963d" stroke-width=".6"/><path d="M${f1(x - 2.5)} ${f1(y)}q2.5-2 5 0" stroke="#b8963d" stroke-width=".6" fill="none"/></g>`;
  }
  if (rand() < 0.06) {
    const x = 20 + rand() * 60;
    const y = 22 + rand() * 56;
    out += `<g stroke="#5a3e24" stroke-width=".6"><ellipse cx="${f1(x)}" cy="${f1(y + 8)}" rx="6" ry="2" fill="rgba(0,0,0,.18)" stroke="none"/><path d="M${f1(x - 3.5)} ${f1(y + 8)}L${f1(x - 2.2)} ${f1(y - 3)}H${f1(x + 2.2)}L${f1(x + 3.5)} ${f1(y + 8)}Z" fill="#f0e4c6"/><path d="M${f1(x - 2.8)} ${f1(y - 3)}L${f1(x)} ${f1(y - 6)}L${f1(x + 2.8)} ${f1(y - 3)}Z" fill="${COL.roofs[2]}"/><g transform="rotate(${Math.round(rand() * 90)} ${f1(x)} ${f1(y - 3.5)})"><path d="M${f1(x)} ${f1(y - 3.5)}v-8M${f1(x)} ${f1(y - 3.5)}v8M${f1(x)} ${f1(y - 3.5)}h-8M${f1(x)} ${f1(y - 3.5)}h8" stroke="#6b5030" stroke-width="1"/><path d="M${f1(x + 0.6)} ${f1(y - 11)}h2.2v6.5h-2.2zM${f1(x - 2.8)} ${f1(y - 2)}h2.2v6.5h-2.2z" fill="#f6efdd" stroke-width=".4"/></g></g>`;
  }
  if (rand() < 0.14) {
    const x = 10 + rand() * 60;
    const y = 15 + rand() * 70;
    out += `<g stroke="#8a6a45" stroke-width=".9" stroke-linecap="round"><path d="M${f1(x)} ${f1(y + 1.6)}h20M${f1(x)} ${f1(y + 3.4)}h20"/>${[0, 5, 10, 15, 20].map((d) => `<path d="M${f1(x + d)} ${f1(y)}v5"/>`).join('')}</g>`;
  }
  if (rand() < 0.3) {
    // A sheep or two.
    const n = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i++) {
      const x = 15 + rand() * 70;
      const y = 15 + rand() * 70;
      const flip = rand() < 0.5 ? -1 : 1;
      out += `<g transform="translate(${f1(x)} ${f1(y)}) scale(${flip} 1)"><ellipse cx="0" cy="2.6" rx="3.4" ry="1" fill="rgba(0,0,0,.15)"/><ellipse cx="0" cy="0" rx="3.2" ry="2.3" fill="#fbf8f0" stroke="#bdb6a6" stroke-width=".4"/><ellipse cx="3" cy="-.6" rx="1.3" ry="1.1" fill="#3b332b"/><path d="M-1.6 2v1.2M1.4 2v1.2" stroke="#3b332b" stroke-width=".6"/></g>`;
    }
  }
  return out;
}

/** A row of little houses filling a city part (clipped to it), plus a tower in big ones. */
function townHouses(rand: () => number, big: boolean) {
  let out = '';
  for (let y = 4; y < 100; y += 13) {
    for (let x = 3 + ((y / 13) % 2) * 6; x < 100; x += 14) {
      const jx = x + (rand() - 0.5) * 4;
      const jy = y + (rand() - 0.5) * 3;
      const w = 8 + rand() * 3;
      const roof = COL.roofs[Math.floor(rand() * COL.roofs.length)];
      const chimney = rand() < 0.5 ? `<rect x="${f1(jx + w * 0.7)}" y="${f1(jy - 0.6)}" width="1.4" height="2.6" fill="${COL.wall}"/>` : '';
      out += `<g>${chimney}<rect x="${f1(jx)}" y="${f1(jy + 3)}" width="${f1(w)}" height="6" fill="${COL.house}" stroke="${COL.wall}" stroke-width=".6"/><path d="M${f1(jx - 1)} ${f1(jy + 3.4)}L${f1(jx + w / 2)} ${f1(jy - 1.5)}L${f1(jx + w + 1)} ${f1(jy + 3.4)}Z" fill="${roof}" stroke="${COL.wall}" stroke-width=".6" stroke-linejoin="round"/><path d="M${f1(jx + w / 2)} ${f1(jy - 1.5)}L${f1(jx + w + 1)} ${f1(jy + 3.4)}H${f1(jx + w / 2)}Z" fill="rgba(0,0,0,.14)"/><rect x="${f1(jx + w / 2 - 0.9)}" y="${f1(jy + 5.6)}" width="1.8" height="3.4" fill="${COL.wall}"/><rect x="${f1(jx + 1.2)}" y="${f1(jy + 4.6)}" width="1.6" height="1.6" fill="#f6d983"/></g>`;
    }
  }
  if (big) {
    out += `<g stroke="${COL.wall}" stroke-width=".7"><rect x="45" y="38" width="10" height="20" fill="#e9dcbd"/><path d="M43.5 38.5L50 29L56.5 38.5Z" fill="${COL.roofs[0]}"/><rect x="48.6" y="44" width="2.8" height="4" fill="${COL.wall}"/></g>`;
  }
  return out;
}

function shield(x: number, y: number) {
  return `<g transform="translate(${f1(x)} ${f1(y)})"><path d="M-5 -6h10v6c0 4.2-5 7-5 7s-5-2.8-5-7z" fill="${COL.shield}" stroke="#e8c45a" stroke-width="1.3"/><path d="M-4.2 -1.2L4.2 -4.6V-2.6L-4.2 .8Z" fill="#fff" opacity=".85"/></g>`;
}

/** The chapel in the middle of a cloister tile: nave, bell tower, cross, and a vegetable garden. */
const CHAPEL = `<g stroke="${COL.wall}" stroke-width=".8" stroke-linejoin="round">
  <ellipse cx="50" cy="66" rx="20" ry="4" fill="rgba(0,0,0,.18)" stroke="none"/>
  <path d="M51 66Q49 74 50 82" stroke="#d9c79c" stroke-width="3.5" fill="none" stroke-linecap="round"/>
  <rect x="26" y="66" width="14" height="12" rx="1.5" fill="#7b5a36"/><path d="M28 69h10M28 72h10M28 75h10" stroke="#9ccf6b" stroke-width="1.3"/>
  <path d="M24.5 64.5h17v15h-17z" fill="none" stroke="#f3ead2" stroke-width=".9" stroke-dasharray="1.6 1.2"/>
  <circle cx="68" cy="70" r="1.2" fill="#f2a5b5" stroke="none"/><circle cx="71" cy="72" r="1.2" fill="#f6d55c" stroke="none"/><circle cx="66" cy="73" r="1.2" fill="#fff8e6" stroke="none"/>
  <rect x="40" y="48" width="22" height="18" fill="#f0e4c6"/><path d="M38 49L51 38L64 49Z" fill="${COL.roofs[0]}"/>
  <rect x="54" y="36" width="9" height="30" fill="#e9dcbd"/><path d="M52.5 36.5L58.5 26L64.5 36.5Z" fill="${COL.roofs[2]}"/>
  <path d="M58.5 26V20M56.4 22.2h4.2" stroke="${COL.wall}" stroke-width="1.1" fill="none"/>
  <circle cx="58.5" cy="42" r="2" fill="#fff8e6"/><path d="M48 66v-7a3 3 0 0 1 6 0v7" fill="${COL.wall}"/>
  <rect x="43" y="53" width="3" height="4" rx="1.5" fill="#7fb0d9"/></g>`;

/** A stone well where three or four roads meet. */
const WELL = `<g stroke="${COL.wall}" stroke-width=".8"><ellipse cx="50" cy="52.5" rx="8" ry="3" fill="rgba(0,0,0,.18)" stroke="none"/><rect x="43.5" y="46" width="13" height="7" rx="2" fill="#bfb6a3"/><ellipse cx="50" cy="46" rx="6.5" ry="2.4" fill="#3d6f9e"/><path d="M44 46V38M56 46V38" fill="none" stroke-width="1.2"/><path d="M42 39L50 33.5L58 39Z" fill="${COL.roofs[1]}" stroke-linejoin="round"/></g>`;

/** How many looks each tile kind has. */
export const VARIANTS = 3;
const cache = new Map<string, string>();

/**
 * The SVG for a tile kind (in look `variant`), unturned. Buildings that would look odd on their
 * side (the chapel, the well) are turned back by `r`, the turn the board will give the tile.
 */
export function tileSvg(id: string, variant = 0, r = 0): string {
  const k = KIND[id];
  const upright = k.cloister || k.roads.length > 2;
  const key = `${id}${variant}${upright ? r : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rand = rng(`${id}${variant}`);
  const level = (svg: string) => (upright && r ? `<g transform="rotate(${-r * 90} 50 50)">${svg}</g>` : svg);
  const roads = k.roads.map((r) => roadPath(r.edges, k));
  const roadLayer = (stroke: string, width: number, extra = '') =>
    `<g fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"${extra}>${roads.map((d) => `<path d="${d}"/>`).join('')}</g>`;
  const cities = k.cities
    .map((c, i) => {
      const shape = cityShape(c.edges);
      const clip = `lc-${key}-${i}`;
      const big = c.edges.length >= 3;
      return `<clipPath id="${clip}"><path d="${shape.fill}"${turn(shape.deg)}/></clipPath>
      <path d="${shape.fill}" fill="${COL.city}"${turn(shape.deg)}/>
      <g clip-path="url(#${clip})">
        <g fill="${COL.cobble}" opacity=".6">${Array.from({ length: 30 }, () => `<rect x="${f1(rand() * 100)}" y="${f1(rand() * 100)}" width="3" height="2" rx=".8"/>`).join('')}</g>
        ${townHouses(rand, big)}
      </g>
      ${
        shape.walls.length
          ? `<g${turn(shape.deg)}><g fill="none">${shape.walls
              .map(
                (w) =>
                  `<path d="${curveD(w)}" stroke="${COL.wall}" stroke-width="6.5" stroke-linecap="round"/><path d="${curveD(w)}" stroke="#b9a57c" stroke-width="4.2"/><path d="${curveD(w)}" stroke="${COL.wallTop}" stroke-width="4.2" stroke-dasharray="2.4 2.2"/>`,
              )
              .join('')}</g>${shape.walls
              .flatMap((w) => shape.towers.map((t) => onCurve(w, t)))
              .map(([x, y]) => `<g><circle cx="${f1(x)}" cy="${f1(y)}" r="4.6" fill="${COL.wallTop}" stroke="${COL.wall}" stroke-width="1"/><circle cx="${f1(x)}" cy="${f1(y)}" r="3" fill="${COL.roofs[2]}" stroke="${COL.wall}" stroke-width=".5"/><circle cx="${f1(x - 0.9)}" cy="${f1(y - 0.9)}" r=".9" fill="rgba(255,255,255,.4)"/><path d="M${f1(x)} ${f1(y)}V${f1(y - 7)}" stroke="${COL.wall}" stroke-width=".6"/><path d="M${f1(x)} ${f1(y - 7)}l4 1.2l-4 1.4z" fill="${COL.shield}"/></g>`)
              .join('')}</g>`
          : ''
      }`;
    })
    .join('');
  // A road running into a city on this tile goes through a gatehouse.
  const gates =
    k.cities.length && !k.cloister && k.roads.length === 1
      ? k.roads
          .filter((r) => r.edges.length === 1)
          .map((r) => `<g transform="rotate(${(r.edges[0] - 2) * 90} 50 50)"><rect x="43.5" y="69" width="13" height="8" rx="1" fill="${COL.wallTop}" stroke="${COL.wall}" stroke-width="1"/><path d="M46.5 77v-4a3.5 3.5 0 0 1 7 0v4z" fill="#4a3a26"/><path d="M43.5 69v-2h2v2M48 69v-2h2v2M52.5 69v-2h2v2" fill="${COL.wallTop}" stroke="${COL.wall}" stroke-width=".7"/></g>`)
          .join('')
      : '';
  const pebbles = k.roads
    .flatMap((r) => roadPoints(r.edges, k, 9))
    .map(([x, y]) => `<circle cx="${f1(x + (rand() - 0.5) * 7)}" cy="${f1(y + (rand() - 0.5) * 7)}" r="${f1(0.5 + rand() * 0.5)}" fill="#bba98a"/>`)
    .join('');
  const shields = k.cities
    .filter((c) => c.shield)
    .map((c) => {
      const [x, y] = anchor('city', c.edges);
      return shield(x + 10, y + 8);
    })
    .join('');
  const svg = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <rect width="100" height="100" fill="${COL.field}"/>
  <circle cx="${f1(20 + rand() * 60)}" cy="${f1(20 + rand() * 60)}" r="38" fill="${COL.fieldLight}" opacity=".45"/>
  ${countryside(rand)}
  ${riverLayer(k, rand)}
  ${roads.length ? `${roadLayer('rgba(70,110,40,.3)', 19)}${roadLayer(COL.roadEdge, 15)}${roadLayer(COL.road, 11)}${roadLayer(COL.rut, 1.1, ' stroke-dasharray="2.4 3"')}${pebbles}` : ''}
  ${bridges(k)}
  ${k.roads.length > 2 ? level(WELL) : ''}
  ${cities}
  ${gates}
  ${shields}
  ${
    k.cloister
      ? k.rivers
        ? // Stays on its bank as the tile turns; only the building is turned back upright.
          `<g transform="translate(${chapelAt(k)[0]} ${chapelAt(k)[1]}) rotate(${-r * 90}) scale(.62) translate(-50 -50)">${CHAPEL}</g>`
        : level(CHAPEL)
      : ''
  }
  <radialGradient id="lv"><stop offset=".62" stop-color="#2a1d0e" stop-opacity="0"/><stop offset="1" stop-color="#2a1d0e" stop-opacity=".2"/></radialGradient>
  <rect width="100" height="100" fill="url(#lv)"/>
  <rect x=".6" y=".6" width="98.8" height="98.8" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1.2"/>
  <rect width="100" height="100" fill="none" stroke="rgba(0,0,0,.22)" stroke-width=".8"/>
</svg>`;
  cache.set(key, svg);
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

/** A follower: a little pawn; farmers lie down in their field. */
export function followerSvg(p: number, part: Part): string {
  const c = PLAYER_COLOURS[p];
  return `<svg viewBox="0 0 20 24" aria-hidden="true"${part === 'field' ? ' style="rotate:90deg"' : ''}><path d="M10 1.5a4.2 4.2 0 0 1 2.6 7.5l3.6 2.3c1.6 1 2.3 3 1.6 4.8L16 22.5H4l-1.8-6.4c-.7-1.8 0-3.8 1.6-4.8L7.4 9A4.2 4.2 0 0 1 10 1.5z" fill="${c}" stroke="#2b2117" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
}
