import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Tokens, self-hosted fonts and the design-system components of the tablet app (doc 05 §20, U17).
import '../../web/src/ui/index.css';
import './admin.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element in index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
