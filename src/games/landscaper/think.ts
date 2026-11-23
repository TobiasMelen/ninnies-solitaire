import { type Skill, type Style, chooseMove } from './ai';
import type { LandscaperState, Move } from './rules';

let worker: Worker | null = null;
let next = 0;
const waiting = new Map<number, (m: Move) => void>();

/** A player's move, worked out in a worker so the board never stalls (on the spot if workers fail). */
export function think(s: LandscaperState, skill: Skill, style?: Style): Promise<Move> {
  try {
    if (!worker) {
      worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; move: Move }>) => {
        waiting.get(e.data.id)?.(e.data.move);
        waiting.delete(e.data.id);
      };
    }
    const id = ++next;
    return new Promise((done) => {
      waiting.set(id, done);
      worker!.postMessage({ id, state: s, skill, style });
    });
  } catch {
    return Promise.resolve(chooseMove(s, Math.random, skill, style));
  }
}
