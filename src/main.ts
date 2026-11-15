import './style.css';
import { type GameHooks, SpiderGame } from './games/spider/SpiderGame';
import type { SuitCount } from './games/spider/rules';
import { courtUrl } from './ui/cardLayer';
import { Bunny } from './ui/bunny';
import { audioLatency, canVibrate, sfx, unlockAudio } from './ui/feedback';
import { BACKS, COURTS, DECKS, TABLES, type Settings, onSettings, updateSettings } from './ui/settings';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const board = $('#board');
const home = $('#home');
const toastEl = $('#toast');
const dlgSettings = $<HTMLDialogElement>('#dlg-settings');
const dlgWin = $<HTMLDialogElement>('#dlg-win');
const dlgStuck = $<HTMLDialogElement>('#dlg-stuck');
const dlgMenu = $<HTMLDialogElement>('#dlg-menu');

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
for (const d of [dlgSettings, dlgWin, dlgStuck, dlgMenu]) {
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close('close');
  });
}

// Installed on iOS (standalone), the reported viewport can be short by the status bar's
// height, which leaves the toolbar floating above the bottom of the screen. Fill the real screen.
const standalone =
  matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
function fitStandalone() {
  if (!standalone) return;
  const app = $('#app');
  const portrait = innerHeight >= innerWidth;
  const full = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  if (full > innerHeight + 1) {
    app.style.bottom = 'auto';
    app.style.height = `${full}px`;
  } else {
    app.style.bottom = '';
    app.style.height = '';
  }
}
fitStandalone();
addEventListener('resize', fitStandalone);

// Temporary: layout numbers for debugging the installed app (shown on the start screen).
function layoutDiag() {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const safe = [cs.paddingTop, cs.paddingBottom].map((v) => parseInt(v)).join('/');
  probe.remove();
  const app = $('#app').getBoundingClientRect();
  const bar = $('#toolbar').getBoundingClientRect();
  const vv = window.visualViewport;
  const el = $('#layout-diag');
  el.hidden = !standalone && !location.search.includes('diag');
  el.textContent = [
    standalone ? 'standalone' : 'browser',
    `inner ${innerWidth}×${innerHeight}`,
    `screen ${screen.width}×${screen.height}`,
    vv ? `vv ${Math.round(vv.width)}×${Math.round(vv.height)}+${Math.round(vv.offsetTop)}` : 'vv –',
    `app ${Math.round(app.top)}→${Math.round(app.bottom)}`,
    `bar ${Math.round(bar.top)}→${Math.round(bar.bottom)}`,
    `safe t/b ${safe}`,
    `dpr ${devicePixelRatio}`,
    audioLatency(),
    navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 80),
  ].join(' · ');
}
addEventListener('resize', layoutDiag);
setTimeout(layoutDiag, 500);
addEventListener('orientationchange', () => setTimeout(fitStandalone, 300));

// iOS only lets audio start from certain gestures, so try on every kind of tap.
for (const type of ['pointerdown', 'touchend', 'click', 'keydown']) {
  document.addEventListener(type, unlockAudio, { capture: true });
}

// iOS Safari ignores user-scalable=no; block pinch and double-tap zoom explicitly.
for (const type of ['gesturestart', 'gesturechange', 'dblclick']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// ───────── game ─────────

const bunny = new Bunny(board);
// Tapping the Hint Bunny asks it for a hint.
bunny.onAskHint = () => game?.hint();

const hooks: GameHooks = {
  event: (e, x) => bunny.react(e, x),
  hint: (target, kind) => bunny.hint(target, kind),
  hud(h) {
    lastHud = h;
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
    bunny.react('stuck');
    open(dlgStuck);
  },
};

let lastHud: Parameters<GameHooks['hud']>[0] | null = null;

// Created on first play so the table stays empty behind the start screen.
let game: SpiderGame | null = null;
const ensureGame = () => (game ??= new SpiderGame(board, hooks));
// Dev-only handle for poking at the game from the console (stripped from production builds).
if (import.meta.env.DEV) Object.assign(window, { ninnies: { get game() { return ensureGame(); } } });

// ───────── start screen ─────────

const homeOpen = () => !home.classList.contains('hidden');

function showHome() {
  game?.pause();
  layoutDiag();
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

// ───────── pause menu ─────────

/** Settings opened from the pause menu return to it when closed. */
let settingsFromMenu = false;

function openMenu() {
  if (!game?.active) return;
  game.pause();
  if (lastHud) {
    const h = lastHud;
    $('#menu-line').textContent =
      `Spider · ${h.suitCount} suit${h.suitCount > 1 ? 's' : ''} · ${h.moves} moves · ${fmtTime(h.ms)}`;
  }
  open(dlgMenu);
}

$('#btn-menu').addEventListener('click', openMenu);
dlgMenu.addEventListener('close', () => {
  const v = dlgMenu.returnValue;
  dlgMenu.returnValue = '';
  if (v === 'home') return showHome();
  if (v === 'settings') {
    settingsFromMenu = true;
    return open(dlgSettings);
  }
  if (v === 'restart') game?.restart();
  game?.unpause();
});
dlgSettings.addEventListener('close', () => {
  if (settingsFromMenu) {
    settingsFromMenu = false;
    open(dlgMenu);
  }
});

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
    if (e.key === 'Escape' || e.key === 'm') openMenu();
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
    : `<span class="mini-court" style="background-image:url(${courtUrl(id, 'king_hearts')})"></span>`,
);
swatches('back', BACKS, (id) => `<span class="mini-back" data-back="${id}"></span>`);
swatches('table', TABLES, (id) => `<span class="mini-table" data-table="${id}"></span>`);

type Toggle = { key: keyof Settings; label: string; hint: string; group: 'play' | 'feel'; show?: () => boolean; needs?: keyof Settings };
const TOGGLES: Toggle[] = [
  { key: 'noMovesAlert', label: 'Tell me when I’m stuck', hint: 'Only when nothing can be moved or dealt; use Hint otherwise', group: 'play' },
  { key: 'tapToMove', label: 'Tap to move', hint: 'Double-tap a card to send it to the best spot', group: 'play' },
  { key: 'singleTap', label: 'Single tap is enough', hint: 'Move with one tap instead of two', group: 'play', needs: 'tapToMove' },
  { key: 'dimLocked', label: 'Shade cards that can’t move', hint: 'Only the movable run in each column stays bright white', group: 'play' },
  { key: 'dealWithEmpty', label: 'Deal with empty columns', hint: 'Off follows the classic rule: fill every column before dealing', group: 'play' },
  { key: 'showTargets', label: 'Show where cards can go', hint: 'Highlights legal drop spots while dragging', group: 'play' },
  { key: 'sound', label: 'Sound', hint: '', group: 'feel' },
  { key: 'haptics', label: 'Vibration', hint: '', group: 'feel', show: canVibrate },
  { key: 'bunny', label: 'Hint Bunny', hint: 'Cheers you on with gestures; tap it for a hint', group: 'feel' },
];

const toggleRoots = [$('#opt-play'), $('#opt-feel')];
for (const group of ['play', 'feel'] as const) {
  $(`#opt-${group}`).innerHTML = TOGGLES.filter((t) => t.group === group && (!t.show || t.show()))
  .map(
    (t) => `<label class="toggle${t.needs ? ' sub' : ''}" ${t.needs ? `data-needs="${t.needs}"` : ''}>
      <span><b>${t.label}</b>${t.hint ? `<small>${t.hint}</small>` : ''}</span>
      <input type="checkbox" role="switch" data-k="${t.key}" />
    </label>`,
  )
  .join('');
}
$('#dlg-settings').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (!input.dataset.k) return;
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
  document.documentElement.dataset.table = s.table;
  board.dataset.deck = s.deck;
  board.dataset.back = s.back;
  $('#spider-art').dataset.deck = s.deck;
  // Paint the page itself in the table colour too, so an installed app's status bar, safe areas
  // and overscroll match the felt instead of a fixed colour.
  const color = TABLE_COLOR[s.table];
  document.documentElement.style.backgroundColor = color;
  document.querySelector('meta[name=theme-color]')!.setAttribute('content', color);
  try {
    localStorage.setItem('ninnies.tableColor', color);
  } catch {
    /* ignore */
  }
  for (const key of ['deck', 'back', 'table', 'courts'] as const) {
    $(`#opt-${key}`)
      .querySelectorAll<HTMLElement>('.swatch')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === s[key])));
  }
  for (const root of toggleRoots) {
    root
      .querySelectorAll<HTMLInputElement>('input')
      .forEach((i) => (i.checked = Boolean(s[i.dataset.k as keyof Settings])));
  }
  // Sub-options only apply while their parent switch is on.
  $('#dlg-settings')
    .querySelectorAll<HTMLElement>('[data-needs]')
    .forEach((row) => {
      const on = Boolean(s[row.dataset.needs as keyof Settings]);
      row.classList.toggle('disabled', !on);
      row.querySelector('input')!.disabled = !on;
    });
});
onSettings(() => game?.refresh());
onSettings((s) => bunny.setEnabled(s.bunny));

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
