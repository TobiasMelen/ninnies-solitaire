import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../core/cards';
import { ADVISOR, EASY, SHARP, STEADY, type Skill, chooseCard, choosePassCards, skillFor } from './ai';
import {
  type HeartsState,
  type Seat,
  SEATS,
  choosePass,
  handPoints,
  legalPlays,
  newGame,
  playCard,
  startHand,
  value,
} from './rules';

const opts = { passing: true, target: 100, moonSubtracts: false };

function playHandWithAI(s: HeartsState, seed = 1) {
  const rand = mulberry32(seed);
  if (s.phase === 'pass') for (const seat of SEATS) choosePass(s, seat, choosePassCards(s.hands[seat], rand));
  while (s.phase === 'play') playCard(s, s.turn, chooseCard(s, s.turn, rand));
}

describe('dealing and passing', () => {
  it('deals 13 unique cards to each seat', () => {
    const s = newGame(5, opts);
    const ids = s.hands.flat().map((c) => c.id);
    expect(s.hands.map((h) => h.length)).toEqual([13, 13, 13, 13]);
    expect(new Set(ids).size).toBe(52);
  });

  it('passes left, then right, across and none', () => {
    const s = newGame(5, opts);
    const dirs = [];
    for (let i = 0; i < 4; i++) {
      dirs.push(s.passDir);
      playHandWithAI(s, i);
      startHand(s);
    }
    expect(dirs).toEqual(['left', 'right', 'across', 'none']);
  });

  it('moves passed cards to the right seat and lets the 2♣ lead', () => {
    const s = newGame(9, opts);
    const passed = s.hands[0].slice(0, 3);
    for (const seat of SEATS) choosePass(s, seat, s.hands[seat].slice(0, 3));
    expect(passed.every((c) => s.hands[1].some((x) => x.id === c.id))).toBe(true);
    expect(s.received).toHaveLength(3);
    expect(s.hands[s.turn].some((c) => c.suit === 'C' && c.rank === 2)).toBe(true);
    expect(legalPlays(s, s.turn).map((c) => `${c.suit}${c.rank}`)).toEqual(['C2']);
  });
});

describe('playing', () => {
  it('requires following suit and keeps hearts unbroken until played', () => {
    const s = newGame(3, { ...opts, passing: false });
    playCard(s, s.turn, legalPlays(s, s.turn)[0]); // 2♣
    const seat = s.turn;
    const legal = legalPlays(s, seat);
    if (s.hands[seat].some((c) => c.suit === 'C')) expect(legal.every((c) => c.suit === 'C')).toBe(true);
    else expect(legal.some((c) => c.suit === 'H')).toBe(false); // no points on trick one
  });

  it('plays full games with AI and keeps 26 points per hand', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = newGame(seed, opts);
      while (s.phase !== 'gameOver') {
        playHandWithAI(s, seed * 31 + s.handNo);
        const last = s.history.at(-1)!;
        const sum = last.reduce((a, b) => a + b, 0);
        expect(s.moon === null ? sum === 26 : sum === 78).toBe(true);
        if (s.phase === 'handOver') startHand(s);
      }
      expect(Math.max(...s.scores)).toBeGreaterThanOrEqual(100);
    }
  });
});

describe('scoring', () => {
  it('gives everyone else 26 when someone shoots the moon', () => {
    const s = newGame(1, opts);
    s.taken = [[], [], [], []];
    for (let r = 1; r <= 13; r++) s.taken[2].push({ id: 100 + r, suit: 'H', rank: r, faceUp: true });
    s.taken[2].push({ id: 200, suit: 'S', rank: 12, faceUp: true });
    expect(handPoints(s)).toEqual({ points: [26, 26, 0, 26], moon: 2 });
    s.options = { ...opts, moonSubtracts: true };
    expect(handPoints(s).points).toEqual([0, 0, -26, 0]);
  });
});

describe('AI', () => {
  it('only ever chooses legal cards', () => {
    const s = newGame(11, opts);
    const rand = mulberry32(4);
    for (const seat of SEATS) choosePass(s, seat, choosePassCards(s.hands[seat], rand));
    while (s.phase === 'play') {
      const seat = s.turn as Seat;
      const card = chooseCard(s, seat, rand, ADVISOR);
      expect(legalPlays(s, seat).some((c) => c.id === card.id)).toBe(true);
      playCard(s, seat, card);
    }
  });

  it('passes the queen of spades when it is poorly guarded', () => {
    const hand = [
      { id: 1, suit: 'S' as const, rank: 12, faceUp: true },
      { id: 2, suit: 'S' as const, rank: 3, faceUp: true },
      ...Array.from({ length: 11 }, (_, i) => ({ id: 10 + i, suit: 'C' as const, rank: i + 2, faceUp: true })),
    ];
    const pass = choosePassCards(hand, mulberry32(1), { ...STEADY, mistakes: 0 });
    expect(pass.some((c) => c.suit === 'S' && c.rank === 12)).toBe(true);
  });

  it('ducks under the current winner when it can', () => {
    const s = newGame(2, { ...opts, passing: false });
    // Hand-built mid-hand trick: west led the 9♦, we hold 4♦ and K♦.
    s.trickNo = 3;
    s.heartsBroken = true;
    s.trick = [{ seat: 1, card: { id: 90, suit: 'D', rank: 9, faceUp: true } }];
    s.turn = 2;
    s.hands[2] = [
      { id: 91, suit: 'D', rank: 4, faceUp: true },
      { id: 92, suit: 'D', rank: 13, faceUp: true },
    ];
    const card = chooseCard(s, 2, mulberry32(1), { ...STEADY, mistakes: 0 });
    expect(value(card)).toBe(4);
  });
});

describe('skill levels', () => {
  /** Average points per hand for each seat over a number of hands. */
  function average(skills: Skill[], hands: number) {
    const rand = mulberry32(99);
    const total = [0, 0, 0, 0];
    for (let g = 0; g < hands; g++) {
      const s = newGame(1000 + g * 31, { passing: true, target: 100000, moonSubtracts: false });
      for (const seat of SEATS) choosePass(s, seat, choosePassCards(s.hands[seat], rand, skills[seat]));
      while (s.phase === 'play') playCard(s, s.turn, chooseCard(s, s.turn, rand, skills[s.turn]));
      s.history[0].forEach((p, i) => (total[i] += p));
    }
    return total.map((t) => t / hands);
  }

  it('a sharp player takes clearly fewer points than easy ones', () => {
    const [sharp, ...easy] = average([SHARP, EASY, EASY, EASY], 60);
    expect(sharp).toBeLessThan(Math.min(...easy) - 1);
  });

  it('gives opponents a mix of levels that stays the same for a game', () => {
    const seen = new Set<Skill>();
    for (let seed = 1; seed <= 40; seed++) for (const seat of [1, 2, 3] as const) seen.add(skillFor(seed, seat));
    expect(seen.size).toBe(3);
    expect(skillFor(1234, 2)).toBe(skillFor(1234, 2));
  });

  it('notes a suit a player has shown out of', () => {
    const s = newGame(5, { passing: false, target: 100, moonSubtracts: false });
    while (s.phase === 'play' && s.voids!.every((v) => !v)) {
      const before = { seat: s.turn, lead: s.trick[0]?.card.suit };
      const card = legalPlays(s, s.turn)[0];
      playCard(s, s.turn, card);
      if (before.lead && card.suit !== before.lead) expect(s.voids![before.seat]).toContain(before.lead);
    }
    expect(s.voids!.some((v) => v)).toBe(true);
  });
});
