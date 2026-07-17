import { describe, it, expect, vi, afterEach } from 'vitest';
import { saveTextFile } from '../src/lib/clipboard';

/**
 * saveTextFile picks between the Web Share sheet (reliable inside the Android
 * PWA) and the anchor download (desktop). These tests stub the globals it
 * probes so the branch selection is verified without a browser.
 */

const origNavigator = globalThis.navigator;
const origDocument = (globalThis as { document?: unknown }).document;
const origURL = globalThis.URL;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'navigator', { value: origNavigator, configurable: true });
  (globalThis as { document?: unknown }).document = origDocument;
  globalThis.URL = origURL;
});

function stubNavigator(nav: Partial<Navigator>): void {
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
}

/** A minimal document/URL stub so the anchor-download fallback can run. */
function stubDownloadDom(): { clicked: () => boolean } {
  let clicked = false;
  const anchor = { href: '', download: '', click: () => { clicked = true; }, remove: () => {} };
  (globalThis as { document?: unknown }).document = {
    createElement: () => anchor,
    body: { appendChild: () => {} },
  };
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} } as unknown as typeof URL;
  return { clicked: () => clicked };
}

describe('saveTextFile', () => {
  it('shares the file when the platform can share files', async () => {
    const share = vi.fn(async (_data: { files: File[]; title: string }) => {});
    stubNavigator({ share, canShare: () => true } as unknown as Navigator);
    const dom = stubDownloadDom();

    expect(await saveTextFile('doc-markers.txt', 'hello')).toBe(true);
    expect(share).toHaveBeenCalledOnce();
    const arg = share.mock.calls[0][0];
    expect(arg.files[0].name).toBe('doc-markers.txt');
    expect(arg.title).toBe('doc-markers.txt');
    expect(dom.clicked()).toBe(false); // shared, so no fallback download
  });

  it('returns false and does NOT download when the share sheet is dismissed', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const share = vi.fn(async () => { throw abort; });
    stubNavigator({ share, canShare: () => true } as unknown as Navigator);
    const dom = stubDownloadDom();

    expect(await saveTextFile('doc.txt', 'hi')).toBe(false);
    expect(dom.clicked()).toBe(false);
  });

  it('falls back to the anchor download when file sharing is unavailable', async () => {
    stubNavigator({} as Navigator); // no share/canShare
    const dom = stubDownloadDom();

    expect(await saveTextFile('doc.txt', 'hi')).toBe(true);
    expect(dom.clicked()).toBe(true);
  });

  it('falls back to the download when canShare rejects the file', async () => {
    const share = vi.fn(async () => {});
    stubNavigator({ share, canShare: () => false } as unknown as Navigator);
    const dom = stubDownloadDom();

    expect(await saveTextFile('doc.txt', 'hi')).toBe(true);
    expect(share).not.toHaveBeenCalled();
    expect(dom.clicked()).toBe(true);
  });
});
