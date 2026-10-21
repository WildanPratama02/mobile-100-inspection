// Starts the real API on a throw-away database before any spec runs; the returned function is the teardown.
import { startTestApi } from './api/testApi';

export default function globalSetup(): Promise<() => Promise<void>> {
  return startTestApi();
}
