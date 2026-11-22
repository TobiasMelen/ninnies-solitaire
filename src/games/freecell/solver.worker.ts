import type { FreeCellState } from './rules';
import { solve } from './solver';

// Typed by hand: the webworker lib would retype the app's own globals.
const ctx = self as unknown as {
  onmessage: (e: MessageEvent<{ id: number; state: FreeCellState }>) => void;
  postMessage(msg: unknown): void;
};

// Solving can take a moment, so it runs here, off the main thread: a quick search first, then
// a much bigger one for the rare deal that needs it.
ctx.onmessage = (e) => {
  const { id, state } = e.data;
  const line = solve(state) ?? solve(state, 800_000);
  ctx.postMessage({ id, line });
};
