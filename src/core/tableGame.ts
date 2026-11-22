import { type Key, t } from '../i18n';
import { type Cascade, type CascadeCard, runCascade } from '../ui/cascade';
import { sfx } from '../ui/feedback';
import type { GameController, GameHooks, GameId } from './game';
import { store } from './game';

/**
 * Shared plumbing for the turn-based table games (Hearts, Spite & Malice): saving, pausing,
 * named timers that can't strand the game, and the win cascade.
 *
 * Flow rule: a game advances by `step()`, which looks at the state and schedules what happens
 * next. Every delay goes through `after(name, …)`; scheduling a name again replaces it, so a
 * restarted `step()` can never cancel an unrelated pending moment (like a trick being swept).
 * Pausing cancels everything and calls `settle()`, which must finish any in-between moment at
 * once, so `step()` can always continue from the state alone.
 */
export abstract class TableGame<S> implements GameController {
  abstract readonly id: GameId;
  abstract readonly restartLabel: Key;

  protected state!: S;
  protected paused = true;
  protected cascade: Cascade | null = null;
  private timers = new Map<string, number>();
  /** Board size the layout was last made for. */
  private sized = '';

  constructor(
    protected root: HTMLElement,
    protected hooks: GameHooks,
    private saveKey: string,
  ) {
    // The observer also reports the first size a frame after a new game has started animating;
    // only a real size change may re-lay out (which snaps cards into place).
    new ResizeObserver(() => {
      if (this.sizeKey() === this.sized) return;
      this.sized = this.sizeKey();
      this.relayout();
    }).observe(root);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.save();
    });
  }

  // Game-specific controller parts.
  abstract refresh(): void;
  abstract hint(): void;
  abstract undo(): void;
  abstract restart(): void;
  abstract again(): void;
  abstract status(): string;
  abstract key(e: KeyboardEvent): boolean;

  /** Decide what happens next from the current state. */
  protected abstract step(): void;
  protected abstract emitHud(): void;
  protected abstract relayout(): void;
  protected abstract render(animate?: boolean): void;
  /** Cards for the win cascade, with where they are now. */
  protected abstract cascadeCards(): CascadeCard[];
  protected abstract cardSize(): { cw: number; ch: number };
  /** Court-card set the cascade should draw with. */
  protected cascadeCourts(): string {
    return 'letters';
  }
  /** Finish any in-between moment now (see the class comment). */
  protected settle(): void {}
  /** Saves that are finished (won, lost) shouldn't be offered as "Continue". */
  protected abstract isFinished(s: S): boolean;

  get active() {
    return Boolean(this.state);
  }

  // ───────── timers ─────────

  protected after(name: string, ms: number, fn: () => void) {
    this.cancel(name);
    this.timers.set(
      name,
      window.setTimeout(() => {
        this.timers.delete(name);
        fn();
      }, ms),
    );
  }

  protected cancel(name: string) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
  }

  protected pending(name: string) {
    return this.timers.has(name);
  }

  protected cancelAll() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
  }

  // ───────── lifecycle ─────────

  pause() {
    this.paused = true;
    this.cancelAll();
    if (this.state) this.settle();
    this.save();
  }

  unpause() {
    this.paused = false;
    this.emitHud();
    this.step();
  }

  private sizeKey() {
    return `${this.root.clientWidth}x${this.root.clientHeight}`;
  }

  setVisible(on: boolean) {
    this.root.hidden = !on;
    if (on) {
      this.sized = this.sizeKey();
      this.relayout();
    } else {
      this.root.parentElement?.style.removeProperty('--bunny-lift');
    }
  }

  resume(): boolean {
    const s = store.get<S>(this.saveKey);
    if (!s || this.isFinished(s)) return false;
    this.state = s;
    this.onResume();
    this.relayout();
    return true;
  }

  /** Reset per-session UI after loading a save. */
  protected onResume(): void {}

  protected save() {
    if (this.state) store.set(this.saveKey, this.state);
  }

  protected clearSave() {
    store.set(this.saveKey, null);
  }

  // ───────── win cascade ─────────

  protected celebrate(onDone: () => void) {
    this.stopCascade();
    this.cascade = runCascade(this.root, this.cascadeCards(), this.cardSize(), this.cascadeCourts(), onDone);
  }

  protected stopCascade() {
    this.cascade?.clear();
    this.cascade = null;
  }

  /** Settings → Preview win animation: play the cascade, then any tap returns to the game. */
  previewWin() {
    if (!this.state || this.cascade) return;
    this.pause();
    sfx.win();
    this.hooks.event?.('win');
    this.celebrate(() => {
      this.hooks.toast(t('tapToReturn'));
      this.root.addEventListener(
        'pointerdown',
        () => {
          this.stopCascade();
          this.render(false);
          this.unpause();
        },
        { once: true, capture: true },
      );
    });
  }
}
