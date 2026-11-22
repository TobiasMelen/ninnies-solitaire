import { type FreeCellState, type Move, applyMove, autoPlay } from './rules';

/** Identifies a position exactly (which column and cell each card is in). */
export const positionKey = (s: FreeCellState) =>
  `${s.cells.map((c) => c?.id ?? '-').join(',')}/${s.cascades.map((col) => col.map((c) => c.id).join(',')).join('|')}`;

/**
 * Asks the solver (in a worker) for winning lines and remembers them by position. A solved line
 * also answers every position along it, so following the hints never waits twice.
 */
export class Hints {
  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, { key: string; resolve: (line: Move[] | null) => void }>();
  private known = new Map<string, Move[] | null>();
  private asked = new Map<string, Promise<Move[] | null>>();

  /** The winning line from this position, if it has been worked out (null: none found). */
  peek(s: FreeCellState): Move[] | null | undefined {
    return this.known.get(positionKey(s));
  }

  line(s: FreeCellState): Promise<Move[] | null> {
    const key = positionKey(s);
    if (this.known.has(key)) return Promise.resolve(this.known.get(key)!);
    const pending = this.asked.get(key);
    if (pending) return pending;
    const p = new Promise<Move[] | null>((resolve) => {
      const id = this.nextId++;
      this.waiting.set(id, { key, resolve });
      this.ensureWorker().postMessage({ id, state: s });
    }).then((line) => {
      this.asked.delete(key);
      this.remember(s, line);
      return line;
    });
    this.asked.set(key, p);
    return p;
  }

  clear() {
    this.known.clear();
  }

  private remember(s: FreeCellState, line: Move[] | null) {
    if (this.known.size > 2000) this.known.clear();
    this.known.set(positionKey(s), line);
    if (!line) return;
    const walk = structuredClone(s);
    line.forEach((m, i) => {
      applyMove(walk, m);
      autoPlay(walk);
      this.known.set(positionKey(walk), line.slice(i + 1));
    });
  }

  private ensureWorker() {
    if (!this.worker) {
      this.worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ id: number; line: Move[] | null }>) => {
        const w = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        w?.resolve(e.data.line);
      };
    }
    return this.worker;
  }
}
