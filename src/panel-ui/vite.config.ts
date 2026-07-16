import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  /**
   * Vite's root is process.cwd() by default — passing --config does NOT move it, so without
   * this the build looks for index.html at the repo root and dies with "Could not resolve
   * entry module". Written cwd-relative rather than derived from import.meta/__dirname because
   * this config is only ever loaded via `npm run build:panel` / `dev:panel`, and npm always
   * runs scripts from the package root.
   */
  root: 'src/panel-ui',

  // Load-bearing. The API owns '/', and every non-/panel path is behind the root auth hook, so
  // a default base of '/' would emit <script src="/assets/index-xxxx.js"> — a 401/404 that
  // presents as a blank page rather than a build error.
  base: '/panel/',

  build: {
    // dist/panel, matching panel-static.plugin.ts. Built LAST by `npm run build` because
    // scripts/clean.mjs rm -rf's the whole of dist/.
    outDir: '../../dist/panel',
    // outDir is outside Vite's root, so it refuses to clear it unless told explicitly.
    // Safe: nothing but this build ever writes there.
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },

  // Dev only: `npm run dev:panel` beside `npm run dev`, so the SPA talks to the real API on the
  // same origin and the __Host- session cookie behaves exactly as it does in production.
  server: {
    proxy: { '/v1': { target: 'http://127.0.0.1:3000' } },
  },

  plugins: [react()],
});
