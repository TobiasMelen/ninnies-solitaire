import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
})();

// Relative base so the build works under /ninnies-solitaire/ on GitHub Pages.
export default defineConfig({
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(`${commit} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`),
  },
});
