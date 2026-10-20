import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

/**
 * `__APP_VERSION__` = the `version` of `apps/web/package.json`. Every submission carries it as `appVersion`
 * (doc 03 §4.8, doc 04 §4.1). Shared by the Vite and Vitest configs.
 */
export const appVersionDefine = { __APP_VERSION__: JSON.stringify(pkg.version) };
