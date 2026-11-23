/**
 * Landscaper's tiles: the classic 72-tile tile-laying set (24 kinds), described by what each
 * edge holds and which parts of the tile join up.
 *
 * Edges are 0 N, 1 E, 2 S, 3 W. Fields meet at "halves": each edge has two, numbered clockwise
 * around the tile, so edge e has halves 2e and 2e + 1 (N: 0 west, 1 east; E: 2 north, 3 south;
 * S: 4 east, 5 west; W: 6 south, 7 north). A road edge splits its field into those two halves.
 */

/** A river edge meets only a river edge; like a road, it splits the field on that edge in two. */
export type Edge = 'city' | 'road' | 'field' | 'river';

export interface TileKind {
  id: string;
  count: number;
  edges: [Edge, Edge, Edge, Edge];
  /** Separate city parts on the tile, by the edges each reaches; shields add to the score. */
  cities: { edges: number[]; shield?: boolean; cathedral?: boolean }[];
  /** Road segments by the edges they reach (one edge: it ends on this tile); an inn doubles a finished road. */
  roads: { edges: number[]; inn?: boolean }[];
  /** Field areas by their halves, and which of this tile's cities each one borders. */
  fields: { halves: number[]; cities: number[] }[];
  cloister?: boolean;
  /** River parts by the edges they reach (one edge: the spring or the lake). Not scored. */
  rivers?: { edges: number[] }[];
}

const C = 'city' as const;
const R = 'road' as const;
const F = 'field' as const;
const W = 'river' as const;

export const KINDS: TileKind[] = [
  { id: 'A', count: 2, edges: [F, F, R, F], cloister: true, cities: [], roads: [{ edges: [2] }], fields: [{ halves: [0, 1, 2, 3, 4, 5, 6, 7], cities: [] }] },
  { id: 'B', count: 4, edges: [F, F, F, F], cloister: true, cities: [], roads: [], fields: [{ halves: [0, 1, 2, 3, 4, 5, 6, 7], cities: [] }] },
  { id: 'C', count: 1, edges: [C, C, C, C], cities: [{ edges: [0, 1, 2, 3], shield: true }], roads: [], fields: [] },
  {
    id: 'D',
    count: 4,
    edges: [C, R, F, R],
    cities: [{ edges: [0] }],
    roads: [{ edges: [1, 3] }],
    fields: [
      { halves: [2, 7], cities: [0] },
      { halves: [3, 4, 5, 6], cities: [] },
    ],
  },
  { id: 'E', count: 5, edges: [C, F, F, F], cities: [{ edges: [0] }], roads: [], fields: [{ halves: [2, 3, 4, 5, 6, 7], cities: [0] }] },
  {
    id: 'F',
    count: 2,
    edges: [F, C, F, C],
    cities: [{ edges: [1, 3], shield: true }],
    roads: [],
    fields: [
      { halves: [0, 1], cities: [0] },
      { halves: [4, 5], cities: [0] },
    ],
  },
  {
    id: 'G',
    count: 1,
    edges: [F, C, F, C],
    cities: [{ edges: [1, 3] }],
    roads: [],
    fields: [
      { halves: [0, 1], cities: [0] },
      { halves: [4, 5], cities: [0] },
    ],
  },
  { id: 'H', count: 3, edges: [F, C, F, C], cities: [{ edges: [1] }, { edges: [3] }], roads: [], fields: [{ halves: [0, 1, 4, 5], cities: [0, 1] }] },
  { id: 'I', count: 2, edges: [C, C, F, F], cities: [{ edges: [0] }, { edges: [1] }], roads: [], fields: [{ halves: [4, 5, 6, 7], cities: [0, 1] }] },
  {
    id: 'J',
    count: 3,
    edges: [C, R, R, F],
    cities: [{ edges: [0] }],
    roads: [{ edges: [1, 2] }],
    fields: [
      { halves: [3, 4], cities: [] },
      { halves: [2, 5, 6, 7], cities: [0] },
    ],
  },
  {
    id: 'K',
    count: 3,
    edges: [C, F, R, R],
    cities: [{ edges: [0] }],
    roads: [{ edges: [2, 3] }],
    fields: [
      { halves: [5, 6], cities: [] },
      { halves: [2, 3, 4, 7], cities: [0] },
    ],
  },
  {
    id: 'L',
    count: 3,
    edges: [C, R, R, R],
    cities: [{ edges: [0] }],
    roads: [{ edges: [1] }, { edges: [2] }, { edges: [3] }],
    fields: [
      { halves: [2, 7], cities: [0] },
      { halves: [3, 4], cities: [] },
      { halves: [5, 6], cities: [] },
    ],
  },
  { id: 'M', count: 2, edges: [C, F, F, C], cities: [{ edges: [0, 3], shield: true }], roads: [], fields: [{ halves: [2, 3, 4, 5], cities: [0] }] },
  { id: 'N', count: 3, edges: [C, F, F, C], cities: [{ edges: [0, 3] }], roads: [], fields: [{ halves: [2, 3, 4, 5], cities: [0] }] },
  {
    id: 'O',
    count: 2,
    edges: [C, R, R, C],
    cities: [{ edges: [0, 3], shield: true }],
    roads: [{ edges: [1, 2] }],
    fields: [
      { halves: [3, 4], cities: [] },
      { halves: [2, 5], cities: [0] },
    ],
  },
  {
    id: 'P',
    count: 3,
    edges: [C, R, R, C],
    cities: [{ edges: [0, 3] }],
    roads: [{ edges: [1, 2] }],
    fields: [
      { halves: [3, 4], cities: [] },
      { halves: [2, 5], cities: [0] },
    ],
  },
  { id: 'Q', count: 1, edges: [C, C, F, C], cities: [{ edges: [0, 1, 3], shield: true }], roads: [], fields: [{ halves: [4, 5], cities: [0] }] },
  { id: 'R', count: 3, edges: [C, C, F, C], cities: [{ edges: [0, 1, 3] }], roads: [], fields: [{ halves: [4, 5], cities: [0] }] },
  {
    id: 'S',
    count: 2,
    edges: [C, C, R, C],
    cities: [{ edges: [0, 1, 3], shield: true }],
    roads: [{ edges: [2] }],
    fields: [
      { halves: [4], cities: [0] },
      { halves: [5], cities: [0] },
    ],
  },
  {
    id: 'T',
    count: 1,
    edges: [C, C, R, C],
    cities: [{ edges: [0, 1, 3] }],
    roads: [{ edges: [2] }],
    fields: [
      { halves: [4], cities: [0] },
      { halves: [5], cities: [0] },
    ],
  },
  {
    id: 'U',
    count: 8,
    edges: [R, F, R, F],
    cities: [],
    roads: [{ edges: [0, 2] }],
    fields: [
      { halves: [1, 2, 3, 4], cities: [] },
      { halves: [5, 6, 7, 0], cities: [] },
    ],
  },
  {
    id: 'V',
    count: 9,
    edges: [F, F, R, R],
    cities: [],
    roads: [{ edges: [2, 3] }],
    fields: [
      { halves: [5, 6], cities: [] },
      { halves: [0, 1, 2, 3, 4, 7], cities: [] },
    ],
  },
  {
    id: 'W',
    count: 4,
    edges: [F, R, R, R],
    cities: [],
    roads: [{ edges: [1] }, { edges: [2] }, { edges: [3] }],
    fields: [
      { halves: [0, 1, 2, 7], cities: [] },
      { halves: [3, 4], cities: [] },
      { halves: [5, 6], cities: [] },
    ],
  },
  {
    id: 'X',
    count: 1,
    edges: [R, R, R, R],
    cities: [],
    roads: [{ edges: [0] }, { edges: [1] }, { edges: [2] }, { edges: [3] }],
    fields: [
      { halves: [1, 2], cities: [] },
      { halves: [3, 4], cities: [] },
      { halves: [5, 6], cities: [] },
      { halves: [7, 0], cities: [] },
    ],
  },
];

/**
 * The river expansion: thirteen tiles (the classic twelve plus an extra bend) laid first, from
 * the spring to the lake, before the rest.
 * Ids start with 'r'.
 */
export const RIVER_KINDS: TileKind[] = [
  { id: 'rS', count: 1, edges: [F, F, W, F], cities: [], roads: [], rivers: [{ edges: [2] }], fields: [{ halves: [0, 1, 2, 3, 4, 5, 6, 7], cities: [] }] },
  { id: 'rL', count: 1, edges: [W, F, F, F], cities: [], roads: [], rivers: [{ edges: [0] }], fields: [{ halves: [0, 1, 2, 3, 4, 5, 6, 7], cities: [] }] },
  {
    id: 'rI',
    count: 2,
    edges: [W, F, W, F],
    cities: [],
    roads: [],
    rivers: [{ edges: [0, 2] }],
    fields: [
      { halves: [1, 2, 3, 4], cities: [] },
      { halves: [5, 6, 7, 0], cities: [] },
    ],
  },
  {
    id: 'rC',
    count: 3,
    edges: [W, W, F, F],
    cities: [],
    roads: [],
    rivers: [{ edges: [0, 1] }],
    fields: [
      { halves: [1, 2], cities: [] },
      { halves: [3, 4, 5, 6, 7, 0], cities: [] },
    ],
  },
  {
    id: 'rB',
    count: 1,
    edges: [W, R, W, R],
    cities: [],
    roads: [{ edges: [1, 3] }],
    rivers: [{ edges: [0, 2] }],
    fields: [
      { halves: [1, 2], cities: [] },
      { halves: [3, 4], cities: [] },
      { halves: [5, 6], cities: [] },
      { halves: [7, 0], cities: [] },
    ],
  },
  {
    id: 'rE',
    count: 1,
    edges: [W, C, W, F],
    cities: [{ edges: [1] }],
    roads: [],
    rivers: [{ edges: [0, 2] }],
    fields: [
      { halves: [1, 4], cities: [0] },
      { halves: [5, 6, 7, 0], cities: [] },
    ],
  },
  {
    id: 'rT',
    count: 1,
    edges: [W, C, W, C],
    cities: [{ edges: [1] }, { edges: [3] }],
    roads: [],
    rivers: [{ edges: [0, 2] }],
    fields: [
      { halves: [1, 4], cities: [0] },
      { halves: [5, 0], cities: [1] },
    ],
  },
  {
    id: 'rR',
    count: 1,
    edges: [W, W, R, R],
    cities: [],
    roads: [{ edges: [2, 3] }],
    rivers: [{ edges: [0, 1] }],
    fields: [
      { halves: [1, 2], cities: [] },
      { halves: [3, 4, 7, 0], cities: [] },
      { halves: [5, 6], cities: [] },
    ],
  },
  {
    id: 'rM',
    count: 1,
    edges: [W, F, W, R],
    cloister: true,
    cities: [],
    roads: [{ edges: [3] }],
    rivers: [{ edges: [0, 2] }],
    fields: [
      { halves: [1, 2, 3, 4], cities: [] },
      { halves: [5, 6, 7, 0], cities: [] },
    ],
  },
  {
    id: 'rK',
    count: 1,
    edges: [C, F, W, W],
    cities: [{ edges: [0] }],
    roads: [],
    rivers: [{ edges: [2, 3] }],
    fields: [
      { halves: [5, 6], cities: [] },
      { halves: [2, 3, 4, 7], cities: [0] },
    ],
  },
];
/**
 * Inns & Cathedrals: fourteen tiles in the spirit of the classic expansion. An inn by a road makes
 * it worth 2 a tile when finished but nothing if it isn't by the end; a cathedral does the same
 * for a city, at 3 a tile. Ids start with 'i'.
 */
const base = (id: string) => KINDS.find((k) => k.id === id)!;
const withInn = (id: string, from: string, count = 1, road = 0): TileKind => ({
  ...structuredClone(base(from)),
  id,
  count,
  roads: base(from).roads.map((r, i) => (i === road ? { ...r, inn: true } : { ...r })),
});
export const INN_KINDS: TileKind[] = [
  { ...structuredClone(base('C')), id: 'iC', count: 2, cities: [{ edges: [0, 1, 2, 3], cathedral: true }] },
  withInn('iD', 'D', 2),
  withInn('iU', 'U', 2),
  withInn('iV', 'V', 2),
  withInn('iW', 'W'),
  withInn('iJ', 'J'),
  withInn('iK', 'K'),
  withInn('iO', 'O'),
  withInn('iP', 'P'),
  {
    // Two cities, one each side of a road through the middle.
    id: 'iH',
    count: 1,
    edges: [C, R, C, R],
    cities: [{ edges: [0] }, { edges: [2] }],
    roads: [{ edges: [1, 3], inn: true }],
    fields: [
      { halves: [2, 7], cities: [0] },
      { halves: [3, 6], cities: [1] },
    ],
  },
];

/** The river's first tile, which starts the map when the river is in play. */
export const SPRING = 'rS';
export const LAKE = 'rL';

export const KIND = Object.fromEntries([...KINDS, ...RIVER_KINDS, ...INN_KINDS].map((k) => [k.id, k])) as Record<string, TileKind>;
/** The starting tile: a city on one side and a road across. */
export const START = 'D';

/** Where something on the tile ends up once the tile is turned `r` quarter turns clockwise. */
export const turnEdge = (e: number, r: number) => (e + r) % 4;
export const turnHalf = (h: number, r: number) => (h + 2 * r) % 8;

/** The edge type showing on side `side` of a tile of `kind` turned `r` times. */
export const edgeAt = (kind: TileKind, r: number, side: number) => kind.edges[(side - r + 4) % 4];

/** Step to the neighbour across each edge. */
export const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/** The half on the neighbouring tile that touches half `h` across its edge. */
export const facingHalf = (h: number) => {
  const e = h >> 1;
  const k = h & 1;
  return ((e + 2) % 4) * 2 + (1 - k);
};
