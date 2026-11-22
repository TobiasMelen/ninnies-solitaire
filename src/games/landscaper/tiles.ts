/**
 * Landscaper's tiles: the classic 72-tile tile-laying set (24 kinds), described by what each
 * edge holds and which parts of the tile join up.
 *
 * Edges are 0 N, 1 E, 2 S, 3 W. Fields meet at "halves": each edge has two, numbered clockwise
 * around the tile, so edge e has halves 2e and 2e + 1 (N: 0 west, 1 east; E: 2 north, 3 south;
 * S: 4 east, 5 west; W: 6 south, 7 north). A road edge splits its field into those two halves.
 */

export type Edge = 'city' | 'road' | 'field';

export interface TileKind {
  id: string;
  count: number;
  edges: [Edge, Edge, Edge, Edge];
  /** Separate city parts on the tile, by the edges each reaches; shields add to the score. */
  cities: { edges: number[]; shield?: boolean }[];
  /** Road segments by the edges they reach (one edge: it ends on this tile). */
  roads: { edges: number[] }[];
  /** Field areas by their halves, and which of this tile's cities each one borders. */
  fields: { halves: number[]; cities: number[] }[];
  cloister?: boolean;
}

const C = 'city' as const;
const R = 'road' as const;
const F = 'field' as const;

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

export const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k])) as Record<string, TileKind>;
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
