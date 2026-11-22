import './style.css';
import { type GameHooks, type GameId, type Hud, type Result, fmtTime, store } from './core/game';
import { HeartsGame } from './games/hearts/HeartsGame';
import { SpiderGame } from './games/spider/SpiderGame';
import type { Level } from './games/spite/ai';
import { SpiteGame } from './games/spite/SpiteGame';
import { FreeCellGame } from './games/freecell/FreeCellGame';
import { LandscaperGame } from './games/landscaper/LandscaperGame';
import type { SuitCount } from './games/spider/rules';
import { courtUrl } from './ui/cardLayer';
import { Bunny } from './ui/bunny';
import { navigate } from './ui/nav';
import { type Key, LANGS, deviceLang, has, setLang, t, tn, translatePage } from './i18n';
import { takeResumeSpot, watchForUpdates } from './ui/update';
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

// ───────── language ─────────

/** Text built in code, redrawn when the language changes. */
const redrawText: (() => void)[] = [];
const wantedLang = () => (settings.lang === 'auto' ? deviceLang() : settings.lang);
setLang(wantedLang());
translatePage();
redrawText.push(() => {
  home.querySelectorAll<HTMLElement>('[data-opponents-label]').forEach((b) => b.setAttribute('aria-label', tn('landscaper.opponents', Number(b.dataset.opponentsLabel))));
  home.querySelectorAll<HTMLElement>('[data-suits-label]').forEach((b) => (b.textContent = tn('spider.suits', Number(b.dataset.suitsLabel))));
});
let shownLang = wantedLang();
onSettings(() => {
  if (wantedLang() === shownLang) return;
  shownLang = wantedLang();
  setLang(shownLang);
  translatePage();
  redrawText.forEach((fn) => fn());
  if (homeOpen()) showHome();
  Object.values(games).forEach((g) => g?.refresh());
});


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

type AnyGame = SpiderGame | HeartsGame | SpiteGame | FreeCellGame | LandscaperGame;
type GameOf<T extends GameId> = T extends 'spider'
  ? SpiderGame
  : T extends 'hearts'
    ? HeartsGame
    : T extends 'spite'
      ? SpiteGame
      : T extends 'freecell'
        ? FreeCellGame
        : LandscaperGame;
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
    occupied: (spans) => mine() && bunny.avoid(spans),
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
            : id === 'freecell'
              ? new FreeCellGame(layer, hooks)
              : new LandscaperGame(layer, hooks);
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
  // Back to its usual corner; a game that needs it elsewhere says so when it lays out.
  bunny.avoid([]);
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
  if (id === 'landscaper') return LandscaperGame.saved();
  if (id === 'freecell') {
    const f = FreeCellGame.saved();
    return f ? t('freecell.status', { moves: tn('moves', f.moves), time: fmtTime(f.ms) }) : null;
  }
  const s = SpiderGame.saved();
  return s ? t('spider.status', { suits: tn('spider.suits', s.suitCount), moves: tn('moves', s.moves), time: fmtTime(s.ms) }) : null;
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
  setup('hearts', t('hearts.setupLine'), () => {
    const g = switchTo('hearts');
    hideHome();
    g.newGame();
    g.unpause();
  }),
);
home.querySelectorAll<HTMLElement>('[data-level]').forEach((btn) =>
  btn.addEventListener('click', () =>
    setup('spite', t('spite.setupLine', { who: `${btn.querySelector('b')!.textContent} ${btn.querySelector('small')!.textContent}` }), () => {
      const g = switchTo('spite');
      hideHome();
      g.newGame(btn.dataset.level as Level);
      g.unpause();
    }),
  ),
);
home.querySelectorAll<HTMLElement>('[data-opponents]').forEach((btn) =>
  btn.addEventListener('click', () =>
    setup('landscaper', t('landscaper.setupLine', { who: `${btn.querySelector('small')!.textContent} · ${btn.getAttribute('aria-label')}` }), () => {
      const g = switchTo('landscaper');
      hideHome();
      g.newGame(Number(btn.dataset.opponents));
      g.unpause();
    }),
  ),
);
$('#freecell-play').addEventListener('click', () =>
  setup('freecell', t('freecell.setupLine'), () => {
    const g = switchTo('freecell');
    hideHome();
    g.newGame();
    g.unpause();
  }),
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

redrawText.push(() => ($('#build-id').textContent = t('home.build', { id: __BUILD_ID__ })));

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
  $('#menu-restart').textContent = t(game.restartLabel);
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

/** A row of picture buttons for one setting; labels come from the translations (`<key>.<id>`). */
function swatches<K extends 'deck' | 'back' | 'table' | 'courts' | 'lang'>(
  key: K,
  list: readonly { id: Settings[K] }[],
  preview: (id: string) => string,
) {
  const root = $(`#opt-${key}`);
  const draw = () => {
    root.innerHTML = list
      .map((o) => {
        const label = t(`${key}.${o.id}` as Key);
        return `<button type="button" class="swatch" data-v="${o.id}" aria-label="${label}" aria-pressed="${o.id === settings[key]}">
        ${preview(o.id)}<span>${label}</span></button>`;
      })
      .join('');
  };
  draw();
  redrawText.push(draw);
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
swatches(
  'lang',
  [{ id: 'auto' }, ...Object.keys(LANGS).map((id) => ({ id: id as keyof typeof LANGS }))],
  (id) => `<span class="mini-lang">${id === 'auto' ? '🌐' : id === 'sv' ? '🇸🇪' : '🇬🇧'}</span>`,
);

type Toggle = {
  key: keyof Settings;
  /** Translation key under `opt.` (defaults to the setting's key); `.hint` is the line below. */
  text?: string;
  group: 'cards' | 'play' | 'feel';
  /** Options for one game: listed in its Settings section and its setup step. */
  games?: GameId[];
  show?: () => boolean;
  needs?: keyof Settings;
  /** A ready-made label instead of translation keys. */
  label?: [string, string];
};
const TOGGLES: Toggle[] = [
  { key: 'noMovesAlert', group: 'play', games: ['spider', 'freecell'] },
  { key: 'tapToMove', group: 'play', games: ['spider', 'freecell'] },
  { key: 'singleTap', group: 'play', games: ['spider', 'freecell'], needs: 'tapToMove' },
  { key: 'dimLocked', group: 'play', games: ['spider', 'freecell'] },
  { key: 'dealWithEmpty', group: 'play', games: ['spider'] },
  { key: 'showTargets', group: 'play', games: ['spider', 'freecell'] },
  { key: 'heartsPassing', group: 'play', games: ['hearts'] },
  { key: 'heartsOneTap', group: 'play', games: ['hearts'] },
  { key: 'dimLocked', text: 'dimLockedHearts', group: 'play', games: ['hearts'] },
  { key: 'heartsShort', group: 'play', games: ['hearts'] },
  { key: 'heartsMoonSubtract', group: 'play', games: ['hearts'] },
  { key: 'heartsFast', group: 'play', games: ['hearts'] },
  { key: 'spiteShort', group: 'play', games: ['spite'] },
  { key: 'spiteFast', group: 'play', games: ['spite'] },
  { key: 'landscaperRiver', group: 'play', games: ['landscaper'] },
  { key: 'landscaperFarmers', group: 'play', games: ['landscaper'] },
  { key: 'landscaperFast', group: 'play', games: ['landscaper'] },
  { key: 'fourColour', group: 'cards' },
  { key: 'largePrint', group: 'cards' },
  { key: 'sound', group: 'feel' },
  { key: 'haptics', group: 'feel', show: canVibrate },
  { key: 'bunny', group: 'feel' },
];

const toggleText = (tg: Toggle): [string, string] => {
  if (tg.label) return tg.label;
  const k = `opt.${tg.text ?? tg.key}`;
  return [t(k as Key), has(`${k}.hint`) ? t(`${k}.hint` as Key) : ''];
};
const toggleRows = (list: Toggle[]) =>
  list
    .filter((tg) => !tg.show || tg.show())
    .map((tg) => {
      const [label, hint] = toggleText(tg);
      return `<label class="toggle${tg.needs ? ' sub' : ''}" ${tg.needs ? `data-needs="${tg.needs}"` : ''}>
      <span><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</span>
      <input type="checkbox" role="switch" data-k="${tg.key}" />
    </label>`;
    })
    .join('');
const gameToggles = (id: GameId) => TOGGLES.filter((t) => t.games?.includes(id));

/** Games with options get a Settings section and a setup step before a new game. */
const GAME_OPTIONS: { id: GameId; remember: keyof Settings }[] = [
  { id: 'spider', remember: 'rememberSpider' },
  { id: 'hearts', remember: 'rememberHearts' },
  { id: 'spite', remember: 'rememberSpite' },
  { id: 'freecell', remember: 'rememberFreecell' },
  { id: 'landscaper', remember: 'rememberLandscaper' },
];
const gameName = (id: GameId) => t(`${id}.name` as Key);

function drawToggles() {
  $('#opt-cards').innerHTML = toggleRows(TOGGLES.filter((tg) => tg.group === 'cards'));
  $('#opt-feel').innerHTML = toggleRows(TOGGLES.filter((tg) => tg.group === 'feel'));
  const open = new Set([...document.querySelectorAll<HTMLDetailsElement>('#opt-games details[open]')].map((d) => d.dataset.sec));
  $('#opt-games').innerHTML = GAME_OPTIONS.map(
    (g) => `<details class="group" data-sec="${g.id}"${open.has(g.id) ? ' open' : ''}>
    <summary><b>${gameName(g.id)}</b><small>${t('settings.gameSub', { name: gameName(g.id) })}</small></summary>
    <div class="toggles">${toggleRows(gameToggles(g.id))}</div>
    <div class="toggles remember">${toggleRows([
      { key: g.remember, group: 'play', label: [t('setup.remember'), t('setup.rememberHint')] },
    ])}</div>
  </details>`,
  ).join('');
  syncToggles(settings);
}
drawToggles();
redrawText.push(drawToggles);

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
  $('#setup-title').textContent = gameName(id);
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
  for (const key of ['deck', 'back', 'table', 'courts', 'lang'] as const) {
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

redrawText.forEach((fn) => fn());
showHome();
// Back from an update reload: straight to the game that was on the table.
const resumeSpot = takeResumeSpot();
if (resumeSpot?.screen === 'game' && loadSaved(resumeSpot.id)) {
  go(() => {
    hideHome();
    game!.unpause();
  }, false);
}

watchForUpdates({
  spot(anyway) {
    if (!anyway && document.querySelector('dialog[open], .card.dragging')) return null;
    if (homeOpen() || !game) return { screen: 'home' };
    return { screen: 'game', id: game.id };
  },
  save: () => game?.pause(),
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
