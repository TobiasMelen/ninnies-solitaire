import './style.css';
import { type GameHooks, type GameId, type Hud, type Result, fmtTime, store } from './core/game';
import { HeartsGame } from './games/hearts/HeartsGame';
import { SpiderGame } from './games/spider/SpiderGame';
import type { Level } from './games/spite/ai';
import { SpiteGame } from './games/spite/SpiteGame';
import { MinesGame } from './games/mines/MinesGame';
import type { MinesLevel } from './games/mines/rules';
import type { SuitCount } from './games/spider/rules';
import { courtUrl } from './ui/cardLayer';
import { Bunny } from './ui/bunny';
import { navigate } from './ui/nav';
import { audioLatency, canVibrate, sfx, unlockAudio } from './ui/feedback';
import { BACKS, COURTS, DECKS, TABLES, type Settings, onSettings, settings, updateSettings } from './ui/settings';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const board = $('#board');
const home = $('#home');
const toastEl = $('#toast');
const dlgSettings = $<HTMLDialogElement>('#dlg-settings');
const dlgWin = $<HTMLDialogElement>('#dlg-win');
const dlgStuck = $<HTMLDialogElement>('#dlg-stuck');
const dlgMenu = $<HTMLDialogElement>('#dlg-menu');
const dlgSetup = $<HTMLDialogElement>('#dlg-setup');


let toastTimer = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function open(d: HTMLDialogElement) {
  if (!d.open) go(() => d.showModal());
}

/** What happens when each dialog closes, by the button value it closed with. */
const onClose = new Map<HTMLDialogElement, (value: string) => void>();

/**
 * Close a dialog and run its handler right away. (The native close event fires a moment later,
 * which would land outside the screen transition.)
 */
function shut(d: HTMLDialogElement, value = 'close') {
  if (!d.open) return;
  d.close(value);
  onClose.get(d)?.(value);
}

function close(d: HTMLDialogElement, value = 'close') {
  if (d.open) go(() => shut(d, value));
}

// Tapping the dimmed backdrop closes a sheet.
for (const d of [dlgWin, dlgStuck, dlgMenu]) {
  d.addEventListener('click', (e) => {
    if (e.target === d) close(d);
  });
}
// Dialog buttons and Escape close through `go`, so closing animates too.
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('submit', (e) => {
    e.preventDefault();
    close(d, (e.submitter as HTMLButtonElement | null)?.value ?? 'close');
  });
  d.addEventListener('cancel', (e) => {
    e.preventDefault();
    close(d);
  });
}

// Installed as an app (standalone). Used only for the layout diagnostics below; an earlier
// attempt to resize the app to the full screen height clipped the toolbar on iOS.
const standalone =
  matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

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

// iOS only lets audio start from certain gestures, so try on every kind of tap.
for (const type of ['pointerdown', 'touchend', 'click', 'keydown']) {
  document.addEventListener(type, unlockAudio, { capture: true });
}

// Every menu button knocks like wood; switches click a little higher.
const UI_BUTTONS = '.btn, .suit-pick button, .continue, .home-gear, .icon-btn, .tool, .swatch, .link-btn, summary';
document.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest(UI_BUTTONS)) sfx.ui();
});
document.addEventListener('change', (e) => {
  if ((e.target as HTMLElement).matches('input[type=checkbox]')) sfx.ui(false);
});

// iOS Safari ignores user-scalable=no; block pinch and double-tap zoom explicitly.
for (const type of ['gesturestart', 'gesturechange', 'dblclick']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// ───────── games ─────────

type AnyGame = SpiderGame | HeartsGame | SpiteGame | MinesGame;
type GameOf<T extends GameId> = T extends 'spider'
  ? SpiderGame
  : T extends 'hearts'
    ? HeartsGame
    : T extends 'spite'
      ? SpiteGame
      : MinesGame;
const LAST_KEY = 'ninnies.lastGame';

const bunny = new Bunny(board);
// Tapping the Hint Bunny asks it for a hint.
bunny.onAskHint = () => game?.hint();

const games: Partial<Record<GameId, AnyGame>> = {};
let game: AnyGame | null = null;

function renderHud(h: Hud) {
  $('#stats').innerHTML = h.stats
    .map((s) => `<div class="${s.hot ? 'hot' : ''}"><b>${s.value}</b><small>${s.label}</small></div>`)
    .join('');
  const undo = $<HTMLButtonElement>('#btn-undo');
  undo.hidden = !h.hasUndo;
  undo.disabled = !h.canUndo;
}

function showResult(r: Result) {
  $('#win-title').textContent = r.title;
  $('#win-trophy').textContent = r.celebrate ? '🏆' : '🃏';
  $('#win-line').textContent = r.line;
  $('#win-stats').innerHTML = r.stats.map((s) => `<div><b>${s.value}</b><small>${s.label}</small></div>`).join('');
  open(dlgWin);
}

/** Each game only reaches the shell while it is the one on the table. */
function hooksFor(id: GameId): GameHooks {
  const mine = () => game?.id === id;
  return {
    event: (e, x) => mine() && bunny.react(e, x),
    hint: (target, kind) => mine() && bunny.hint(target, kind),
    hud: (h) => mine() && renderHud(h),
    toast: (m) => mine() && toast(m),
    finished: (r) => mine() && showResult(r),
    stuck() {
      if (!mine()) return;
      bunny.react('stuck');
      open(dlgStuck);
    },
  };
}

function getGame(id: GameId): AnyGame {
  let g = games[id];
  if (!g) {
    const layer = document.createElement('div');
    layer.className = 'game-root';
    board.prepend(layer);
    const hooks = hooksFor(id);
    g =
      id === 'spider'
        ? new SpiderGame(layer, hooks)
        : id === 'hearts'
          ? new HeartsGame(layer, hooks)
          : id === 'spite'
            ? new SpiteGame(layer, hooks)
            : new MinesGame(layer, hooks);
    games[id] = g;
  }
  return g;
}

/** Put a game on the table (creating it on first use) and hide the other. */
function switchTo<T extends GameId>(id: T): GameOf<T> {
  const g = getGame(id);
  if (game && game !== g) {
    game.pause();
    game.setVisible(false);
  }
  game = g;
  g.setVisible(true);
  store.set(LAST_KEY, id);
  return g as GameOf<T>;
}

const lastGame = (): GameId => store.get<GameId>(LAST_KEY) ?? 'spider';

// Dev-only handle for poking at the game from the console (stripped from production builds).
if (import.meta.env.DEV) Object.assign(window, { ninnies: { get game() { return game ?? switchTo('spider'); } } });

// ───────── start screen ─────────

const homeOpen = () => !home.classList.contains('hidden');

// ───────── navigation ─────────

/** The screens, in stack order: going up the list is a push, down is a pop. */
type Screen = 'home' | 'setup' | 'game' | 'settings';
const RANK: Record<Screen, number> = { home: 0, setup: 1, game: 2, settings: 3 };

function currentScreen(): Screen {
  if (dlgSettings.open) return 'settings';
  if (dlgSetup.open) return 'setup';
  return homeOpen() ? 'home' : 'game';
}

/** History entries above the start screen, so the browser's Back button steps back too. */
function depth(s: Screen) {
  if (s === 'home') return 0;
  return s === 'settings' && !homeOpen() ? 2 : 1;
}
let histDepth = 0;
let ignorePops = 0;

/** Make the browser history as deep as the screen stack. */
function syncHistory() {
  const want = depth(currentScreen());
  while (histDepth < want) history.pushState({ depth: ++histDepth }, '');
  if (histDepth > want) {
    ignorePops++;
    history.go(want - histDepth);
    histDepth = want;
  }
}

/** Change screens with the stack animation, then line up the browser history. */
function go(update: () => void, animate = true) {
  const before = RANK[currentScreen()];
  navigate(
    () => {
      update();
      syncHistory();
    },
    () => {
      const after = RANK[currentScreen()];
      return after > before ? 'push' : after < before ? 'pop' : 'sheet';
    },
    animate,
  );
}

/** One step back: the top sheet or page closes, or the game returns to the start screen. */
function back() {
  const top = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].pop();
  if (top) shut(top);
  else if (!homeOpen()) showHome();
}

history.replaceState({ depth: 0 }, '');
addEventListener('popstate', (e) => {
  if (ignorePops) {
    ignorePops--;
    return;
  }
  histDepth = (e.state as { depth?: number } | null)?.depth ?? 0;
  // Safari's swipe-back has already animated the page away; don't play ours on top.
  go(back, !(e as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition);
});

function savedSummary(id: GameId): string | null {
  if (id === 'hearts') return HeartsGame.saved();
  if (id === 'spite') return SpiteGame.saved();
  if (id === 'mines') return MinesGame.saved();
  const s = SpiderGame.saved();
  return s ? `Spider · ${s.suitCount} suit${s.suitCount > 1 ? 's' : ''} · ${s.moves} moves · ${fmtTime(s.ms)}` : null;
}

function showHome() {
  game?.pause();
  layoutDiag();
  const id = lastGame();
  const summary = savedSummary(id);
  $('#home-resume').hidden = !summary;
  if (summary) $('#home-continue-sub').textContent = summary;
  const suits = SpiderGame.saved()?.suitCount ?? null;
  home.querySelectorAll<HTMLElement>('[data-suits]').forEach((b) => b.classList.toggle('current', Number(b.dataset.suits) === suits));
  const level = SpiteGame.savedLevel();
  home.querySelectorAll<HTMLElement>('[data-level]').forEach((b) => b.classList.toggle('current', b.dataset.level === level));
  const field = MinesGame.savedLevel();
  home.querySelectorAll<HTMLElement>('[data-mines]').forEach((b) => b.classList.toggle('current', b.dataset.mines === field));
  home.classList.remove('hidden');
  home.scrollTop = 0;
}

function hideHome() {
  home.classList.add('hidden');
}

/** Bring the last game's save onto the table if it isn't there already. */
function loadSaved(id = lastGame()): boolean {
  const g = switchTo(id);
  return g.active || g.resume();
}

$('#home-continue').addEventListener('click', () =>
  go(() => {
    if (!loadSaved()) return showHome();
    hideHome();
    game!.unpause();
  }),
);
$('#home-restart').addEventListener('click', () =>
  go(() => {
    if (!loadSaved()) return showHome();
    hideHome();
    game!.restart();
    game!.unpause();
  }),
);
home.querySelectorAll<HTMLElement>('[data-suits]').forEach((btn) =>
  btn.addEventListener('click', () =>
    setup('spider', btn.querySelector('b')!.textContent!, () => {
      const g = switchTo('spider');
      hideHome();
      g.newGame(Number(btn.dataset.suits) as SuitCount);
      g.unpause();
    }),
  ),
);
$('#hearts-play').addEventListener('click', () =>
  setup('hearts', 'Against 🦊 Fox, 🦉 Owl and 🐻 Bear', () => {
    const g = switchTo('hearts');
    hideHome();
    g.newGame();
    g.unpause();
  }),
);
home.querySelectorAll<HTMLElement>('[data-level]').forEach((btn) =>
  btn.addEventListener('click', () =>
    setup('spite', `Against ${btn.querySelector('b')!.textContent} ${btn.querySelector('small')!.textContent}`, () => {
      const g = switchTo('spite');
      hideHome();
      g.newGame(btn.dataset.level as Level);
      g.unpause();
    }),
  ),
);
home.querySelectorAll<HTMLElement>('[data-mines]').forEach((btn) =>
  btn.addEventListener('click', () =>
    go(() => {
      const g = switchTo('mines');
      hideHome();
      g.newGame(btn.dataset.mines as MinesLevel);
      g.unpause();
    }),
  ),
);
$('#home-settings').addEventListener('click', () => openSettings());

$('#btn-preview-win').addEventListener('click', () => {
  go(() => {
    settingsFromMenu = false;
    shut(dlgSettings);
    // Needs cards on the table: use the current game, the saved one, or a fresh deal.
    if (homeOpen()) {
      if (!loadSaved()) switchTo('spider').newGame(2);
      hideHome();
    }
  });
  window.setTimeout(() => game?.previewWin(), 600);
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
  $('#menu-line').textContent = game.status();
  $('#menu-restart').textContent = game.restartLabel;
  open(dlgMenu);
}

$('#btn-menu').addEventListener('click', openMenu);
onClose.set(dlgMenu, (v) => {
  if (v === 'home') return showHome();
  if (v === 'settings') {
    settingsFromMenu = true;
    return openSettings(game?.id);
  }
  if (v === 'restart') game?.restart();
  game?.unpause();
});
onClose.set(dlgSettings, () => {
  if (settingsFromMenu) {
    settingsFromMenu = false;
    open(dlgMenu);
  }
});

onClose.set(dlgWin, (v) => {
  if (v === 'new' && game) {
    game.again();
    game.unpause();
  }
  if (v === 'home') showHome();
});
onClose.set(dlgStuck, (v) => {
  if (v === 'undo') game?.undo();
  if (v === 'new') showHome();
});

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || homeOpen() || !game) return;
  if (game.key(e)) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    game.undo();
  } else if (!e.metaKey && !e.ctrlKey) {
    if (e.key === 'h') game.hint();
    if (e.key === 'Escape' || e.key === 'm') openMenu();
  }
});

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
  // A 3 of hearts and of spades in each style: one big suit, or three pips.
  (id) => `<span class="mini-deck" data-deck="${id}">${['H', 'S']
    .map((suit) => {
      const sym = suit === 'H' ? '♥&#xFE0E;' : '♠&#xFE0E;';
      const face = id === 'pips' ? `<u class="trio"><s>${sym}</s><s>${sym}</s><s>${sym}</s></u>` : `<u>${sym}</u>`;
      return `<span class="mini-face" data-suit="${suit}"><b>3</b>${face}</span>`;
    })
    .join('')}</span>`,
);
swatches('courts', COURTS, (id) =>
  id === 'letters'
    ? `<span class="mini-court letters">K</span>`
    : `<span class="mini-court" style="background-image:url(${courtUrl(id, 'king_hearts')})"></span>`,
);
swatches('back', BACKS, (id) => `<span class="mini-back" data-back="${id}"></span>`);
swatches('table', TABLES, (id) => `<span class="mini-table" data-table="${id}"></span>`);

type Toggle = {
  key: keyof Settings;
  label: string;
  hint: string;
  group: 'cards' | 'play' | 'feel';
  /** Options for one game: listed in its Settings section and its setup step. */
  games?: GameId[];
  show?: () => boolean;
  needs?: keyof Settings;
};
const TOGGLES: Toggle[] = [
  { key: 'noMovesAlert', label: 'Tell me when I’m stuck', hint: 'Only when nothing can be moved or dealt; use Hint otherwise', group: 'play', games: ['spider'] },
  { key: 'tapToMove', label: 'Tap to move', hint: 'Double-tap a card to send it to the best spot', group: 'play', games: ['spider'] },
  { key: 'singleTap', label: 'Single tap is enough', hint: 'Move with one tap instead of two', group: 'play', games: ['spider'], needs: 'tapToMove' },
  { key: 'dimLocked', label: 'Shade cards that can’t move', hint: 'Only the movable run in each column stays bright white', group: 'play', games: ['spider'] },
  { key: 'dealWithEmpty', label: 'Deal with empty columns', hint: 'Off follows the classic rule: fill every column before dealing', group: 'play', games: ['spider'] },
  { key: 'showTargets', label: 'Show where cards can go', hint: 'Highlights legal drop spots while dragging', group: 'play', games: ['spider'] },
  { key: 'heartsPassing', label: 'Pass cards', hint: 'Swap 3 cards before each hand (left, right, across, none)', group: 'play', games: ['hearts'] },
  { key: 'heartsOneTap', label: 'Play with one tap', hint: 'Off: tap to lift a card, tap again to play it', group: 'play', games: ['hearts'] },
  { key: 'dimLocked', label: 'Shade cards you can’t play', hint: 'On your turn, only playable cards stay bright', group: 'play', games: ['hearts'] },
  { key: 'heartsShort', label: 'Short game', hint: 'Play to 50 points instead of 100 (from the next game)', group: 'play', games: ['hearts'] },
  { key: 'heartsMoonSubtract', label: 'Moon subtracts 26', hint: 'Shooting the moon takes 26 off your score instead of adding 26 to everyone else', group: 'play', games: ['hearts'] },
  { key: 'heartsFast', label: 'Quick opponents', hint: 'Fox, Owl and Bear play faster', group: 'play', games: ['hearts'] },
  { key: 'spiteShort', label: 'Short game', hint: '13-card goal piles instead of 20 (from the next game)', group: 'play', games: ['spite'] },
  { key: 'spiteFast', label: 'Quick opponent', hint: 'Fox plays faster', group: 'play', games: ['spite'] },
  { key: 'fourColour', label: 'Four-colour suits', hint: 'Blue diamonds and green clubs, so no two suits share a colour', group: 'cards' },
  { key: 'largePrint', label: 'Large print', hint: 'Bigger, bolder corner numbers', group: 'cards' },
  { key: 'sound', label: 'Sound', hint: '', group: 'feel' },
  { key: 'haptics', label: 'Vibration', hint: '', group: 'feel', show: canVibrate },
  { key: 'bunny', label: 'Hint Bunny', hint: 'Cheers you on with gestures; tap it for a hint', group: 'feel' },
];

const toggleRows = (list: Toggle[]) =>
  list
    .filter((t) => !t.show || t.show())
    .map(
      (t) => `<label class="toggle${t.needs ? ' sub' : ''}" ${t.needs ? `data-needs="${t.needs}"` : ''}>
      <span><b>${t.label}</b>${t.hint ? `<small>${t.hint}</small>` : ''}</span>
      <input type="checkbox" role="switch" data-k="${t.key}" />
    </label>`,
    )
    .join('');
const gameToggles = (id: GameId) => TOGGLES.filter((t) => t.games?.includes(id));

/** Games with options get a Settings section and a setup step before a new game. */
const GAME_OPTIONS: { id: GameId; name: string; remember: keyof Settings }[] = [
  { id: 'spider', name: 'Spider', remember: 'rememberSpider' },
  { id: 'hearts', name: 'Hearts', remember: 'rememberHearts' },
  { id: 'spite', name: 'Spite & Malice', remember: 'rememberSpite' },
];

$('#opt-cards').innerHTML = toggleRows(TOGGLES.filter((t) => t.group === 'cards'));
$('#opt-feel').innerHTML = toggleRows(TOGGLES.filter((t) => t.group === 'feel'));
$('#opt-games').innerHTML = GAME_OPTIONS.map(
  (g) => `<details class="group" data-sec="${g.id}">
    <summary><b>${g.name}</b><small>Options for new ${g.name} games</small></summary>
    <div class="toggles">${toggleRows(gameToggles(g.id))}</div>
    <div class="toggles remember">${toggleRows([
      { key: g.remember, label: 'Remember settings', hint: 'Skip the setup step', group: 'play' },
    ])}</div>
  </details>`,
).join('');

// Every switch on any page writes straight to settings.
for (const d of [dlgSettings, dlgSetup]) {
  d.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.k) return;
    updateSettings({ [input.dataset.k!]: input.checked } as Partial<Settings>);
    // Audible confirmation that sound works (this runs inside the tap, so iOS allows it).
    if (input.dataset.k === 'sound' && input.checked) sfx.move();
  });
}

/** Settings as a full page; from a game, that game's section starts open. */
function openSettings(focus?: GameId) {
  dlgSettings.querySelectorAll<HTMLDetailsElement>('details').forEach((d) => (d.open = d.dataset.sec === focus));
  open(dlgSettings);
  dlgSettings.scrollTop = 0;
}

// ───────── new-game setup ─────────

let pendingStart: (() => void) | null = null;

/** Show a game's options before it starts, unless the player asked to skip this step. */
function setup(id: GameId, line: string, start: () => void) {
  const g = GAME_OPTIONS.find((o) => o.id === id);
  if (!g || settings[g.remember]) return go(start);
  pendingStart = start;
  $('#setup-title').textContent = g.name;
  $('#setup-line').textContent = line;
  $('#setup-opts').innerHTML = toggleRows(gameToggles(id));
  $<HTMLInputElement>('#setup-remember').checked = false;
  $<HTMLInputElement>('#setup-remember').dataset.remember = g.remember;
  syncToggles(settings);
  open(dlgSetup);
}
onClose.set(dlgSetup, (v) => {
  const start = pendingStart;
  pendingStart = null;
  if (v !== 'start' || !start) return;
  const remember = $<HTMLInputElement>('#setup-remember');
  if (remember.checked) updateSettings({ [remember.dataset.remember!]: true } as Partial<Settings>);
  start();
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
  document.documentElement.classList.toggle('four-colour', s.fourColour);
  document.documentElement.classList.toggle('large-print', s.largePrint);
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
  syncToggles(s);
});

function syncToggles(s: Settings) {
  document
    .querySelectorAll<HTMLInputElement>('input[data-k]')
    .forEach((i) => (i.checked = Boolean(s[i.dataset.k as keyof Settings])));
  // Sub-options only apply while their parent switch is on.
  document.querySelectorAll<HTMLElement>('[data-needs]').forEach((row) => {
    const on = Boolean(s[row.dataset.needs as keyof Settings]);
    row.classList.toggle('disabled', !on);
    row.querySelector('input')!.disabled = !on;
  });
}
onSettings(() => Object.values(games).forEach((g) => g?.refresh()));

onSettings((s) => {
  bunny.setEnabled(s.bunny);
  // The Hint Bunny is the hint button (tap it); keep the toolbar button only without it.
  $('#btn-hint').hidden = s.bunny;
});

showHome();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
