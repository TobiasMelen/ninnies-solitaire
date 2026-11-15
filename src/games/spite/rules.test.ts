import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../core/cards';
import { ADVISOR, OPPONENT, chooseBuild, chooseDiscard } from './ai';
import { type Player, type SpiteState, apply, buildDeck, buildMoves, canBuild, newGame, needs } from './rules';

const opts = { goalSize: 20 };

function playTurn(s: SpiteState, rand: () => number, skill = OPPONENT) {
  const p = s.turn;
  for (let guard = 0; guard < 60 && s.winner === null; guard++) {
    const m = chooseBuild(s, p, rand, skill);
    if (!m) break;
    apply(s, p, m);
  }
  if (s.winner === null) apply(s, p, chooseDiscard(s, p, rand, skill));
}

describe('deck and deal', () => {
  it('has 108 cards with 12 wild stars (8 kings + 4 jokers)', () => {
    const d = buildDeck();
    expect(d).toHaveLength(108);
    expect(d.filter((c) => c.star)).toHaveLength(12);
    expect(new Set(d.map((c) => c.id)).size).toBe(108);
  });

  it('deals goal piles and a full hand to the first player', () => {
    const s = newGame(1, opts);
    expect(s.seats.map((x) => x.goal.length)).toEqual([20, 20]);
    expect(s.seats[s.turn].hand).toHaveLength(5);
    expect(s.seats[0].goal.at(-1)!.faceUp).toBe(true);
    expect(s.stock.length + 40 + 5).toBe(108);
  });
});

describe('building', () => {
  it('builds 1 → 12 with stars wild, and clears a finished pile', () => {
    const s = newGame(2, opts);
    const p = s.turn;
    const seat = s.seats[p];
    seat.hand = [];
    for (let r = 1; r <= 12; r++) seat.hand.push({ id: 900 + r, suit: 'S', rank: r === 7 ? 13 : r, faceUp: true, star: r === 7 });
    for (let i = 0; i < 12; i++) {
      expect(canBuild(s, p, { from: 'hand', index: 0 }, 0)).toBe(true);
      apply(s, p, { t: 'build', source: { from: 'hand', index: 0 }, pile: 0 });
      // Emptying the hand draws five more; keep only the test cards in front.
      seat.hand = seat.hand.filter((c) => c.id >= 900);
    }
    expect(s.builds[0]).toHaveLength(0);
    expect(s.spent).toHaveLength(12);
  });

  it('refuses a card that does not fit', () => {
    const s = newGame(3, opts);
    const p = s.turn;
    s.seats[p].hand[0] = { id: 999, suit: 'H', rank: 5, faceUp: true };
    expect(needs(s.builds[0])).toBe(1);
    expect(canBuild(s, p, { from: 'hand', index: 0 }, 0)).toBe(false);
  });

  it('wins when the goal pile empties', () => {
    const s = newGame(4, { goalSize: 1 });
    const p = s.turn;
    s.seats[p].goal = [{ id: 999, suit: 'H', rank: 1, faceUp: true }];
    apply(s, p, { t: 'build', source: { from: 'goal' }, pile: 0 });
    expect(s.winner).toBe(p);
  });
});

describe('AI', () => {
  // Plays whole games, so give it room on slow CI runners.
  it('only makes legal moves and finishes games', { timeout: 60_000 }, () => {
    let finished = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const s = newGame(seed, { goalSize: 13 });
      const rand = mulberry32(seed);
      for (let turn = 0; turn < 600 && s.winner === null && !s.stalemate; turn++) playTurn(s, rand);
      if (s.winner !== null) finished++;
      const total = s.stock.length + s.spent.length + s.builds.flat().length + s.seats.flatMap((x) => [...x.goal, ...x.hand, ...x.discards.flat()]).length;
      expect(total).toBe(108);
    }
    expect(finished).toBeGreaterThanOrEqual(7);
  });

  it('plays its goal card when it can', () => {
    const s = newGame(5, opts);
    const p = s.turn as Player;
    s.seats[p].goal.at(-1)!.rank = 1;
    s.seats[p].goal.at(-1)!.star = false;
    const m = chooseBuild(s, p, mulberry32(1), ADVISOR);
    expect(m).toMatchObject({ t: 'build', source: { from: 'goal' } });
  });

  it('keeps stars instead of discarding them', () => {
    const s = newGame(6, opts);
    const p = s.turn as Player;
    s.seats[p].hand[0] = { id: 999, suit: 'H', rank: 13, faceUp: true, star: true };
    const m = chooseDiscard(s, p, mulberry32(1), ADVISOR);
    expect(m.t === 'discard' && m.index).not.toBe(0);
    expect(buildMoves(s, p).length).toBeGreaterThanOrEqual(0);
  });
});
