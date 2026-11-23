import { mulberry32 } from '../../core/cards';
import { type Analysis, type LandscaperState, type Move, type Part, analyse, followerSpots, owners, placements, play } from './rules';

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

// Between full strength and the gentlest tuning: a real challenge, still beatable.
export const EASY: Skill = { noise: 9, followerValue: 0.45 };
export const STEADY: Skill = { noise: 3.5, followerValue: 1.05 };
export const SHARP: Skill = { noise: 1.2, followerValue: 1.4 };
/** The Hint Bunny's advice: the best it can see, no noise. */
export const ADVISOR: Skill = { noise: 0, followerValue: 1.5 };

/** Easy, medium and hard. */
export const LEVELS = [EASY, STEADY, SHARP];
/** A level picked at random from the game's seed (games from before you could choose). */
const levelFor = (seed: number, seat: number) => Math.floor(mulberry32((seed ^ Math.imul(seat + 7, 0x9e3779b1)) >>> 0)() * LEVELS.length);

/**
 * A playstyle: how much a player cares about each kind of thing. 1 is neutral. `banked` is points
 * already scored, `others` how much they mind what everyone else is getting.
 */
export interface Style {
  id: 'builder' | 'saboteur' | 'longGame' | 'opportunist';
  banked: number;
  others: number;
  followers: number;
  part: Record<Part, number>;
}

export const STYLES: Style[] = [
  // Grows big cities and long roads.
  { id: 'builder', banked: 1, others: 0.8, followers: 1, part: { city: 1.35, road: 1.15, cloister: 1, field: 0.6 } },
  // Mostly out to keep everyone else's score down.
  { id: 'saboteur', banked: 1, others: 1.45, followers: 0.9, part: { city: 1, road: 1, cloister: 1, field: 0.9 } },
  // Farms and cloisters, followers kept back for later.
  { id: 'longGame', banked: 0.9, others: 1, followers: 1.35, part: { city: 0.95, road: 0.8, cloister: 1.25, field: 1.55 } },
  // Points now beat plans.
  { id: 'opportunist', banked: 1.3, others: 1, followers: 0.8, part: { city: 0.85, road: 0.9, cloister: 0.8, field: 0.6 } },
];

/** Neutral: how the Hint Bunny and the end of the game see things. */
export const BALANCED: Style = { id: 'builder', banked: 1, others: 1, followers: 1, part: { city: 1, road: 1, cloister: 1, field: 1 } };

export type StyleId = Style['id'];
/** Who sits in an opponent's seat: a playstyle and a level (0 easy, 1 medium, 2 hard). */
export interface Seat {
  style: StyleId;
  level: number;
}

/** A random opponent for a seat, from the game's seed. */
export function randomSeat(seed: number, seat: number): Seat {
  const rand = mulberry32((seed ^ Math.imul(seat + 3, 0x85ebca6b)) >>> 0);
  return { style: STYLES[Math.floor(rand() * STYLES.length)].id, level: levelFor(seed, seat) };
}

/** Who's in seat `seat` (1 and up): as chosen, or at random for games from before you could choose. */
export const seatOf = (s: LandscaperState, seat: number): Seat => (s.options.lineup?.[seat - 1] as Seat | undefined) ?? randomSeat(s.seed, seat);

export const skillOf = (s: LandscaperState, seat: number): Skill => LEVELS[seatOf(s, seat).level];

/**
 * An opponent's style, with every weight nudged up to 15% either way (from the game's seed, so
 * the same on resume) so no two players of a style are quite alike.
 */
export function styleOf(s: LandscaperState, seat: number): Style {
  const rand = mulberry32((s.seed ^ Math.imul(seat + 3, 0x85ebca6b)) >>> 0);
  rand();
  const base = STYLES.find((x) => x.id === seatOf(s, seat).style) ?? STYLES[0];
  const nudge = (x: number) => x * (0.85 + rand() * 0.3);
  return {
    id: base.id,
    banked: nudge(base.banked),
    others: nudge(base.others),
    followers: nudge(base.followers),
    part: { city: nudge(base.part.city), road: nudge(base.part.road), cloister: nudge(base.part.cloister), field: nudge(base.part.field) },
  };
}

/** What a feature someone holds is likely to be worth by the end. */
function prospect(s: LandscaperState, a: Analysis, f: Analysis['features'][number]): number {
  const left = s.pile.length + 1;
  // Less likely to get finished with many open edges, or with few tiles left to do it.
  const chance = Math.max(0, Math.min(0.95, (left / 40) / (1 + 0.6 * f.open)));
  switch (f.part) {
    case 'road':
      // An inn: twice as much finished, nothing if not.
      return f.inn ? (f.complete ? 2 : 2 * chance) * f.tiles.size : f.tiles.size;
    case 'city': {
      if (f.cathedral) return (f.complete ? 3 : 3 * chance) * (f.tiles.size + f.shields);
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

/** How good a position is for player `me`, seen through their style. */
export function value(s: LandscaperState, me: number, skill: Skill, style: Style = BALANCED): number {
  const a = analyse(s);
  // Everyone else is judged plainly; `me` through the style's own leanings.
  const total = s.scores.map((n, p) => (p === me ? n * style.banked : n));
  if (!s.over) {
    for (const f of a.features) {
      if (!f.followers.length) continue;
      const v = prospect(s, a, f);
      for (const p of owners(f, s.options.players)) total[p] += p === me ? v * style.part[f.part] : v;
    }
    s.followers.forEach((n, p) => (total[p] += (n + (s.big?.[p] ? 1.5 : 0)) * skill.followerValue * (p === me ? style.followers : 1)));
  }
  const others = total.filter((_, p) => p !== me);
  const theirs = Math.max(...others) * 0.6 + (others.reduce((x, y) => x + y, 0) / others.length) * 0.4;
  return total[me] - theirs * style.others;
}

/** The current player's move. */
export function chooseMove(s: LandscaperState, rand: () => number, skill: Skill, style: Style = BALANCED): Move {
  const me = s.turn;
  let best: Move | null = null;
  let bestValue = -Infinity;
  for (const p of placements(s, s.current!)) {
    const laid = structuredClone(s);
    laid.tiles.push({ k: s.current!, r: p.r, x: p.x, y: p.y });
    const spots = followerSpots(laid);
    // Each spot with an ordinary follower (if any left) and with the big one (if it's in hand).
    const options = [undefined, ...(s.followers[me] > 0 ? spots : []), ...(s.big?.[me] ? spots.map((x) => ({ ...x, big: true })) : [])];
    for (const f of options) {
      const m: Move = { ...p, f };
      const next = structuredClone(s);
      play(next, m);
      const v = value(next, me, skill, style) + rand() * skill.noise;
      if (v > bestValue) (bestValue = v), (best = m);
    }
  }
  return best!;
}
