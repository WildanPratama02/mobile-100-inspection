import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './ui/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element in index.html');

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
