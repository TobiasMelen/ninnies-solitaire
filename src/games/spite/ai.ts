import {
  type Move,
  type Player,
  type Source,
  type SpiteCard,
  type SpiteState,
  apply,
  buildMoves,
  clone,
  needs,
} from './rules';

/**
 * Spite and Malice AI: searches a few plays ahead for the line that gets the most goal cards
 * out (then empties the hand, then uses up personal piles), saves ★ Stars for when they
 * matter, and tries not to hand the opponent their goal card. Difficulty changes how far it
 * looks, how hard it blocks, and how often it slips.
 */
export interface Skill {
  /** Chance of a careless move instead of the considered one. */
  mistakes: number;
  /** How many plays ahead it searches. */
  depth: number;
  /** How much it dislikes leaving the opponent able to play their goal card. */
  block: number;
  /** Also count the opponent's visible pile tops when judging what they could reach. */
  reach: boolean;
  /** Value of a hand card played (low = it holds cards back rather than feed the piles). */
  handPlay: number;
}

export type Level = 'easy' | 'medium' | 'hard';

export const SKILL: Record<Level, Skill> = {
  easy: { mistakes: 0.1, depth: 4, block: 70, reach: false, handPlay: 4 },
  medium: { mistakes: 0.04, depth: 5, block: 110, reach: false, handPlay: 2 },
  hard: { mistakes: 0, depth: 6, block: 160, reach: true, handPlay: 1 },
};

/** Used for the player's hints. */
export const ADVISOR = SKILL.hard;

/** Most positions a single decision may examine, so deep searches stay quick. */
const NODE_BUDGET = 5000;

const other = (p: Player) => (1 - p) as Player;

/**
 * Can the opponent get their goal card out from this position? Easy/medium only look at the
 * pile tops; hard also uses the cards showing on the opponent's own piles as stepping stones.
 */
function feedsOpponent(s: SpiteState, p: Player, skill: Skill) {
  const foe = s.seats[other(p)];
  const goal = foe.goal.at(-1);
  if (!goal) return false;
  if (goal.star) return true;
  const steps = skill.reach ? foe.discards.map((d) => d.at(-1)).filter((c): c is SpiteCard => !!c) : [];
  return s.builds.some((pile) => {
    let need = needs(pile);
    const pool = [...steps];
    // Climb with visible cards until the goal card fits (or nothing helps).
    for (let guard = 0; guard < 12; guard++) {
      if (need === goal.rank) return true;
      const i = pool.findIndex((c) => c.star || c.rank === need);
      if (i < 0) return false;
      pool.splice(i, 1);
      need++;
      if (need > 12) return false;
    }
    return false;
  });
}

/** Score of a line of play that ended in state `s` (higher is better for `p`). */
function score(s: SpiteState, start: SpiteState, p: Player, starsUsed: number, skill: Skill) {
  const seat = s.seats[p];
  const was = start.seats[p];
  if (s.winner === p) return 10_000;
  let v = (was.goal.length - seat.goal.length) * 120;
  v += s.playedThisTurn * skill.handPlay;
  // Emptying the hand draws five fresh cards: worth it even for a cautious player.
  if (!seat.hand.length && was.hand.length) v += 12;
  v += (was.discards.flat().length - seat.discards.flat().length) * 6;
  v -= starsUsed * 14; // stars are precious unless they bought something above
  if (feedsOpponent(s, p, skill) && !feedsOpponent(start, p, skill)) v -= skill.block;
  return v;
}

interface Line {
  first: Move | null;
  value: number;
}

function search(s: SpiteState, start: SpiteState, p: Player, depth: number, starsUsed: number, first: Move | null, skill: Skill, budget: { left: number }): Line {
  let best: Line = { first, value: score(s, start, p, starsUsed, skill) };
  if (depth === 0 || s.winner !== null || budget.left <= 0) return best;
  for (const m of distinct(s, p, buildMoves(s, p))) {
    if (--budget.left <= 0) break;
    const next = clone(s);
    const card = sourceOf(next, p, m);
    const star = card?.star ? 1 : 0;
    apply(next, p, m);
    const line = search(next, start, p, depth - 1, starsUsed + star, first ?? m, skill, budget);
    if (line.value > best.value) best = line;
  }
  return best;
}

/**
 * Collapse equivalent plays: the same card value from the hand onto any pile needing the same
 * value leads to the same position. Goal and personal-pile plays differ by what they uncover.
 */
function distinct(s: SpiteState, p: Player, moves: Move[]) {
  const seen = new Set<string>();
  // Goal plays first, so a tight budget still finds them.
  const ordered = [...moves].sort((a, b) => Number(b.t === 'build' && b.source.from === 'goal') - Number(a.t === 'build' && a.source.from === 'goal'));
  return ordered.filter((m) => {
    if (m.t !== 'build') return false;
    const card = sourceOf(s, p, m)!;
    const src = m.source.from === 'discard' ? `d${m.source.pile}` : m.source.from;
    const key = `${src}:${card.star ? '*' : card.rank}:${needs(s.builds[m.pile])}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceOf(s: SpiteState, p: Player, m: Move): SpiteCard | undefined {
  if (m.t !== 'build') return undefined;
  const seat = s.seats[p];
  const src = m.source;
  return src.from === 'hand' ? seat.hand[src.index] : src.from === 'goal' ? seat.goal.at(-1) : seat.discards[src.pile].at(-1);
}

/** The next centre-pile play worth making, or null when it's time to discard. */
export function chooseBuild(s: SpiteState, p: Player, rand: () => number, skill: Skill = SKILL.easy): Move | null {
  const moves = buildMoves(s, p);
  if (!moves.length) return null;
  if (rand() < skill.mistakes) {
    // A slip: either stop early or make a hasty play.
    return rand() < 0.5 ? null : moves[Math.floor(rand() * moves.length)];
  }
  const line = search(s, s, p, skill.depth, 0, null, skill, { left: NODE_BUDGET });
  return line.value > 0 ? line.first : null;
}

/**
 * Where a given card is best played (e.g. a wild ★ that fits every centre pile): try each pile
 * it fits and look ahead from there, keeping the best.
 */
export function bestPileFor(s: SpiteState, p: Player, source: Source, skill: Skill = ADVISOR): number | null {
  let best: number | null = null;
  let bestValue = -Infinity;
  for (let pile = 0; pile < s.builds.length; pile++) {
    const m: Move = { t: 'build', source, pile };
    if (!buildMoves(s, p).some((x) => x.t === 'build' && x.pile === pile && sameSource(x.source, source))) continue;
    const next = clone(s);
    const star = sourceOf(next, p, m)?.star ? 1 : 0;
    apply(next, p, m);
    const line = search(next, s, p, skill.depth - 1, star, m, skill, { left: NODE_BUDGET });
    if (line.value > bestValue) {
      bestValue = line.value;
      best = pile;
    }
  }
  return best;
}

const sameSource = (a: Source, b: Source) => JSON.stringify(a) === JSON.stringify(b);

/** End the turn: which hand card goes on which personal pile. */
export function chooseDiscard(s: SpiteState, p: Player, rand: () => number, skill: Skill = SKILL.easy): Move {
  const seat = s.seats[p];
  if (!seat.hand.length) return { t: 'pass' };
  const goal = seat.goal.at(-1);
  const careful = skill.reach;
  let best: Move = { t: 'discard', index: 0, pile: 0 };
  let bestScore = -Infinity;
  seat.hand.forEach((card, index) => {
    seat.discards.forEach((pile, pi) => {
      const top = pile.at(-1);
      let v = 0;
      if (card.star) v -= 100; // never throw away a star if anything else will do
      v += card.rank; // high cards are least useful in hand
      if (!top) v += 4; // an empty pile is a fine home…
      else if (top.rank === card.rank) v += 10; // stacking the same value keeps piles tidy
      else if (!top.star && top.rank === card.rank + 1) v += 14; // descending runs play out in order later
      else v -= careful ? 12 : 6; // burying a different card
      if (top && goal && !goal.star && top.rank === goal.rank - 1) v -= 12; // don't bury a step toward our goal
      // Keep a card back if it's exactly what we'd need right after our goal card.
      if (careful && goal && !goal.star && card.rank === goal.rank + 1) v -= 8;
      v += rand() * (skill.mistakes ? 6 : 1);
      if (v > bestScore) {
        bestScore = v;
        best = { t: 'discard', index, pile: pi };
      }
    });
  });
  return best;
}
