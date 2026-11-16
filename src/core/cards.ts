export type Suit = 'S' | 'H' | 'D' | 'C';

export interface Card {
  id: number;
  suit: Suit;
  /** 1 = Ace … 13 = King */
  rank: number;
  faceUp: boolean;
}

// U+FE0E forces text presentation so iOS doesn't render the suits as emoji.
export const SUIT_SYMBOL: Record<Suit, string> = {
  S: '♠︎',
  H: '♥︎',
  D: '♦︎',
  C: '♣︎',
};

export const SUIT_NAME: Record<Suit, string> = {
  S: 'spades',
  H: 'hearts',
  D: 'diamonds',
  C: 'clubs',
};

const RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_NAMES = ['', 'Ace', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King'];

export const rankLabel = (rank: number) => RANK_LABELS[rank];
export const cardName = (c: Card) => `${RANK_NAMES[c.rank]} of ${SUIT_NAME[c.suit]}`;

/** Deterministic PRNG so a deal can be restarted and saved as just a seed. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Where the suit symbols sit on a classic number card, as x/y fractions of the pip area
 * (lower-half pips are drawn upside down, like a real card).
 */
export const PIPS: Record<number, [number, number][]> = (() => {
  const corners: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const sides: [number, number][] = [[0, 0.5], [1, 0.5]];
  const nine: [number, number][] = [[0, 0], [1, 0], [0, 1 / 3], [1, 1 / 3], [0, 2 / 3], [1, 2 / 3], [0, 1], [1, 1]];
  return {
    1: [[0.5, 0.5]],
    2: [[0.5, 0], [0.5, 1]],
    3: [[0.5, 0], [0.5, 0.5], [0.5, 1]],
    4: corners,
    5: [...corners, [0.5, 0.5]],
    6: [...corners, ...sides],
    7: [...corners, ...sides, [0.5, 0.25]],
    8: [...corners, ...sides, [0.5, 0.25], [0.5, 0.75]],
    9: [...nine, [0.5, 0.5]],
    10: [...nine, [0.5, 1 / 6], [0.5, 5 / 6]],
  };
})();

export const randomSeed = () => (Math.random() * 2 ** 32) >>> 0;
