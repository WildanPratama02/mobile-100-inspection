import '@testing-library/jest-dom/vitest';
// IndexedDB for Dexie in jsdom; each test file gets a fresh, empty one.
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
