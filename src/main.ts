import './style.css';
import { type GameHooks, SpiderGame } from './games/spider/SpiderGame';
import type { SuitCount } from './games/spider/rules';
import { canVibrate, sfx, unlockAudio } from './ui/feedback';
import { BACKS, COURTS, DECKS, TABLES, type Settings, onSettings, updateSettings } from './ui/settings';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const board = $('#board');
const home = $('#home');
const toastEl = $('#toast');
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
for (const d of [dlgSettings, dlgWin, dlgStuck]) {
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close('close');
  });
}

// iOS only lets audio start from certain gestures, so try on every kind of tap.
for (const type of ['pointerdown', 'touchend', 'click', 'keydown']) {
  document.addEventListener(type, unlockAudio, { capture: true });
}

// iOS Safari ignores user-scalable=no; block pinch and double-tap zoom explicitly.
for (const type of ['gesturestart', 'gesturechange', 'dblclick']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// ───────── game ─────────

const hooks: GameHooks = {
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
      <div><b>${r.stats.bestMs[s] !== undefined ? fmtTime(r.stats.bestMs[s]!) : '–'}</b><small>Best</small></div>`;
    open(dlgWin);
  },
  stuck() {
    open(dlgStuck);
  },
};

// Created on first play so the table stays empty behind the start screen.
let game: SpiderGame | null = null;
const ensureGame = () => (game ??= new SpiderGame(board, hooks));
// Dev-only handle for poking at the game from the console (stripped from production builds).
if (import.meta.env.DEV) Object.assign(window, { ninnies: { get game() { return ensureGame(); } } });

// ───────── start screen ─────────

const homeOpen = () => !home.classList.contains('hidden');

function showHome() {
  game?.pause();
  const saved = SpiderGame.saved();
  $('#home-resume').hidden = !saved;
  if (saved) {
    $('#home-continue-sub').textContent =
      `Spider · ${saved.suitCount} suit${saved.suitCount > 1 ? 's' : ''} · ${saved.moves} moves · ${fmtTime(saved.ms)}`;
  }
  const last = saved?.suitCount ?? (game?.active ? game.suitCount : null);
  home.querySelectorAll<HTMLElement>('[data-suits]').forEach((b) =>
    b.classList.toggle('current', Number(b.dataset.suits) === last),
  );
  home.classList.remove('hidden');
  home.scrollTop = 0;
}

function hideHome() {
  home.classList.add('hidden');
}

/** Bring the saved game onto the table if it isn't there already. */
function loadSaved(): boolean {
  const g = ensureGame();
  return g.active || g.resume();
}

$('#home-continue').addEventListener('click', () => {
  if (!loadSaved()) return showHome();
  hideHome();
  game!.unpause();
});
$('#home-restart').addEventListener('click', () => {
  if (!loadSaved()) return showHome();
  hideHome();
  game!.restart();
  game!.unpause();
});
home.querySelectorAll<HTMLElement>('[data-suits]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const g = ensureGame();
    hideHome();
    g.newGame(Number(btn.dataset.suits) as SuitCount);
    g.unpause();
  }),
);
$('#home-settings').addEventListener('click', () => open(dlgSettings));

$('#btn-preview-win').addEventListener('click', () => {
  dlgSettings.close();
  // Needs cards on the table: use the current game, the saved one, or a fresh deal.
  if (homeOpen()) {
    if (!loadSaved()) ensureGame().newGame(2);
    hideHome();
  }
  window.setTimeout(() => game?.previewWin(), 250);
});

// Temporary: an installed home-screen app has no reload button, so offer one that also
// drops the offline cache to guarantee the newest deploy is fetched.
$('#build-id').textContent = `Build ${__BUILD_ID__}`;
$('#home-reload').addEventListener('click', async () => {
  game?.pause();
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = (await window.caches?.keys()) ?? [];
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* reload anyway */
  }
  location.reload();
});

// ───────── toolbar ─────────

$('#btn-undo').addEventListener('click', () => game?.undo());
$('#btn-hint').addEventListener('click', () => game?.hint());
$('#btn-settings').addEventListener('click', () => open(dlgSettings));
$('#btn-home').addEventListener('click', showHome);

dlgWin.addEventListener('close', () => {
  if (dlgWin.returnValue === 'new' && game) game.newGame(game.suitCount);
  if (dlgWin.returnValue === 'home') showHome();
});
dlgStuck.addEventListener('close', () => {
  if (dlgStuck.returnValue === 'undo') game?.undo();
  if (dlgStuck.returnValue === 'new') showHome();
});

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || homeOpen() || !game) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    game.undo();
  } else if (!e.metaKey && !e.ctrlKey) {
    if (e.key === 'h') game.hint();
    if (e.key === 'd' || e.key === ' ') game.deal();
    if (e.key === 'n' || e.key === 'Escape') showHome();
  }
});

showHome();

// ───────── settings sheet ─────────

function swatches<K extends 'deck' | 'back' | 'table' | 'courts'>(
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
swatches('courts', COURTS, (id) =>
  id === 'letters'
    ? `<span class="mini-court letters">K</span>`
    : `<span class="mini-court" style="background-image:url(courts/${id}/king_hearts.jpg)"></span>`,
);
swatches('back', BACKS, (id) => `<span class="mini-back" data-back="${id}"></span>`);
swatches('table', TABLES, (id) => `<span class="mini-table" data-table="${id}"></span>`);

const TOGGLES: { key: keyof Settings; label: string; hint: string; show?: () => boolean; needs?: keyof Settings }[] = [
  { key: 'noMovesAlert', label: 'Tell me when I’m stuck', hint: 'Only when nothing can be moved or dealt; use Hint otherwise' },
  { key: 'tapToMove', label: 'Tap to move', hint: 'Double-tap a card to send it to the best spot' },
  { key: 'singleTap', label: 'Single tap is enough', hint: 'Move with one tap instead of two', needs: 'tapToMove' },
  { key: 'dimLocked', label: 'Shade cards that can’t move', hint: 'Only the movable run in each column stays bright white' },
  { key: 'dealWithEmpty', label: 'Deal with empty columns', hint: 'Off follows the classic rule: fill every column before dealing' },
  { key: 'showTargets', label: 'Show where cards can go', hint: 'Highlights legal drop spots while dragging' },
  { key: 'sound', label: 'Sound', hint: '' },
  { key: 'haptics', label: 'Vibration', hint: '', show: canVibrate },
];

$('#opt-toggles').innerHTML = TOGGLES.filter((t) => !t.show || t.show())
  .map(
    (t) => `<label class="toggle${t.needs ? ' sub' : ''}" ${t.needs ? `data-needs="${t.needs}"` : ''}>
      <span><b>${t.label}</b>${t.hint ? `<small>${t.hint}</small>` : ''}</span>
      <input type="checkbox" role="switch" data-k="${t.key}" />
    </label>`,
  )
  .join('');
$('#opt-toggles').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  updateSettings({ [input.dataset.k!]: input.checked } as Partial<Settings>);
  // Audible confirmation that sound works (this runs inside the tap, so iOS allows it).
  if (input.dataset.k === 'sound' && input.checked) sfx.move();
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
  $('#spider-art').dataset.deck = s.deck;
  document.querySelector('meta[name=theme-color]')!.setAttribute('content', TABLE_COLOR[s.table]);
  for (const key of ['deck', 'back', 'table', 'courts'] as const) {
    $(`#opt-${key}`)
      .querySelectorAll<HTMLElement>('.swatch')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === s[key])));
  }
  $('#opt-toggles')
    .querySelectorAll<HTMLInputElement>('input')
    .forEach((i) => (i.checked = Boolean(s[i.dataset.k as keyof Settings])));
  // Sub-options only apply while their parent switch is on.
  $('#opt-toggles')
    .querySelectorAll<HTMLElement>('[data-needs]')
    .forEach((row) => {
      const on = Boolean(s[row.dataset.needs as keyof Settings]);
      row.classList.toggle('disabled', !on);
      row.querySelector('input')!.disabled = !on;
    });
});
onSettings(() => game?.refresh());

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
