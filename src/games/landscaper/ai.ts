import { mulberry32 } from '../../core/cards';
import { type Analysis, type LandscaperState, type Move, analyse, followerSpots, owners, placements, play } from './rules';

/**
 * Landscaper opponents. Each tries every spot, turn and follower choice for its tile and judges
 * the result: points banked, plus what the features it holds are likely to become, minus the
 * same for everyone else. Weaker players judge with some noise.
 */
export interface Skill {
  /** Random wobble added to each option's value: big means careless. */
  noise: number;
  /** How much a follower is worth keeping in hand. */
  followerValue: number;
}

export const EASY: Skill = { noise: 6, followerValue: 0.6 };
export const STEADY: Skill = { noise: 1.5, followerValue: 1.2 };
export const SHARP: Skill = { noise: 0, followerValue: 1.5 };
/** The Hint Bunny's advice. */
export const ADVISOR = SHARP;

const LEVELS = [EASY, STEADY, SHARP];
/** Each opponent's level comes from the game's seed: random per game, the same on resume. */
export const skillFor = (seed: number, seat: number): Skill =>
  LEVELS[Math.floor(mulberry32((seed ^ Math.imul(seat + 7, 0x9e3779b1)) >>> 0)() * LEVELS.length)];

/** What a feature someone holds is likely to be worth by the end. */
function prospect(s: LandscaperState, a: Analysis, f: Analysis['features'][number]): number {
  const left = s.pile.length + 1;
  // Less likely to get finished with many open edges, or with few tiles left to do it.
  const chance = Math.max(0, Math.min(0.95, (left / 40) / (1 + 0.6 * f.open)));
  switch (f.part) {
    case 'road':
      return f.tiles.size;
    case 'city': {
      const done = 2 * (f.tiles.size + f.shields);
      return f.complete ? done : chance * done + (1 - chance) * (f.tiles.size + f.shields);
    }
    case 'cloister':
      return f.complete ? 9 : f.tiles.size + Math.min(9 - f.tiles.size, left / 8) * 0.8;
    case 'field': {
      const borders = [...f.borders].map((c) => a.features[c]);
      return borders.reduce((n, c) => n + (c.complete ? 3 : 3 * Math.min(0.8, left / 50)), 0);
    }
  }
}

/** How good a position is for player `me`. */
export function value(s: LandscaperState, me: number, skill: Skill): number {
  const a = analyse(s);
  const total = [...s.scores];
  if (!s.over) {
    for (const f of a.features) {
      if (!f.followers.length) continue;
      const v = prospect(s, a, f);
      for (const p of owners(f, s.options.players)) total[p] += v;
    }
    s.followers.forEach((n, p) => (total[p] += n * skill.followerValue));
  }
  const others = total.filter((_, p) => p !== me);
  return total[me] - Math.max(...others) * 0.6 - (others.reduce((x, y) => x + y, 0) / others.length) * 0.4;
}

/** The current player's move. */
export function chooseMove(s: LandscaperState, rand: () => number, skill: Skill): Move {
  const me = s.turn;
  let best: Move | null = null;
  let bestValue = -Infinity;
  for (const p of placements(s, s.current!)) {
    const laid = structuredClone(s);
    laid.tiles.push({ k: s.current!, r: p.r, x: p.x, y: p.y });
    const spots = followerSpots(laid);
    for (const f of [undefined, ...spots]) {
      const m: Move = { ...p, f };
      const next = structuredClone(s);
      play(next, m);
      const v = value(next, me, skill) + rand() * skill.noise;
      if (v > bestValue) (bestValue = v), (best = m);
    }
  }
  return best!;
}
