import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));
// The design-system components of the tablet app (doc 05 §20: same tokens, fonts and basic components).
const uiSrc = fileURLToPath(new URL('../web/src/ui/index.ts', import.meta.url));

// The API under `/v1` on the same origin, as Caddy serves it in production (doc 03 §7.1). `pnpm e2e` points this at
// the API it starts on its own test database.
const apiProxy = {
  '/v1': { target: process.env.M100_API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false },
};

export default defineConfig({
  // Caddy serves the build at `/admin/` (doc 03 §7.1). Online only: no service worker, not installable (U17).
  base: '/admin/',
  resolve: {
    alias: { '@m100/shared': sharedSrc, '@m100/ui': uiSrc },
  },
  server: {
    host: 'localhost',
    port: 5175,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
  plugins: [react()],
});
