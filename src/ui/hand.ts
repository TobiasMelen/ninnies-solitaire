import type { CardLayer } from './cardLayer';
import { haptic, sfx } from './feedback';

/**
 * The player's hand in the turn-based table games (Hearts, Spite & Malice): laid out as a fan,
 * like cards held in a hand, and played by tapping or by dragging a card onto a drop target.
 */

export interface FanSpot {
  x: number;
  y: number;
  /** Tilt in degrees. */
  rotate: number;
}

/**
 * A gentle arc, tilted outward, centred in the strip from `left` across `width` with the cards'
 * tops at `y`. Large hands overlap more and tilt and curve less, so the ends stay in view.
 */
export function fanHand(n: number, area: { left: number; width: number; y: number }, cw: number, ch: number): FanSpot[] {
  const step = n > 1 ? Math.min(cw * 0.82, (area.width - cw) / (n - 1)) : 0;
  const x0 = area.left + (area.width - (cw + step * (n - 1))) / 2;
  const half = (n - 1) / 2;
  // Five cards: 5° apart and the ends 0.14 card heights lower; more cards keep within those.
  const tilt = half > 2 ? 10 / half : 5;
  const arc = half > 2 ? 0.14 / (half * half) : 0.035;
  return Array.from({ length: n }, (_, i) => {
    const off = i - half;
    return { x: x0 + i * step, y: area.y + off * off * ch * arc, rotate: off * tilt };
  });
}

interface DragOptions<Src, Target> {
  cardSize(): { cw: number; ch: number };
  /** Where `src` may be dropped: the elements to aim at and what each one means. */
  targets(src: Src): { el: HTMLElement; target: Target }[];
  /** The pointer went down and up without moving: a tap. */
  tap(src: Src, id: number): void;
  /** Dragging has begun (the card is lifted). */
  start?(src: Src): void;
  /** Released over a target, or anywhere else (null: put the card back). */
  drop(src: Src, target: Target | null): void;
}

/**
 * Turns a press on a card into a tap or a drag. While dragging, the card follows the finger and
 * the target under the card's centre lights up (generous hit areas, so it's easy on a phone).
 */
export class CardDrag<Src, Target> {
  private d: {
    pointerId: number;
    src: Src;
    id: number;
    startX: number;
    startY: number;
    base: { x: number; y: number };
    moved: boolean;
    targets: { el: HTMLElement; target: Target }[];
    over: { el: HTMLElement; target: Target } | null;
  } | null = null;

  constructor(
    private root: HTMLElement,
    private layer: CardLayer,
    private opts: DragOptions<Src, Target>,
  ) {
    root.addEventListener('pointermove', (e) => this.move(e));
    root.addEventListener('pointerup', (e) => this.up(e));
    root.addEventListener('pointercancel', () => this.cancel());
  }

  get active() {
    return this.d !== null;
  }

  /** Start tracking a press on card `id`; whether it's a tap or a drag is decided on move or release. */
  begin(e: PointerEvent, src: Src, id: number) {
    const pos = this.layer.pos(id) ?? { x: 0, y: 0 };
    this.d = { pointerId: e.pointerId, src, id, startX: e.clientX, startY: e.clientY, base: { x: pos.x, y: pos.y }, moved: false, targets: [], over: null };
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone; the tap still works without capture */
    }
  }

  /** Drop the drag without doing anything (the game re-renders to put the card back). */
  cancel() {
    const d = this.d;
    if (!d) return false;
    this.layer.els.get(d.id)?.classList.remove('dragging');
    d.targets.forEach((t) => t.el.classList.remove('hot'));
    this.d = null;
    return true;
  }

  private move(e: PointerEvent) {
    const d = this.d;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 8) return;
      d.moved = true;
      d.targets = this.opts.targets(d.src);
      this.opts.start?.(d.src);
      sfx.pick();
      haptic(5);
      this.layer.els.get(d.id)!.classList.add('dragging');
    }
    this.layer.drag(d.id, d.base.x + dx, d.base.y + dy, 3000);
    const { cw, ch } = this.opts.cardSize();
    const rect = this.root.getBoundingClientRect();
    const cx = rect.left + d.base.x + dx + cw / 2;
    const cy = rect.top + d.base.y + dy + ch / 2;
    const reach = cw * 0.35;
    d.over =
      d.targets.find(({ el }) => {
        const r = el.getBoundingClientRect();
        return cx > r.left - reach && cx < r.right + reach && cy > r.top - reach && cy < r.bottom + reach;
      }) ?? null;
    d.targets.forEach((t) => t.el.classList.toggle('hot', t === d.over));
  }

  private up(e: PointerEvent) {
    const d = this.d;
    if (!d || d.pointerId !== e.pointerId) return;
    this.cancel();
    if (d.moved) this.opts.drop(d.src, d.over?.target ?? null);
    else this.opts.tap(d.src, d.id);
  }
}
