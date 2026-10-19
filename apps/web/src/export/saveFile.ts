/**
 * Hands an export to the PSI (doc 05 §8.5): the system save dialog where the browser has one
 * (`showSaveFilePicker`), otherwise a download into the download folder. The Android share sheet
 * (`navigator.share`) is deferred, as doc 05 §8.5 records.
 */

/** `cancelled`: the PSI closed the save dialog; nothing was saved and no toast is shown. */
export type SaveOutcome = 'saved' | 'cancelled';

interface SaveFilePickerOptions {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}

interface Writable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

/** The part of the File System Access API used here; TypeScript's DOM types don't include it yet. */
export type ShowSaveFilePicker = (
  options: SaveFilePickerOptions,
) => Promise<{ createWritable(): Promise<Writable> }>;

/** How long the download's object URL is kept, so a slow download still finds it. */
const REVOKE_AFTER_MS = 60_000;

/**
 * The save dialog needs the tap's user activation, which Chrome lets expire after a few seconds; a large
 * PDF can take longer to make. The dialog is then refused before it opens, and the file is downloaded.
 */
const PICKER_REFUSED = new Set(['SecurityError', 'NotAllowedError']);

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot);
}

export async function saveFile(name: string, blob: Blob): Promise<SaveOutcome> {
  const picker = (window as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (picker) {
    let handle;
    try {
      handle = await picker.call(window, {
        suggestedName: name,
        types: [{ description: name, accept: { [blob.type]: [extension(name)] } }],
      });
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      if (error.name === 'AbortError') return 'cancelled';
      if (!PICKER_REFUSED.has(error.name)) throw error;
    }
    if (handle) {
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return 'saved';
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  return 'saved';
}
