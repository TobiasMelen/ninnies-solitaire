import { type Skill, type Style, chooseMove } from './ai';
import type { LandscaperState } from './rules';

// Typed by hand: the webworker lib would retype the app's own globals.
const ctx = self as unknown as {
  onmessage: (e: MessageEvent<{ id: number; state: LandscaperState; skill: Skill; style?: Style }>) => void;
  postMessage(msg: unknown): void;
};

// Weighing every spot, turn and follower takes a moment late in the game, so opponents (and
// the Hint Bunny) think here, off the main thread, and the board stays smooth meanwhile.
ctx.onmessage = (e) => {
  const { id, state, skill, style } = e.data;
  ctx.postMessage({ id, move: chooseMove(state, Math.random, skill, style) });
};
