/**
 * SHA-256 as lowercase hex: of a photo (doc 03 §4.5) and of the sealed submission string, which the API
 * compares on every retry (doc 04 §4.3). A string is hashed as its UTF-8 bytes, the bytes that are sent.
 */
export async function sha256Hex(data: Blob | string): Promise<string> {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : await data.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
