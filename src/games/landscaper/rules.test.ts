import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../core/cards';
import { STEADY, chooseMove } from './ai';
import { type LandscaperState, analyse, followerSpots, newGame, owners, placements, play, worth } from './rules';
import { KINDS, RIVER_KINDS } from './tiles';

const opts = { players: 2, farmers: true };

/** A board with just the given tiles (and an empty pile apart from what's needed). */
function board(tiles: LandscaperState['tiles'], current = 'E', pile: string[] = ['E', 'E']): LandscaperState {
  return { seed: 1, options: opts, pile, tiles, scores: [0, 0], followers: [7, 7], turn: 0, current, scored: [], over: false };
}

describe('tile set', () => {
  it('has the classic 72 tiles', () => {
    expect(KINDS.reduce((n, k) => n + k.count, 0)).toBe(72);
  });
  it('the river has 13 tiles (the classic 12 and an extra bend)', () => {
    expect(RIVER_KINDS.reduce((n, k) => n + k.count, 0)).toBe(13);
  });
  it('every field half and city/road/river edge is accounted for exactly once', () => {
    for (const k of [...KINDS, ...RIVER_KINDS]) {
      const halves = k.fields.flatMap((f) => f.halves).sort((a, b) => a - b);
      const expected = [0, 1, 2, 3].flatMap((e) => (k.edges[e] === 'city' ? [] : [2 * e, 2 * e + 1]));
      expect(halves, k.id).toEqual(expected);
      for (const part of ['city', 'road', 'river'] as const) {
        const edges = (part === 'city' ? k.cities : part === 'road' ? k.roads : (k.rivers ?? [])).flatMap((p) => p.edges).sort();
        expect(edges, `${k.id} ${part}`).toEqual([0, 1, 2, 3].filter((e) => k.edges[e] === part));
      }
    }
  });
});

describe('laying tiles', () => {
  it('starts with the start tile and a tile to lay', () => {
    const s = newGame(5, opts);
    expect(s.tiles).toHaveLength(1);
    expect(s.pile.length + 1 + 1).toBeLessThanOrEqual(72);
    expect(placements(s, s.current!).length).toBeGreaterThan(0);
  });

  it('only allows matching edges', () => {
    // Start tile D: city north, road east-west, field south.
    const s = board([{ k: 'D', r: 0, x: 0, y: 0 }]);
    // A city cap (E) above the start: its city must face down (turned twice).
    const above = placements(s, 'E').filter((p) => p.x === 0 && p.y === -1);
    expect(above.map((p) => p.r)).toEqual([2]);
  });
});

describe('scoring', () => {
  it('a two-tile city scores 4 for its owner when closed', () => {
    const s = board([{ k: 'D', r: 0, x: 0, y: 0, f: { p: 0, part: 'city', i: 0 } }], 'E');
    s.followers[0] = 6;
    play(s, { x: 0, y: -1, r: 2 });
    expect(s.scores[0]).toBe(4);
    expect(s.followers[0]).toBe(7);
    expect(s.tiles[0].f).toBeUndefined();
  });

  it('joins a road across tiles and counts every tile', () => {
    const s = board([{ k: 'D', r: 0, x: 0, y: 0 }], 'U');
    play(s, { x: 1, y: 0, r: 1 }); // straight road east-west
    const a = analyse(s);
    const road = a.features[a.of.get('0:road:0')!];
    expect(road.tiles.size).toBe(2);
    expect(road.open).toBe(2);
  });

  it('a follower cannot join a feature someone already holds', () => {
    const s = board([{ k: 'D', r: 0, x: 0, y: 0, f: { p: 1, part: 'road', i: 0 } }], 'U');
    s.tiles.push({ k: 'U', r: 1, x: 1, y: 0 });
    expect(followerSpots(s).some((sp) => sp.part === 'road')).toBe(false);
    expect(followerSpots(s).some((sp) => sp.part === 'field')).toBe(true);
  });

  it('farmers score 3 per finished city their field borders, at the end', () => {
    // Farmer on the start tile's north field, which borders its city; the last tile closes it.
    const s = board([{ k: 'D', r: 0, x: 0, y: 0, f: { p: 1, part: 'field', i: 0 } }], 'E', []);
    play(s, { x: 0, y: -1, r: 2 });
    expect(s.over).toBe(true);
    expect(s.scores[1]).toBe(3);
    expect(s.scored.some((x) => x.part === 'field' && x.final)).toBe(true);
  });

  it('lays the whole river first, from spring to lake, without it doubling back', () => {
    const s = newGame(9, { players: 2, farmers: true, river: true });
    expect(s.tiles[0].k).toBe('rS');
    for (let i = 0; i < 12; i++) {
      expect(s.current!.startsWith('r'), `tile ${i}`).toBe(true);
      play(s, placements(s, s.current!)[0]);
    }
    expect(s.tiles.at(-1)!.k).toBe('rL');
    expect(s.current!.startsWith('r')).toBe(false);
    // The river's squares are all different (it never ran into itself).
    expect(new Set(s.tiles.map((t) => `${t.x},${t.y}`)).size).toBe(13);
  });

  it('plays a whole random game to the end with consistent totals', () => {
    const s = newGame(42, { players: 3, farmers: true });
    let turns = 0;
    while (!s.over && turns < 100) {
      const [p] = placements(s, s.current!);
      play(s, p);
      turns++;
    }
    expect(s.over).toBe(true);
    expect(s.tiles.length).toBeGreaterThan(60);
  });
});

describe('Inns & Cathedrals', () => {
  it('an inn doubles a finished road and an unfinished one scores nothing', () => {
    const f = { part: 'road' as const, tiles: new Set([0, 1, 2]), open: 0, shields: 0, followers: [], inn: true, cathedral: false, borders: new Set<number>(), complete: true };
    const a = { features: [f], of: new Map() };
    expect(worth(f, a, false)).toBe(6);
    expect(worth({ ...f, complete: false, open: 1 }, a, true)).toBe(0);
  });

  it('a cathedral makes a finished city 3 a tile and an unfinished one nothing', () => {
    const f = { part: 'city' as const, tiles: new Set([0, 1]), open: 0, shields: 1, followers: [], inn: false, cathedral: true, borders: new Set<number>(), complete: true };
    const a = { features: [f], of: new Map() };
    expect(worth(f, a, false)).toBe(9);
    expect(worth({ ...f, complete: false, open: 2 }, a, true)).toBe(0);
  });

  it('the big boy counts as two', () => {
    const f = { part: 'city' as const, tiles: new Set([0]), open: 1, shields: 0, followers: [{ p: 0, tile: 0, big: true }, { p: 1, tile: 1 }], inn: false, cathedral: false, borders: new Set<number>(), complete: false };
    expect(owners(f, 2)).toEqual([0]);
  });

  it('plays whole games with the expansion, big boys and all', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const s = newGame(seed, { players: 3, farmers: true, inns: true });
      const rand = mulberry32(seed);
      while (!s.over) play(s, chooseMove(s, rand, STEADY));
      expect(s.tiles.length).toBeGreaterThan(80);
    }
  });
});
