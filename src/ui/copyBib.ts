import { buildBibliography } from '../app';
import { copyText, vibrate } from '../lib/clipboard';
import { toast, showClipboardFallback } from './dom';

/**
 * Shared "Copy bibliography" handler for the picker and settings screens.
 * Builds the styled reference list via the Zotero Web API, then copies it —
 * reusing the clipboard + toast + fallback plumbing already used for markers.
 * All failure paths surface a toast rather than throwing.
 */
export async function copyBibliographyAction(): Promise<void> {
  toast('Building bibliography…', 4000);
  let bib;
  try {
    bib = await buildBibliography();
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not build bibliography.', 3200);
    return;
  }
  if (bib.count === 0) {
    toast('No references were rendered for your cited items.', 3200);
    return;
  }
  const ok = await copyText(bib.text);
  if (ok) {
    vibrate();
    toast(`Copied ${bib.count} reference${bib.count === 1 ? '' : 's'} — paste into your doc`);
  } else {
    showClipboardFallback(bib.text);
  }
}
