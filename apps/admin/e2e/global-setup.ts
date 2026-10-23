// Starts the real API on a throw-away database with a first admin before any spec runs; the returned function is
// the teardown.
import { startTestApi } from '../../web/e2e/api/testApi';
import { ROOT_ADMIN } from './fixtures';

export default function globalSetup(): Promise<() => Promise<void>> {
  return startTestApi({ admin: ROOT_ADMIN });
}
