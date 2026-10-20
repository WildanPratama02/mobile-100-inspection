import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { appVersionDefine } from './version.config.ts';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  define: appVersionDefine,
  plugins: [react()],
  resolve: {
    alias: { '@m100/shared': sharedSrc },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
