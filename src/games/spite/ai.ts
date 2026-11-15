import {
  type Move,
  type Player,
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
 * matter, and avoids leaving a centre pile one below the opponent's goal card. Like the
 * Hearts AI it is deliberately imperfect.
 */
export interface Skill {
  mistakes: number;
  depth: number;
}

export const OPPONENT: Skill = { mistakes: 0.1, depth: 4 };
export const ADVISOR: Skill = { mistakes: 0, depth: 5 };

const other = (p: Player) => (1 - p) as Player;

/** Does any centre pile now offer the opponent their goal card? */
function feedsOpponent(s: SpiteState, p: Player) {
  const top = s.seats[other(p)].goal.at(-1);
  if (!top) return false;
  return top.star || s.builds.some((pile) => needs(pile) === top.rank);
}

/** Score of a line of play that ended in state `s` (higher is better for `p`). */
function score(s: SpiteState, start: SpiteState, p: Player, starsUsed: number) {
  const seat = s.seats[p];
  const was = start.seats[p];
  if (s.winner === p) return 10_000;
  let v = (was.goal.length - seat.goal.length) * 120;
  v += s.playedThisTurn * 4; // hand cards played (draws fresh cards when the hand empties)
  v += (was.discards.flat().length - seat.discards.flat().length) * 6;
  v -= starsUsed * 14; // stars are precious unless they bought something above
  if (feedsOpponent(s, p) && !feedsOpponent(start, p)) v -= 70;
  return v;
}

interface Line {
  first: Move | null;
  value: number;
}

function search(s: SpiteState, start: SpiteState, p: Player, depth: number, starsUsed: number, first: Move | null): Line {
  let best: Line = { first, value: score(s, start, p, starsUsed) };
  if (depth === 0 || s.winner !== null) return best;
  for (const m of distinct(s, p, buildMoves(s, p))) {
    const next = clone(s);
    const card = sourceOf(next, p, m);
    const star = card?.star ? 1 : 0;
    apply(next, p, m);
    const line = search(next, start, p, depth - 1, starsUsed + star, first ?? m);
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
  return moves.filter((m) => {
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
export function chooseBuild(s: SpiteState, p: Player, rand: () => number, skill: Skill = OPPONENT): Move | null {
  const moves = buildMoves(s, p);
  if (!moves.length) return null;
  if (rand() < skill.mistakes) {
    // A slip: either stop early or make a hasty play.
    return rand() < 0.5 ? null : moves[Math.floor(rand() * moves.length)];
  }
  const line = search(s, s, p, skill.depth, 0, null);
  return line.value > 0 ? line.first : null;
}

/** End the turn: which hand card goes on which personal pile. */
export function chooseDiscard(s: SpiteState, p: Player, rand: () => number, skill: Skill = OPPONENT): Move {
  const seat = s.seats[p];
  if (!seat.hand.length) return { t: 'pass' };
  const goal = seat.goal.at(-1);
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
      else v -= 6; // burying a different card
      if (top && goal && !goal.star && top.rank === goal.rank - 1) v -= 12; // don't bury a step toward our goal
      v += rand() * (skill.mistakes ? 6 : 1);
      if (v > bestScore) {
        bestScore = v;
        best = { t: 'discard', index, pile: pi };
      }
    });
  });
  return best;
}
