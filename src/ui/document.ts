import { state, navigate, notify, addManyToBibliographyList } from '../app';
import type { CachedItem } from '../lib/types';
import {
  scanDocument,
  convertCitations,
  type ScanReport,
  type ConversionResult,
} from '../lib/scan';
import { copyText, vibrate } from '../lib/clipboard';
import { h, toast, svgIcon, ICONS, showClipboardFallback } from './dom';

/**
 * Screen 5 — Document tools. Two passes over a pasted draft:
 *
 *   • Scan document      — read the markers already in the text and reconcile
 *                          what's *cited* against the saved bibliography list.
 *   • Convert citations  — turn plain-text author-year citations into markers,
 *                          so the ODF-Scan desktop pass (and the reference
 *                          list) picks them up.
 *
 * Both are pure functions in lib/scan.ts; this file is just the wiring and the
 * result rendering.
 */

let docText = '';
let report: ScanReport | null = null;
let conversion: ConversionResult | null = null;

function reset(): void {
  report = null;
  conversion = null;
}

function itemLine(item: CachedItem, extra?: string): HTMLElement {
  const who = item.creatorsDisplay || item.title;
  return h(
    'li',
    { class: 'doc-item' },
    h('span', { class: 'row-who' }, who, ' ', h('span', { class: 'year' }, `(${item.year ?? 'n.d.'})`)),
    h('span', { class: 'row-title' }, extra ? `${item.title} · ${extra}` : item.title),
  );
}

function renderReport(host: HTMLElement, r: ScanReport): void {
  const sources = r.cited.length;
  host.append(
    h('div', { class: 'doc-summary', role: 'status' },
      h('strong', {}, `${r.totalMarkers} marker${r.totalMarkers === 1 ? '' : 's'}`),
      ` · ${sources} source${sources === 1 ? '' : 's'} cited`),
  );

  if (r.totalMarkers === 0) {
    host.append(h('p', { class: 'empty' },
      h('strong', {}, 'No markers found'),
      ' — paste a draft that already contains CitePocket markers, or use “Convert citations” below to create them from plain-text citations.'));
    return;
  }

  /* cited but not yet listed → offer to reconcile */
  if (r.citedNotInBibliography.length > 0) {
    const ids = r.citedNotInBibliography.map((i) => i.id);
    host.append(
      h('h2', {}, `Cited but not in your bibliography (${ids.length})`),
      h('p', {}, 'These sources appear in the document but aren’t in your bibliography list, so the reference list would leave them out.'),
      h('ul', { class: 'results doc-list' }, ...r.citedNotInBibliography.map((i) => itemLine(i))),
      h('button', {
        class: 'btn block',
        onclick: async () => {
          const added = await addManyToBibliographyList(ids);
          report = rescan(); // reflect the new bibliography state
          notify();
          toast(`Added ${added} source${added === 1 ? '' : 's'} to your bibliography`);
        },
      }, `Add ${ids.length} source${ids.length === 1 ? '' : 's'} to bibliography`),
    );
  } else if (sources > 0) {
    host.append(h('p', { class: 'doc-ok' }, '✓ Every cited source is already in your bibliography list.'));
  }

  /* orphans in the list */
  if (r.inBibliographyNotCited.length > 0) {
    host.append(
      h('h2', {}, `In bibliography but not cited (${r.inBibliographyNotCited.length})`),
      h('p', {}, 'These are in your bibliography list but aren’t cited anywhere in this document. That’s fine if the draft is partial — remove them on the Bibliography screen if they’re no longer needed.'),
      h('ul', { class: 'results doc-list' }, ...r.inBibliographyNotCited.map((i) => itemLine(i))),
    );
  }

  /* markers we couldn't resolve */
  if (r.unresolved.length > 0) {
    host.append(
      h('h2', {}, `Unrecognised markers (${r.unresolved.length})`),
      h('p', {}, 'These markers point at items that aren’t in this device’s synced library — from another device or a library you haven’t added. Re-sync, or check the source.'),
      h('ul', { class: 'results doc-list' },
        ...r.unresolved.map((u) => h('li', { class: 'doc-item' },
          h('span', { class: 'row-who' }, u.readableCite || u.uri),
          h('span', { class: 'row-title' }, `${u.uri}${u.count > 1 ? ` · ×${u.count}` : ''}`))),
      ),
    );
  }
}

function renderConversion(host: HTMLElement, c: ConversionResult): void {
  const subs = c.substitutions.length;
  host.append(
    h('div', { class: 'doc-summary', role: 'status' },
      h('strong', {}, `${subs} citation${subs === 1 ? '' : 's'} converted`),
      c.markersPreserved > 0 ? ` · ${c.markersPreserved} existing marker${c.markersPreserved === 1 ? '' : 's'} kept` : ''),
  );

  if (subs === 0 && c.unmatched.length === 0) {
    host.append(h('p', { class: 'empty' },
      h('strong', {}, 'No plain-text citations found'),
      ' — this tool looks for author-year citations like (Meier, 2021) or Meier (2021).'));
    return;
  }

  if (subs > 0) {
    /* the converted document, ready to copy back */
    const out = h('textarea', {
      class: 'doc-output', rows: '8', readonly: true, 'aria-label': 'Converted document text',
    }) as HTMLTextAreaElement;
    out.value = c.text;
    out.addEventListener('focus', () => out.select());
    host.append(
      h('p', { class: 'doc-ok' }, `✓ Copy the converted text below and paste it back over your draft, then run the ODF-Scan desktop step.`),
      out,
      h('button', {
        class: 'btn block',
        onclick: async () => {
          const ok = await copyText(c.text);
          if (ok) { vibrate(); toast('Converted document copied'); }
          else showClipboardFallback(c.text);
        },
      }, 'Copy converted document'),
    );
  }

  if (c.unmatched.length > 0) {
    host.append(
      h('h2', {}, `Left unchanged (${c.unmatched.length})`),
      h('p', {}, 'These look like citations but couldn’t be matched confidently, so they were left as-is. Fix them from the picker, or check the author spelling and year.'),
      h('ul', { class: 'results doc-list' },
        ...c.unmatched.map((u) => h('li', { class: 'doc-item' },
          h('span', { class: 'row-who' }, u.original),
          h('span', { class: 'row-title' },
            u.reason === 'ambiguous'
              ? `${u.candidateCount ?? 'several'} library items match — disambiguate from the picker`
              : 'no matching source in your library'))),
      ),
    );
  }
}

function rescan(): ScanReport {
  return scanDocument({
    text: docText,
    items: state.items,
    bibliographyIds: state.bibliography.map((e) => e.id),
  });
}

export function renderDocument(root: HTMLElement): void {
  // Keep whatever is in the textarea across re-renders (results appearing, a
  // bibliography add, …), the way the picker preserves its search box.
  const prev = root.querySelector<HTMLTextAreaElement>('.doc-input');
  if (prev) docText = prev.value;

  root.replaceChildren();

  const textarea = h('textarea', {
    class: 'doc-input',
    rows: '7',
    placeholder: 'Paste your draft here — the markers and citations in it will be read locally, never uploaded.',
    'aria-label': 'Document text to scan',
    oninput: (e: Event) => { docText = (e.target as HTMLTextAreaElement).value; },
  }) as HTMLTextAreaElement;
  textarea.value = docText;

  // Buttons stay enabled and read the live textarea value on click — typing
  // doesn't re-render, so a render-time disabled flag would get stuck.
  const scanBtn = h('button', {
    class: 'btn block',
    onclick: () => {
      docText = textarea.value;
      if (!docText.trim()) { toast('Paste a draft first'); return; }
      conversion = null;
      report = rescan();
      notify();
    },
  }, 'Scan document');

  const convertBtn = h('button', {
    class: 'btn secondary block',
    onclick: () => {
      docText = textarea.value;
      if (!docText.trim()) { toast('Paste a draft first'); return; }
      report = null;
      conversion = convertCitations({
        text: docText,
        items: state.items.values(),
        format: state.settings.format,
        citekeyPattern: state.settings.citekeyPattern,
      });
      notify();
    },
  }, 'Convert citations to markers');

  const results = h('div', { class: 'doc-results' });
  if (report) renderReport(results, report);
  else if (conversion) renderConversion(results, conversion);

  const page = h(
    'div',
    { class: 'page' },
    h('button', { class: 'back-btn', onclick: () => { reset(); navigate('picker'); }, 'aria-label': 'Back to search' },
      svgIcon(ICONS.back, 18), 'Back'),
    h('h1', {}, 'Scan document'),
    h('p', {},
      h('strong', {}, 'Scan document'),
      ' reads the markers already in a draft and checks them against your bibliography list. ',
      h('strong', {}, 'Convert citations'),
      ' turns plain-text citations like (Meier, 2021) into markers so the desktop ODF-Scan pass and the reference list pick them up.'),
    textarea,
    h('div', { class: 'doc-actions' }, scanBtn, convertBtn),
    results,
  );
  root.append(page);
}
