import { type Card, SUIT_NAME, SUIT_SYMBOL, cardName, rankLabel } from '../core/cards';

const COURT_NAME: Record<number, string> = { 11: 'jack', 12: 'queen', 13: 'king' };

export interface Placement {
  x: number;
  y: number;
  z: number;
  faceUp: boolean;
  /** ms before this card starts moving */
  delay?: number;
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

  constructor(private root: HTMLElement) {}

  sync(card: Card): HTMLElement {
    let el = this.els.get(card.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'card';
      el.dataset.id = String(card.id);
      el.innerHTML = '<div class="card-inner"><div class="face front"></div><div class="face back"></div></div>';
      this.root.appendChild(el);
      this.els.set(card.id, el);
    }
    const key = `${card.suit}${card.rank}`;
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.dataset.suit = card.suit;
      const suit = SUIT_SYMBOL[card.suit];
      const rank = rankLabel(card.rank);
      const face = card.rank > 10 ? `<span class="court"><span class="fig"></span><b>${rank}</b></span>` : '';
      el.querySelector('.front')!.innerHTML =
        `<span class="idx"><b>${rank}</b><i>${suit}</i></span>${face}<span class="pip">${suit}</span>`;
      el.dataset.fig = card.rank > 10 ? `${COURT_NAME[card.rank]}_${SUIT_NAME[card.suit]}` : '';
      this.applyFigure(el);
    }
    el.setAttribute('aria-label', card.faceUp ? cardName(card) : 'Face-down card');
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
    fig.style.backgroundImage = this.courts === 'letters' ? '' : `url(courts/${this.courts}/${el.dataset.fig}.jpg)`;
  }

  place(id: number, p: Placement, animate: boolean) {
    const el = this.els.get(id)!;
    const prev = this.last.get(id);
    const moved = !prev || prev.x !== p.x || prev.y !== p.y;
    const delay = p.delay ?? 0;

    el.style.setProperty('--d', animate ? `${delay}ms` : '0ms');
    el.classList.toggle('no-anim', !animate);
    el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
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
