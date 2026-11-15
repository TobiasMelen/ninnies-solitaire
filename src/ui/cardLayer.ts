import { type Card, SUIT_NAME, SUIT_SYMBOL, cardName, rankLabel } from '../core/cards';

const COURT_NAME: Record<number, string> = { 11: 'jack', 12: 'queen', 13: 'king' };

/** Figures are cut out of the vector originals: transparent WebP, no suit symbols (see public/courts). */
export const courtUrl = (set: string, name: string) => `courts/${set}/${name}.webp`;

export const courtName = (card: Card) => `${COURT_NAME[card.rank]}_${SUIT_NAME[card.suit]}`;

export interface Placement {
  x: number;
  y: number;
  z: number;
  faceUp: boolean;
  /** ms before this card starts moving */
  delay?: number;
  /** Draw smaller (e.g. opponents' hands); scales from the top-left corner. */
  scale?: number;
  /** Tilt in degrees around the card's centre (a fanned hand). */
  rotate?: number;
}

const MOVE_MS = 280;

/**
 * Owns one DOM element per card and moves them with CSS transforms. Rendering is
 * idempotent: hand it where every card should be and it animates the difference.
 */
export class CardLayer {
  readonly els = new Map<number, HTMLElement>();
  private last = new Map<number, Placement>();
  private zTimers = new Map<number, number>();
  /** Folder under public/courts with J/Q/K figures, or 'letters' for plain letters. */
  private courts = 'letters';

  /**
   * `numbered`: a custom deck with big numbers instead of suits (Spite and Malice), coloured in
   * bands of four, and wild ★ Star cards for anything flagged `star`.
   */
  constructor(
    private root: HTMLElement,
    private opts: { numbered?: boolean } = {},
  ) {}

  sync(card: Card & { star?: boolean }): HTMLElement {
    let el = this.els.get(card.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'card';
      el.dataset.id = String(card.id);
      el.innerHTML = '<div class="card-inner"><div class="face front"></div><div class="face back"></div></div>';
      this.root.appendChild(el);
      this.els.set(card.id, el);
    }
    if (this.opts.numbered) return this.syncNumbered(el, card);
    const key = `${card.suit}${card.rank}`;
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.dataset.suit = card.suit;
      const suit = SUIT_SYMBOL[card.suit];
      const rank = rankLabel(card.rank);
      const face = card.rank > 10 ? `<span class="court"><span class="fig"></span><b>${rank}</b></span>` : '';
      el.querySelector('.front')!.innerHTML =
        `<span class="idx"><b>${rank}</b><i>${suit}</i></span>${face}<span class="pip">${suit}</span>`;
      el.dataset.fig = card.rank > 10 ? courtName(card) : '';
      this.applyFigure(el);
    }
    el.setAttribute('aria-label', card.faceUp ? cardName(card) : 'Face-down card');
    return el;
  }

  private syncNumbered(el: HTMLElement, card: Card & { star?: boolean }) {
    const key = card.star ? 'star' : String(card.rank);
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.classList.add('numbered');
      el.dataset.band = card.star ? 'star' : card.rank <= 4 ? 'low' : card.rank <= 8 ? 'mid' : 'high';
      const n = card.star ? '★' : String(card.rank);
      el.querySelector('.front')!.innerHTML =
        `<span class="n-corner">${n}</span><span class="n-big">${n}</span><span class="n-corner n-flip">${n}</span>`;
    }
    el.setAttribute('aria-label', card.faceUp ? (card.star ? 'Star (wild)' : String(card.rank)) : 'Face-down card');
    return el;
  }

  setCourts(set: string) {
    if (set === this.courts) return;
    this.courts = set;
    this.root.dataset.courts = set;
    this.els.forEach((el) => this.applyFigure(el));
  }

  private applyFigure(el: HTMLElement) {
    const fig = el.querySelector<HTMLElement>('.fig');
    if (!fig) return;
    // Images live in public/, so they load lazily and only for the chosen set.
    fig.style.backgroundImage = this.courts === 'letters' ? '' : `url(${courtUrl(this.courts, el.dataset.fig!)})`;
  }

  place(id: number, p: Placement, animate: boolean) {
    const el = this.els.get(id)!;
    const prev = this.last.get(id);
    const moved = !prev || prev.x !== p.x || prev.y !== p.y;
    const delay = p.delay ?? 0;

    el.style.setProperty('--d', animate ? `${delay}ms` : '0ms');
    el.classList.toggle('no-anim', !animate);
    const tilt = p.rotate
      ? ` translate(calc(var(--cw) / 2), calc(var(--ch) / 2)) rotate(${p.rotate}deg) translate(calc(var(--cw) / -2), calc(var(--ch) / -2))`
      : '';
    el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)${p.scale && p.scale !== 1 ? ` scale(${p.scale})` : ''}${tilt}`;
    el.classList.toggle('up', p.faceUp);

    // While travelling a card must stay above everything it passes over.
    clearTimeout(this.zTimers.get(id));
    if (animate && moved && prev) {
      el.style.zIndex = String(1000 + p.z);
      this.zTimers.set(
        id,
        window.setTimeout(() => (el.style.zIndex = String(p.z)), delay + MOVE_MS + 40),
      );
    } else {
      el.style.zIndex = String(p.z);
    }
    this.last.set(id, p);
  }

  /** Position during a drag: follows the finger with no transition. */
  drag(id: number, x: number, y: number, z: number) {
    const el = this.els.get(id)!;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    el.style.zIndex = String(z);
  }

  pos(id: number) {
    return this.last.get(id);
  }

  wiggle(ids: number[]) {
    for (const id of ids) {
      const el = this.els.get(id);
      if (!el) continue;
      el.classList.remove('wiggle');
      void el.offsetWidth; // restart the animation
      el.classList.add('wiggle');
    }
  }
}
