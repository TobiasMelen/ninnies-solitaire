import { type Card, SUIT_SYMBOL, rankLabel } from '../core/cards';
import { courtName, courtUrl } from './cardLayer';

/**
 * The classic Windows win animation: cards leave the foundations one by one, bounce along
 * the bottom of the table and leave a trail, because the canvas is never cleared.
 */

export interface CascadeCard {
  card: Card;
  x: number;
  y: number;
}

export interface Cascade {
  /** Player tapped: end early, unless it only just started (the winning tap shouldn't skip it). */
  skip(): void;
  /** Remove the canvas entirely. */
  clear(): void;
  readonly running: boolean;
}

const LAUNCH_MS = 140;
const MAX_MS = 24000;
const SKIP_AFTER_MS = 1500;

export function runCascade(
  board: HTMLElement,
  cards: CascadeCard[],
  size: { cw: number; ch: number },
  courts: string,
  onDone: () => void,
): Cascade {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = board.clientWidth;
  const H = board.clientHeight;
  const canvas = document.createElement('canvas');
  canvas.className = 'cascade';
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  board.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const { cw, ch } = size;
  const sprites = new Map<number, HTMLCanvasElement>();
  const sprite = (card: Card) => {
    let s = sprites.get(card.id);
    if (!s) {
      s = drawCard(board, card, cw, ch, dpr, courts);
      sprites.set(card.id, s);
    }
    return s;
  };
  // Warm the court images so they're decoded before their card flies.
  if (courts !== 'letters') {
    for (const { card } of cards) {
      if (card.rank > 10) figure(courts, card);
    }
  }

  const scale = ch / 90;
  const floor = H - ch;
  const bodies = cards.map(({ card, x, y }, i) => ({
    card,
    x,
    y,
    vx: (Math.random() < 0.5 ? -1 : 1) * (2.5 + Math.random() * 3.5) * scale,
    vy: -(2 + Math.random() * 8) * scale,
    at: i * LAUNCH_MS,
    live: false,
    done: false,
  }));
  const g = 0.55 * scale;

  let raf = 0;
  let running = true;
  const t0 = performance.now();
  let prev = t0;

  const finish = () => {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
    onDone();
  };

  const frame = (now: number) => {
    const dt = Math.min(2.5, (now - prev) / 16.7);
    prev = now;
    let remaining = 0;
    for (const b of bodies) {
      if (b.done) continue;
      remaining++;
      if (now - t0 < b.at) continue;
      if (!b.live) {
        b.live = true;
        hideCard(board, b.card.id);
      }
      b.vy += g * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.y > floor) {
        b.y = floor;
        b.vy *= -0.78;
      }
      ctx.drawImage(sprite(b.card), b.x, b.y, cw, ch);
      if (b.x < -cw || b.x > W) b.done = true;
    }
    if (remaining && now - t0 < MAX_MS) raf = requestAnimationFrame(frame);
    else finish();
  };
  raf = requestAnimationFrame(frame);

  return {
    skip() {
      if (performance.now() - t0 < SKIP_AFTER_MS) return;
      // Everything still waiting simply leaves the table.
      for (const b of bodies) hideCard(board, b.card.id);
      finish();
    },
    clear() {
      running = false;
      cancelAnimationFrame(raf);
      canvas.remove();
      for (const b of bodies) board.querySelector<HTMLElement>(`.card[data-id="${b.card.id}"]`)?.classList.remove('gone');
    },
    get running() {
      return running;
    },
  };
}

function hideCard(board: HTMLElement, id: number) {
  board.querySelector<HTMLElement>(`.card[data-id="${id}"]`)?.classList.add('gone');
}

const figures = new Map<string, HTMLImageElement>();
function figure(courts: string, card: Card) {
  const src = courtUrl(courts, courtName(card));
  let img = figures.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    figures.set(src, img);
  }
  return img;
}

/** Paint a card face in the current deck style, read from the board's CSS variables. */
function drawCard(board: HTMLElement, card: Card, cw: number, ch: number, dpr: number, courts: string) {
  const css = getComputedStyle(board);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const c = document.createElement('canvas');
  c.width = Math.round(cw * dpr);
  c.height = Math.round(ch * dpr);
  const x = c.getContext('2d')!;
  x.scale(dpr, dpr);

  const r = cw * 0.09;
  x.beginPath();
  x.roundRect(0.5, 0.5, cw - 1, ch - 1, r);
  x.fillStyle = v('--face', '#fdfcf8');
  x.fill();
  x.strokeStyle = 'rgba(0,0,0,0.3)';
  x.lineWidth = 1;
  x.stroke();

  const ink = v(`--c-${card.suit}`, card.suit === 'H' || card.suit === 'D' ? '#c4122f' : '#1b1c21');
  const font = v('--idx-font', 'Georgia, serif');
  const weight = v('--idx-weight', '700');
  const size = cw * (parseFloat(v('--idx-size', '0.39')) || 0.39);
  const suit = SUIT_SYMBOL[card.suit];
  x.fillStyle = ink;
  x.textBaseline = 'top';
  x.font = `${weight} ${size}px ${font}`;
  x.fillText(rankLabel(card.rank), cw * 0.07, cw * 0.05);
  x.font = `${size * 0.8}px ${font}`;
  x.textAlign = 'right';
  x.fillText(suit, cw * 0.95, cw * 0.07);

  const img = card.rank > 10 && courts !== 'letters' ? figure(courts, card) : null;
  if (img && img.complete && img.naturalWidth) {
    const fx = cw * 0.08;
    const fy = ch * 0.32;
    const fw = cw * 0.84;
    const fh = ch * 0.63;
    // Same crop as the CSS: fit the width, anchored at the top.
    const s = fw / img.naturalWidth;
    x.save();
    x.beginPath();
    x.roundRect(fx, fy, fw, fh, cw * 0.06);
    x.clip();
    x.drawImage(img, fx + (fw - img.naturalWidth * s) / 2, fy, img.naturalWidth * s, img.naturalHeight * s);
    x.restore();
  } else {
    x.textAlign = 'center';
    x.textBaseline = 'alphabetic';
    x.font = card.rank > 10 ? `${weight} ${cw * 0.52}px ${font}` : `${cw * 0.72}px ${font}`;
    x.fillText(card.rank > 10 ? rankLabel(card.rank) : suit, cw / 2, ch * 0.9);
  }
  return c;
}
