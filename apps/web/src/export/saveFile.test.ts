import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveFile, type ShowSaveFilePicker } from './saveFile';

const BLOB = new Blob(['%PDF-'], { type: 'application/pdf' });
const NAME = 'M100_0903359388_20261019.pdf';

type PickerWindow = { showSaveFilePicker?: ShowSaveFilePicker };

const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:export');
const revokeObjectURL = vi.fn<(url: string) => void>();

beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  // jsdom has no object URLs.
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  delete (window as PickerWindow).showSaveFilePicker;
  vi.restoreAllMocks();
});

describe('saveFile (doc 05 §8.5)', () => {
  it('writes the file through the save dialog where there is one', async () => {
    const write = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    const picker = vi.fn<ShowSaveFilePicker>(() =>
      Promise.resolve({ createWritable: () => Promise.resolve({ write, close }) }),
    );
    (window as PickerWindow).showSaveFilePicker = picker;

    await expect(saveFile(NAME, BLOB)).resolves.toBe('saved');
    expect(picker).toHaveBeenCalledWith({
      suggestedName: NAME,
      types: [{ description: NAME, accept: { 'application/pdf': ['.pdf'] } }],
    });
    expect(write).toHaveBeenCalledWith(BLOB);
    expect(close).toHaveBeenCalled();
  });

  it('reports a closed save dialog as cancelled', async () => {
    (window as PickerWindow).showSaveFilePicker = () =>
      Promise.reject(new DOMException('closed', 'AbortError'));
    await expect(saveFile(NAME, BLOB)).resolves.toBe('cancelled');
  });

  it('passes any other failure on, also while writing', async () => {
    (window as PickerWindow).showSaveFilePicker = () =>
      Promise.reject(new DOMException('full', 'QuotaExceededError'));
    await expect(saveFile(NAME, BLOB)).rejects.toThrow('full');

    (window as PickerWindow).showSaveFilePicker = () =>
      Promise.resolve({
        createWritable: () =>
          Promise.reject(new DOMException('disk', 'NoModificationAllowedError')),
      });
    await expect(saveFile(NAME, BLOB)).rejects.toThrow('disk');
  });

  it.each(['SecurityError', 'NotAllowedError'])(
    'downloads instead when the save dialog is refused (%s: the tap is too long ago)',
    async (name) => {
      (window as PickerWindow).showSaveFilePicker = () =>
        Promise.reject(new DOMException('no activation', name));
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      await expect(saveFile(NAME, BLOB)).resolves.toBe('saved');
      expect(click).toHaveBeenCalledOnce();
      expect(createObjectURL).toHaveBeenCalledWith(BLOB);
    },
  );

  it('downloads the file where there is no save dialog', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe(NAME);
      expect(this.href).toBe('blob:export');
    });
    vi.useFakeTimers();
    try {
      await expect(saveFile(NAME, BLOB)).resolves.toBe('saved');
      expect(click).toHaveBeenCalledTimes(1);
      expect(createObjectURL).toHaveBeenCalledWith(BLOB);
      expect(document.querySelector('a[download]')).toBeNull();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:export');
    } finally {
      vi.useRealTimers();
    }
  });
});
