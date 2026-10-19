import { useEffect } from 'react';

/** One object URL per stored photo, shared by every view of it (the Top 5 thumbnail and the photo view). */
const urls = new Map<Blob, { url: string; users: number }>();

function entryFor(blob: Blob): { url: string; users: number } {
  let entry = urls.get(blob);
  if (!entry) {
    entry = { url: URL.createObjectURL(blob), users: 0 };
    urls.set(blob, entry);
  }
  return entry;
}

/** An object URL for a stored photo, revoked once nothing shows that photo any more. */
export function usePhotoUrl(blob: Blob | undefined): string | undefined {
  const url = blob ? entryFor(blob).url : undefined;
  useEffect(() => {
    if (!blob) return;
    const entry = entryFor(blob);
    entry.users += 1;
    return () => {
      entry.users -= 1;
      // Deferred, so an unmount followed at once by a mount (StrictMode) keeps the URL already shown.
      window.setTimeout(() => {
        if (entry.users > 0 || urls.get(blob) !== entry) return;
        URL.revokeObjectURL(entry.url);
        urls.delete(blob);
      }, 0);
    };
  }, [blob]);
  return url;
}
