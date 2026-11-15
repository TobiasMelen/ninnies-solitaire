import './style.css';
import { SpiderGame } from './games/spider/SpiderGame';
import type { SuitCount } from './games/spider/rules';
import { canVibrate, unlockAudio } from './ui/feedback';
import { BACKS, DECKS, TABLES, type Settings, onSettings, updateSettings } from './ui/settings';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const board = $('#board');
const toastEl = $('#toast');
const dlgNew = $<HTMLDialogElement>('#dlg-new');
const dlgSettings = $<HTMLDialogElement>('#dlg-settings');
const dlgWin = $<HTMLDialogElement>('#dlg-win');
const dlgStuck = $<HTMLDialogElement>('#dlg-stuck');

const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
};

let toastTimer = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function open(d: HTMLDialogElement) {
  if (!d.open) d.showModal();
}

// Tapping the dimmed backdrop closes a sheet.
for (const d of [dlgNew, dlgSettings, dlgWin, dlgStuck]) {
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close('close');
  });
}

const game = new SpiderGame(board, {
  hud(h) {
    $('#stat-score').textContent = String(h.score);
    $('#stat-moves').textContent = String(h.moves);
    $('#stat-time').textContent = fmtTime(h.ms);
    $<HTMLButtonElement>('#btn-undo').disabled = !h.canUndo;
  },
  toast,
  won(r) {
    const s = r.suitCount;
    $('#win-line').textContent =
      `${s} suit${s > 1 ? 's' : ''} · ${r.moves} moves · ${fmtTime(r.ms)}${r.best ? ' · new best time!' : ''}`;
    $('#win-stats').innerHTML = `
      <div><b>${r.score}</b><small>Score</small></div>
      <div><b>${r.stats.won[s]}/${r.stats.played[s]}</b><small>Won</small></div>
      <div><b>${r.stats.bestMs[s] ? fmtTime(r.stats.bestMs[s]!) : '–'}</b><small>Best</small></div>`;
    window.setTimeout(() => open(dlgWin), 2600);
  },
  stuck() {
    open(dlgStuck);
  },
});

// ───────── toolbar ─────────

$('#btn-undo').addEventListener('click', () => game.undo());
$('#btn-hint').addEventListener('click', () => game.hint());
$('#btn-settings').addEventListener('click', () => open(dlgSettings));
$('#btn-new').addEventListener('click', () => {
  dlgNew.querySelectorAll<HTMLElement>('[data-suits]').forEach((b) =>
    b.classList.toggle('current', Number(b.dataset.suits) === game.suitCount),
  );
  open(dlgNew);
});
document.addEventListener('pointerdown', unlockAudio, { capture: true });

// iOS Safari ignores user-scalable=no; block pinch and double-tap zoom explicitly.
for (const type of ['gesturestart', 'gesturechange', 'dblclick']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}


dlgNew.querySelectorAll<HTMLElement>('[data-suits]').forEach((btn) =>
  btn.addEventListener('click', () => {
    dlgNew.close();
    game.newGame(Number(btn.dataset.suits) as SuitCount);
  }),
);
$('#btn-restart').addEventListener('click', () => {
  dlgNew.close();
  game.restart();
});

dlgWin.addEventListener('close', () => {
  if (dlgWin.returnValue === 'new') game.newGame(game.suitCount);
});
dlgStuck.addEventListener('close', () => {
  if (dlgStuck.returnValue === 'undo') game.undo();
  if (dlgStuck.returnValue === 'new') $('#btn-new').click();
});

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    game.undo();
  } else if (!e.metaKey && !e.ctrlKey) {
    if (e.key === 'h') game.hint();
    if (e.key === 'd' || e.key === ' ') game.deal();
    if (e.key === 'n') $('#btn-new').click();
  }
});

// ───────── settings sheet ─────────

function swatches<K extends 'deck' | 'back' | 'table'>(
  key: K,
  list: readonly { id: Settings[K]; label: string }[],
  preview: (id: string) => string,
) {
  const root = $(`#opt-${key}`);
  root.innerHTML = list
    .map(
      (o) => `<button type="button" class="swatch" data-v="${o.id}" aria-label="${o.label}">
        ${preview(o.id)}<span>${o.label}</span></button>`,
    )
    .join('');
  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.swatch');
    if (btn) updateSettings({ [key]: btn.dataset.v } as Partial<Settings>);
  });
}

swatches(
  'deck',
  DECKS,
  (id) => `<span class="mini-deck" data-deck="${id}">
    <span class="mini-card" data-suit="S"><b>A</b><i>♠&#xFE0E;</i></span>
    <span class="mini-card" data-suit="H"><b>K</b><i>♥&#xFE0E;</i></span>
    <span class="mini-card" data-suit="D"><b>7</b><i>♦&#xFE0E;</i></span>
    <span class="mini-card" data-suit="C"><b>Q</b><i>♣&#xFE0E;</i></span></span>`,
);
swatches('back', BACKS, (id) => `<span class="mini-back" data-back="${id}"></span>`);
swatches('table', TABLES, (id) => `<span class="mini-table" data-table="${id}"></span>`);

const TOGGLES: { key: keyof Settings; label: string; hint: string; show?: () => boolean }[] = [
  { key: 'noMovesAlert', label: 'Tell me when no moves are left', hint: 'Points to the stock, or offers undo when the game is stuck' },
  { key: 'tapToMove', label: 'Tap to move', hint: 'Tap a card to send it to the best spot' },
  { key: 'showTargets', label: 'Show where cards can go', hint: 'Highlights legal drop spots while dragging' },
  { key: 'sound', label: 'Sound', hint: '' },
  { key: 'haptics', label: 'Vibration', hint: '', show: canVibrate },
];

$('#opt-toggles').innerHTML = TOGGLES.filter((t) => !t.show || t.show())
  .map(
    (t) => `<label class="toggle">
      <span><b>${t.label}</b>${t.hint ? `<small>${t.hint}</small>` : ''}</span>
      <input type="checkbox" role="switch" data-k="${t.key}" />
    </label>`,
  )
  .join('');
$('#opt-toggles').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  updateSettings({ [input.dataset.k!]: input.checked } as Partial<Settings>);
});

const TABLE_COLOR: Record<string, string> = {
  felt: '#0c3b26',
  ocean: '#0b2c46',
  wine: '#3a0d17',
  midnight: '#0f1218',
  linen: '#b9a77e',
};

onSettings((s) => {
  document.body.dataset.table = s.table;
  board.dataset.deck = s.deck;
  board.dataset.back = s.back;
  document.querySelector('meta[name=theme-color]')!.setAttribute('content', TABLE_COLOR[s.table]);
  for (const key of ['deck', 'back', 'table'] as const) {
    $(`#opt-${key}`)
      .querySelectorAll<HTMLElement>('.swatch')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === s[key])));
  }
  $('#opt-toggles')
    .querySelectorAll<HTMLInputElement>('input')
    .forEach((i) => (i.checked = Boolean(s[i.dataset.k as keyof Settings])));
});
onSettings(() => game.refresh());

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
