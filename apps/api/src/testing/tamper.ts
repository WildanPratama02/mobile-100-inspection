/**
 * Changes one character in the middle of a JWT's signature, for tests that must see a tampered token refused.
 *
 * Not the last characters: base64url's final character carries padding bits that decoding ignores, so changing
 * it can leave the signature bytes unchanged (about 1 run in 900 for `…xx`). A middle character carries six full
 * bits, so the decoded signature always differs.
 */
export function tamperSignature(token: string): string {
  const dot = token.lastIndexOf('.');
  const signature = token.slice(dot + 1);
  const at = Math.floor(signature.length / 2);
  const changed = signature[at] === 'A' ? 'B' : 'A';
  return `${token.slice(0, dot + 1)}${signature.slice(0, at)}${changed}${signature.slice(at + 1)}`;
}
