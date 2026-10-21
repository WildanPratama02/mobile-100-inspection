/** The setup page (S0, doc 03 §4.9): `https://<host>/setup#k=<device key>`. */
export const SETUP_PATH = '/setup';

/** The key of a setup link's fragment `#k=<key>`; `null` without one. */
export function keyFromHash(hash: string): string | null {
  const key = new URLSearchParams(hash.replace(/^#/, '')).get('k')?.trim();
  return key ? key : null;
}
