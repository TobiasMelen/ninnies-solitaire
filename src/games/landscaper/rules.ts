import { mulberry32, shuffle } from '../../core/cards';
import { DIRS, INN_KINDS, KIND, KINDS, LAKE, RIVER_KINDS, SPRING, START, type TileKind, edgeAt, facingHalf } from './tiles';

/**
 * Landscaper rules: lay tiles so edges match, put a follower on a road, city, cloister or field
 * of the tile you laid, and score features as they're finished (and the rest at the end).
 */

export type Part = 'city' | 'road' | 'field' | 'cloister';

/** A follower on part `i` (index into the tile kind's list of that part) of a tile. */
export interface Follower {
  p: number;
  part: Part;
  i: number;
  /** The big boy: counts as two when it comes to who holds a feature. */
  big?: boolean;
}

export interface Placed {
  k: string;
  r: number;
  x: number;
  y: number;
  f?: Follower;
}

export interface Move {
  x: number;
  y: number;
  r: number;
  f?: { part: Part; i: number; big?: boolean };
}

/** Points scored for a feature, for the UI to show. */
export interface Scored {
  part: Part;
  players: number[];
  points: number;
  /** Tile indexes the feature covers. */
  tiles: number[];
  final?: boolean;
}

export interface LandscaperOptions {
  players: number;
  farmers: boolean;
  /** Start with the river expansion. */
  river?: boolean;
  /** The Inns & Cathedrals expansion: its tiles in the pile. */
  inns?: boolean;
  /** The big boy: one big follower each, counting as two (enough to take over a city). */
  bigBoy?: boolean;
  /** Each opponent's playstyle and level (0 easy, 1 medium, 2 hard), in seat order. */
  lineup?: { style: string; level: number }[];
}

export interface LandscaperState {
  seed: number;
  options: LandscaperOptions;
  /** Tiles still to draw (last is next). */
  pile: string[];
  tiles: Placed[];
  scores: number[];
  /** Followers each player still has to place. */
  followers: number[];
  /** Whether each player has their big boy in hand. */
  big?: boolean[];
  turn: number;
  /** The tile the current player has to lay; null once the pile is used up. */
  current: string | null;
  /** What the last move (or the end of the game) scored. */
  scored: Scored[];
  over: boolean;
  /** Which way the last river tile bent (0 straight on, 1 right, 3 left), so it never doubles back on itself. */
  riverBend?: number;
}

export const FOLLOWERS = 7;

export function newGame(seed: number, options: LandscaperOptions): LandscaperState {
  const rand = mulberry32(seed);
  const pile: string[] = [];
  // With the river, the spring starts the map and the usual start tile goes in the pile.
  for (const k of KINDS) for (let n = 0; n < k.count - (k.id === START && !options.river ? 1 : 0); n++) pile.push(k.id);
  if (options.inns) for (const k of INN_KINDS) for (let n = 0; n < k.count; n++) pile.push(k.id);
  shuffle(pile, rand);
  if (options.river) {
    // The pile is drawn from the end: river tiles first, the lake last of them.
    const river: string[] = [];
    for (const k of RIVER_KINDS) if (k.id !== SPRING && k.id !== LAKE) for (let n = 0; n < k.count; n++) river.push(k.id);
    pile.push(LAKE, ...shuffle(river, rand));
  }
  const s: LandscaperState = {
    seed,
    options,
    pile,
    tiles: [{ k: options.river ? SPRING : START, r: 0, x: 0, y: 0 }],
    scores: Array(options.players).fill(0),
    followers: Array(options.players).fill(FOLLOWERS),
    big: Array(options.players).fill(!!options.bigBoy),
    turn: 0,
    current: null,
    scored: [],
    over: false,
  };
  draw(s);
  return s;
}

const cell = (x: number, y: number) => `${x},${y}`;

export function tileMap(s: LandscaperState) {
  return new Map(s.tiles.map((t, i) => [cell(t.x, t.y), i]));
}

// ───────────────────────── placing tiles ─────────────────────────

/** Whether `k` turned `r` times fits at (x, y): next to the map, and every edge matches. */
export function fits(s: LandscaperState, at: Map<string, number>, k: TileKind, x: number, y: number, r: number) {
  if (at.has(cell(x, y))) return false;
  let touches = false;
  for (let d = 0; d < 4; d++) {
    const n = at.get(cell(x + DIRS[d][0], y + DIRS[d][1]));
    if (n === undefined) continue;
    touches = true;
    const o = s.tiles[n];
    if (edgeAt(k, r, d) !== edgeAt(KIND[o.k], o.r, (d + 2) % 4)) return false;
  }
  return touches;
}

/** The river's open end: the tile it leaves, the side it leaves by, and the empty square beyond. */
export function riverEnd(s: LandscaperState, at = tileMap(s)) {
  for (let i = s.tiles.length - 1; i >= 0; i--) {
    const t = s.tiles[i];
    const k = KIND[t.k];
    if (!k.rivers) continue;
    for (let d = 0; d < 4; d++) {
      if (edgeAt(k, t.r, d) !== 'river') continue;
      const x = t.x + DIRS[d][0];
      const y = t.y + DIRS[d][1];
      if (!at.has(cell(x, y))) return { x, y, side: (d + 2) % 4 };
    }
  }
  return null;
}

/** Which way a river tile laid this way bends: 0 straight on, 1 right, 3 left. */
function bendOf(k: TileKind, r: number, inSide: number) {
  const sides = [0, 1, 2, 3].filter((d) => edgeAt(k, r, d) === 'river');
  const out = sides.find((d) => d !== inSide);
  return out === undefined ? 0 : (out - ((inSide + 2) % 4) + 4) % 4;
}

/**
 * Where a river tile can go: on the river's open end, either way round that fits. Only two bends
 * the same way straight after each other (a U-turn), or flowing into a square that's already
 * taken, are ruled out, and only when there's another way.
 */
function riverPlacements(s: LandscaperState, at: Map<string, number>, k: TileKind) {
  const end = riverEnd(s, at);
  if (!end) return [];
  const fitting = [0, 1, 2, 3].filter((r) => edgeAt(k, r, end.side) === 'river' && fits(s, at, k, end.x, end.y, r));
  const flowsOn = (r: number) => [0, 1, 2, 3].every((d) => d === end.side || edgeAt(k, r, d) !== 'river' || !at.has(cell(end.x + DIRS[d][0], end.y + DIRS[d][1])));
  const ok = fitting.filter((r) => flowsOn(r) && (!s.riverBend || bendOf(k, r, end.side) !== s.riverBend));
  return (ok.length ? ok : fitting).map((r) => ({ x: end.x, y: end.y, r }));
}

/** Every spot and turn where tile `kind` can be laid. */
export function placements(s: LandscaperState, kind: string): { x: number; y: number; r: number }[] {
  const at = tileMap(s);
  const k = KIND[kind];
  if (k.rivers) return riverPlacements(s, at, k);
  const out: { x: number; y: number; r: number }[] = [];
  const seen = new Set<string>();
  for (const t of s.tiles) {
    for (const [dx, dy] of DIRS) {
      const x = t.x + dx;
      const y = t.y + dy;
      const key = cell(x, y);
      if (at.has(key) || seen.has(key)) continue;
      seen.add(key);
      // A tile that looks the same turned (like the straight road) only needs its distinct turns:
      // in this set, the same edges all round means the same tile.
      const shapes = new Set<string>();
      for (let r = 0; r < 4; r++) {
        const shape = [0, 1, 2, 3].map((d) => edgeAt(k, r, d)).join();
        if (shapes.has(shape)) continue;
        shapes.add(shape);
        if (fits(s, at, k, x, y, r)) out.push({ x, y, r });
      }
    }
  }
  return out;
}

/** Turn to the next tile anyone can lay; tiles that fit nowhere are set aside. */
function draw(s: LandscaperState) {
  s.current = null;
  while (s.pile.length) {
    const k = s.pile.pop()!;
    if (placements(s, k).length) {
      s.current = k;
      return;
    }
  }
}

// ───────────────────────── features ─────────────────────────

export interface Feature {
  part: Part;
  /** Tile indexes it covers (for a cloister: itself and its neighbours). */
  tiles: Set<number>;
  /** Edges still leading off the map (roads and cities); neighbours missing (cloisters). */
  open: number;
  shields: number;
  followers: { p: number; tile: number; big?: boolean }[];
  /** A road with an inn, or a city with a cathedral: double or nothing. */
  inn: boolean;
  cathedral: boolean;
  /** For fields: the cities they border (feature ids). */
  borders: Set<number>;
  complete: boolean;
}

export interface Analysis {
  features: Feature[];
  /** Feature id for part `i` of kind `part` on tile `t`: key `${t}:${part}:${i}`. */
  of: Map<string, number>;
}

/** Joins every road, city and field across tile edges and works out each one's state. */
export function analyse(s: LandscaperState): Analysis {
  const at = tileMap(s);
  const nodes: { t: number; part: Part; i: number }[] = [];
  const nodeOf = new Map<string, number>();
  const add = (t: number, part: Part, i: number) => {
    nodeOf.set(`${t}:${part}:${i}`, nodes.length);
    nodes.push({ t, part, i });
  };
  s.tiles.forEach((tile, t) => {
    const k = KIND[tile.k];
    k.cities.forEach((_, i) => add(t, 'city', i));
    k.roads.forEach((_, i) => add(t, 'road', i));
    k.fields.forEach((_, i) => add(t, 'field', i));
    if (k.cloister) add(t, 'cloister', 0);
  });
  const parent = nodes.map((_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const union = (a: number, b: number) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };
  const partWith = (t: number, part: 'city' | 'road', edge: number) => {
    const list = KIND[s.tiles[t].k][part === 'city' ? 'cities' : 'roads'];
    const i = list.findIndex((p) => p.edges.includes(edge));
    return nodeOf.get(`${t}:${part}:${i}`)!;
  };
  const fieldWith = (t: number, half: number) => {
    const i = KIND[s.tiles[t].k].fields.findIndex((f) => f.halves.includes(half));
    return i < 0 ? undefined : nodeOf.get(`${t}:field:${i}`);
  };

  const open = new Map<number, number>();
  s.tiles.forEach((tile, t) => {
    const k = KIND[tile.k];
    for (let d = 0; d < 4; d++) {
      const local = (d - tile.r + 4) % 4;
      const type = k.edges[local];
      const n = at.get(cell(tile.x + DIRS[d][0], tile.y + DIRS[d][1]));
      if (n === undefined) {
        if (type === 'city' || type === 'road') {
          const node = partWith(t, type, local);
          open.set(node, (open.get(node) ?? 0) + 1);
        }
        continue;
      }
      if (n < t) continue; // each shared edge once
      const o = s.tiles[n];
      const oLocal = ((d + 2) % 4 - o.r + 4) % 4;
      if (type === 'city' || type === 'road') union(partWith(t, type, local), partWith(n, type, oLocal));
      for (let k2 = 0; k2 < 2; k2++) {
        const world = 2 * d + k2;
        const a = fieldWith(t, (world - 2 * tile.r + 8) % 8);
        const b = fieldWith(n, (facingHalf(world) - 2 * o.r + 8) % 8);
        if (a !== undefined && b !== undefined) union(a, b);
      }
    }
  });

  const features: Feature[] = [];
  const idOfRoot = new Map<number, number>();
  const of = new Map<string, number>();
  nodes.forEach((node, n) => {
    if (node.part === 'cloister') {
      const tile = s.tiles[node.t];
      const tiles = new Set([node.t]);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const m = at.get(cell(tile.x + dx, tile.y + dy));
          if (m !== undefined) tiles.add(m);
        }
      of.set(`${node.t}:cloister:0`, features.length);
      features.push({ part: 'cloister', tiles, open: 9 - tiles.size, shields: 0, followers: [], inn: false, cathedral: false, borders: new Set(), complete: tiles.size === 9 });
      return;
    }
    const root = find(n);
    let id = idOfRoot.get(root);
    if (id === undefined) {
      id = features.length;
      idOfRoot.set(root, id);
      features.push({ part: node.part, tiles: new Set(), open: 0, shields: 0, followers: [], inn: false, cathedral: false, borders: new Set(), complete: false });
    }
    of.set(`${node.t}:${node.part}:${node.i}`, id);
    const f = features[id];
    f.tiles.add(node.t);
    f.open += open.get(n) ?? 0;
    const kind = KIND[s.tiles[node.t].k];
    if (node.part === 'city' && kind.cities[node.i].shield) f.shields++;
    if (node.part === 'city' && kind.cities[node.i].cathedral) f.cathedral = true;
    if (node.part === 'road' && kind.roads[node.i].inn) f.inn = true;
  });
  // Followers, and which cities each field borders (once every city has its id).
  s.tiles.forEach((tile, t) => {
    if (tile.f) features[of.get(`${t}:${tile.f.part}:${tile.f.i}`)!].followers.push({ p: tile.f.p, tile: t, big: tile.f.big });
    KIND[tile.k].fields.forEach((field, i) => {
      const id = of.get(`${t}:field:${i}`)!;
      for (const c of field.cities) features[id].borders.add(of.get(`${t}:city:${c}`)!);
    });
  });
  for (const f of features) if (f.part === 'city' || f.part === 'road') f.complete = f.open === 0;
  return { features, of };
}

/** What a feature is worth, finished or (at the end of the game) not. */
export function worth(f: Feature, a: Analysis, atEnd: boolean): number {
  // An inn or a cathedral: more for finishing it, nothing for leaving it unfinished.
  if (f.part === 'road') return f.inn ? (f.complete ? 2 * f.tiles.size : 0) : f.tiles.size;
  if (f.part === 'city' && f.cathedral) return f.complete ? 3 * (f.tiles.size + f.shields) : 0;
  if (f.part === 'city') return f.complete ? 2 * (f.tiles.size + f.shields) : atEnd ? f.tiles.size + f.shields : 0;
  if (f.part === 'cloister') return f.complete ? 9 : atEnd ? f.tiles.size : 0;
  // Fields: 3 for every finished city they border.
  return 3 * [...f.borders].filter((c) => a.features[c].complete).length;
}

/** The players with the most followers on a feature (all of them, when tied). */
export function owners(f: Feature, players: number): number[] {
  const count = Array(players).fill(0);
  for (const x of f.followers) count[x.p] += x.big ? 2 : 1;
  const most = Math.max(...count);
  return most ? count.flatMap((n, p) => (n === most ? [p] : [])) : [];
}

// ───────────────────────── followers ─────────────────────────

/** The parts of the just-laid tile (the last one) a follower may go on. */
export function followerSpots(s: LandscaperState, a = analyse(s)): { part: Part; i: number }[] {
  const t = s.tiles.length - 1;
  const tile = s.tiles[t];
  if (s.followers[s.turn] <= 0 && !s.big?.[s.turn]) return [];
  const k = KIND[tile.k];
  const spots: { part: Part; i: number }[] = [];
  const free = (part: Part, i: number) => !a.features[a.of.get(`${t}:${part}:${i}`)!].followers.length;
  k.cities.forEach((_, i) => free('city', i) && spots.push({ part: 'city', i }));
  k.roads.forEach((_, i) => free('road', i) && spots.push({ part: 'road', i }));
  if (k.cloister) spots.push({ part: 'cloister', i: 0 });
  if (s.options.farmers) k.fields.forEach((_, i) => free('field', i) && spots.push({ part: 'field', i }));
  return spots;
}

// ───────────────────────── a turn ─────────────────────────

/** Lays the current tile (with a follower, if given), scores what it finishes and passes the turn. */
export function play(s: LandscaperState, m: Move) {
  if (!s.current || s.over) throw new Error('No tile to lay');
  const k = KIND[s.current];
  if (!fits(s, tileMap(s), k, m.x, m.y, m.r)) throw new Error('Tile does not fit there');
  if (k.rivers) {
    const end = riverEnd(s);
    const bend = end ? bendOf(k, m.r, end.side) : 0;
    s.riverBend = bend;
  }
  s.tiles.push({ k: s.current, r: m.r, x: m.x, y: m.y });
  const t = s.tiles.length - 1;
  if (m.f) {
    if (!followerSpots(s).some((sp) => sp.part === m.f!.part && sp.i === m.f!.i)) throw new Error('No follower there');
    if (m.f.big ? !s.big?.[s.turn] : s.followers[s.turn] <= 0) throw new Error('No follower of that kind to place');
    s.tiles[t].f = { p: s.turn, part: m.f.part, i: m.f.i, ...(m.f.big ? { big: true } : {}) };
    if (m.f.big) s.big![s.turn] = false;
    else s.followers[s.turn]--;
  }
  s.scored = scoreFinished(s, t);
  s.turn = (s.turn + 1) % s.options.players;
  draw(s);
  if (!s.current) finish(s);
}

/** Scores roads, cities and cloisters the new tile finished, and returns their followers. */
function scoreFinished(s: LandscaperState, t: number): Scored[] {
  const a = analyse(s);
  const out: Scored[] = [];
  a.features.forEach((f) => {
    // Roads and cities through the new tile, and cloisters it's on or next to.
    if (!f.complete || f.part === 'field' || !f.followers.length || !f.tiles.has(t)) return;
    const points = worth(f, a, false);
    const who = owners(f, s.options.players);
    for (const p of who) s.scores[p] += points;
    out.push({ part: f.part, players: who, points, tiles: [...f.tiles] });
    for (const x of f.followers) {
      if (x.big) s.big![x.p] = true;
      else s.followers[x.p]++;
      delete s.tiles[x.tile].f;
    }
  });
  return out;
}

/** The end: unfinished roads, cities and cloisters score what they have; farmers score fields. */
function finish(s: LandscaperState) {
  const a = analyse(s);
  const out: Scored[] = [];
  a.features.forEach((f) => {
    if (!f.followers.length || (f.part === 'field' && !s.options.farmers)) return;
    const points = worth(f, a, true);
    if (!points) return;
    const who = owners(f, s.options.players);
    for (const p of who) s.scores[p] += points;
    out.push({ part: f.part, players: who, points, tiles: [...f.tiles], final: true });
  });
  s.scored = [...s.scored, ...out];
  s.over = true;
}

/** Players with the highest score (ties share the win). */
export const leaders = (s: LandscaperState) => {
  const best = Math.max(...s.scores);
  return s.scores.flatMap((n, p) => (n === best ? [p] : []));
};

