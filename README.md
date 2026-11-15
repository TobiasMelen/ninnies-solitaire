# Ninnies Solitaire

Touch-first solitaire for the browser. No backend, no accounts, works offline once loaded.

**Play:** https://tobiasmelen.github.io/ninnies-solitaire/

## Games

- **Spider** — 1, 2 or 4 suits.

## Features

- Drag runs, or tap a card to send it to the best spot (same suit first).
- Legal drop spots light up while dragging; illegal picks wiggle.
- Hints (cycle through them), unlimited undo, restart the same deal.
- Optional alert when no useful moves are left.
- Card styles (Classic, Four colour, Large print, Night), card backs and table colours.
- Synthesised sound and vibration, both toggleable.
- Game and settings are saved on the device. Installable as a PWA.

Keyboard: `Ctrl/⌘+Z` undo, `H` hint, `D`/`Space` deal, `N` new game.

## Develop

```sh
npm install
npm run dev     # local server
npm test        # rules tests
npm run build   # static build in dist/
```

Pushing to `main` deploys to GitHub Pages via `.github/workflows/pages.yml`.

## Layout

- `src/core` — cards and seeded shuffle, shared by all games.
- `src/ui` — card renderer, settings, sound/haptics.
- `src/games/spider` — `rules.ts` (pure, tested) and `SpiderGame.ts` (layout, input, animation).
