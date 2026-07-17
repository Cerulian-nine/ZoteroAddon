// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { state, subscribe, notify } from '../src/app';
import { renderDocument } from '../src/ui/document';
import { DEFAULT_SETTINGS, type CachedItem } from '../src/lib/types';

// jsdom (unlike real browsers) doesn't implement Blob.text()/arrayBuffer(),
// which lib/docimport relies on. Polyfill them via FileReader so the upload
// path exercises the real reader instead of throwing.
for (const method of ['text', 'arrayBuffer'] as const) {
  if (typeof (Blob.prototype as any)[method] !== 'function') {
    (Blob.prototype as any)[method] = function (this: Blob) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        if (method === 'text') fr.readAsText(this);
        else fr.readAsArrayBuffer(this);
      });
    };
  }
}

/**
 * Regression coverage for the Scan screen's "Upload document" wiring.
 *
 * The bug: uploading a file set the module-level docText, then notify()
 * re-rendered — and the top of renderDocument reads the *current* (still
 * empty) textarea back into docText to preserve in-progress typing. That read
 * clobbered the just-loaded text, so the textarea came back blank and "Scan
 * document" reported there was nothing to scan even though a file had been
 * uploaded and read.
 */

function item(overrides: Partial<CachedItem> = {}): CachedItem {
  return {
    id: 'u:1234567:ABCD1234',
    itemKey: 'ABCD1234',
    library: { type: 'user', id: 1234567 },
    itemType: 'journalArticle',
    title: 'Digital Workflows in the Humanities',
    creatorsDisplay: 'Kraus & Berger',
    creatorLastNames: ['kraus', 'berger'],
    year: 2023,
    publicationTitle: 'Journal of Digital Scholarship',
    dateModified: '2023-05-01T00:00:00Z',
    ...overrides,
  } as CachedItem;
}

const MARKER_DOC =
  'Intro { | Kraus & Berger, (2023) | | |zu:1234567:ABCD1234} tail';

/** Render the document screen into a root and keep it re-rendering on notify(). */
function mountDocumentScreen(): { root: HTMLElement; unsubscribe: () => void } {
  const root = document.createElement('div');
  document.body.append(root);
  const unsubscribe = subscribe(() => renderDocument(root));
  renderDocument(root);
  return { root, unsubscribe };
}

/** Simulate the file picker resolving to a given File and let the async
 *  onchange handler (readDocumentFile → notify) run to completion. */
async function uploadFile(root: HTMLElement, file: File): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change'));
  // Flush the async read + the notify()/re-render it triggers.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('Scan screen — upload document', () => {
  beforeEach(() => {
    state.settings = { ...DEFAULT_SETTINGS };
    state.items = new Map([[item().id, item()]]);
    state.bibliography = [];
    document.body.replaceChildren();
  });

  it('keeps the uploaded text in the textarea after the re-render', async () => {
    const { root } = mountDocumentScreen();
    await uploadFile(root, new File([MARKER_DOC], 'draft.txt', { type: 'text/plain' }));

    const textarea = root.querySelector<HTMLTextAreaElement>('.doc-input')!;
    expect(textarea.value).toBe(MARKER_DOC);
  });

  it('can scan the uploaded document without re-uploading', async () => {
    const { root } = mountDocumentScreen();
    await uploadFile(root, new File([MARKER_DOC], 'draft.txt', { type: 'text/plain' }));

    const scanBtn = [...root.querySelectorAll('button')].find(
      (b) => b.textContent === 'Scan document',
    )!;
    scanBtn.click();
    notify();

    const summary = root.querySelector('.doc-summary');
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toContain('1 marker');
    // The cited source isn't in the (empty) bibliography, so it should surface.
    expect(root.textContent).toContain('Cited but not in your bibliography');
  });

  it('surfaces an error and clears results for an empty file', async () => {
    const { root } = mountDocumentScreen();
    await uploadFile(root, new File(['   '], 'blank.txt', { type: 'text/plain' }));

    expect(root.querySelector('.doc-file-error')?.textContent).toContain('looks empty');
    // No report is rendered from a file that produced no text.
    expect(root.querySelector('.doc-summary')).toBeNull();
  });
});
