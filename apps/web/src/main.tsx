import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { startAppUpdates } from './app/appUpdate';
import { requestPersistentStorage } from './db/repo';
import './ui/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element in index.html');

// Ask Chrome to keep IndexedDB under storage pressure: unsent sessions live only on the tablet (doc 03 §4.3).
requestPersistentStorage().catch(console.error);

// The precached app shell makes the app work offline (doc 03 §4.1); `pnpm dev` gets a no-op.
startAppUpdates(registerSW);

// Dev-only UI kit catalogue at /ui; `import.meta.env.DEV` is false in a build, so it is dropped there.
const UiKitPage =
  import.meta.env.DEV && window.location.pathname === '/ui'
    ? lazy(() => import('./dev/UiKitPage').then((m) => ({ default: m.UiKitPage })))
    : null;

createRoot(root).render(
  <StrictMode>
    {UiKitPage ? (
      <Suspense fallback={null}>
        <UiKitPage />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
