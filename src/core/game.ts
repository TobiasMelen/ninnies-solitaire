import type { BunnyEvent } from '../ui/bunny';

export type GameId = 'spider' | 'hearts' | 'spite' | 'freecell';

export interface HudStat {
  label: string;
  value: string;
  /** Highlighted (e.g. whose turn it is, or the leader). */
  hot?: boolean;
}

export interface Hud {
  stats: HudStat[];
  canUndo: boolean;
  /** Games without undo hide the button entirely. */
  hasUndo: boolean;
}

export interface Result {
  title: string;
  line: string;
  stats: HudStat[];
  /** Play the cascade before showing the result. */
  celebrate: boolean;
}

/** What the app shell gives every game. */
export interface GameHooks {
  hud(h: Hud): void;
  toast(msg: string): void;
  /** The game is over (won, or for multiplayer games, finished). */
  finished(r: Result): void;
  stuck(): void;
  /** Something worth reacting to happened; `x` is where, 0–1 across the board. */
  event?(e: BunnyEvent, x?: number): void;
  /** A hint was shown: where it points (0–1 across the board), for the Hint Bunny to act out. */
  hint?(target: { from: number; to?: number } | null, kind: 'move' | 'deal' | 'none'): void;
  /**
   * Where cards reach down to along the bottom, so the Hint Bunny can sit out of the way: spans
   * across the board (x0–x1, 0–1) and how far down their cards come (y, 0–1 from the top).
   */
  occupied?(spans: { x0: number; x1: number; y: number }[]): void;
}

/** What the app shell needs from every game. */
export interface GameController {
  readonly id: GameId;
  readonly active: boolean;
  /** Label for the pause menu's restart action. */
  readonly restartLabel: string;
  /** Load the saved game; false when there's nothing to continue. */
  resume(): boolean;
  pause(): void;
  unpause(): void;
  /** Settings changed. */
  refresh(): void;
  hint(): void;
  undo(): void;
  restart(): void;
  /** "Play again" after a finished game. */
  again(): void;
  previewWin(): void;
  /** One line describing the game in progress, for menus. */
  status(): string;
  /** Game-specific keyboard shortcuts; return true if handled. */
  key(e: KeyboardEvent): boolean;
  /** Show or hide this game's layer on the table. */
  setVisible(on: boolean): void;
}

/** Pause before a new game's opening deal, so it starts once the screen has slid in. */
export const INTRO_MS = 850;

export function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export const store = {
  get<T>(key: string): T | null {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or unavailable */
    }
  },
};
