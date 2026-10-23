import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout: a navigation's scroll to the top does nothing.
if (typeof window !== 'undefined') window.scrollTo = () => undefined;

afterEach(() => {
  cleanup();
});
