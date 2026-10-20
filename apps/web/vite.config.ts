import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { APP_NAME } from '../../packages/shared/src/index.ts';
import { appVersionDefine } from './version.config.ts';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

const tokens = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../design-system/tokens.json', import.meta.url)), 'utf8'),
) as { color: { tokens: Array<{ name: string; value: { light: string } }> } };

/** A light-theme colour token, for the manifest, which cannot read CSS variables. */
function lightColor(name: string): string {
  const token = tokens.color.tokens.find((t) => t.name === name);
  if (!token) throw new Error(`design-system/tokens.json has no colour token "${name}"`);
  return token.value.light;
}

export default defineConfig({
  define: appVersionDefine,
  resolve: {
    alias: { '@m100/shared': sharedSrc },
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
  plugins: [
    react(),
    VitePWA({
      // The new service worker waits; the app activates it only when no inspection is active (doc 03 §4.8).
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/*.png'],
      manifest: {
        id: '/',
        name: APP_NAME,
        short_name: 'M100',
        lang: 'id',
        // Splash and status bar of the installed app match the white header strip (`bg`).
        background_color: lightColor('bg'),
        theme_color: lightColor('bg'),
        display: 'standalone',
        orientation: 'landscape',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App shell, self-hosted fonts and the shoe photo are precached for offline use (doc 03 §4.1).
        globPatterns: ['**/*.{js,css,html,png,avif,woff2}'],
        navigateFallback: '/index.html',
        // API calls are never cached by the service worker (doc 03 §4.1).
        navigateFallbackDenylist: [/^\/v1\//],
      },
    }),
  ],
});
