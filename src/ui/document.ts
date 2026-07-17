import { state, navigate, notify, addManyToBibliographyList, lookupOnlineSources, addFoundSources } from '../app';
import type { CachedItem } from '../lib/types';
import {
  scanDocument,
  convertCitations,
  type ScanReport,
  type ConversionResult,
  type UnmatchedCitation,
} from '../lib/scan';
import { ZoteroApiError } from '../lib/zotero';
import { copyText, downloadTextFile, vibrate } from '../lib/clipboard';
import { readDocumentFile, DocImportError, ACCEPTED_DOC_TYPES } from '../lib/docimport';
import { h, toast, svgIcon, ICONS, showClipboardFallback } from './dom';

/**
 * Screen 5 — Document tools. Two passes over an uploaded draft:
 *
 *   • Scan document      — read the markers already in the text and reconcile
 *                          what's *cited* against the saved bibliography list.
 *   • Convert citations  — turn plain-text author-year citations into markers,
 *                          so the ODF-Scan desktop pass (and the reference
 *                          list) picks them up.
 *
 * The draft comes in via “Upload document” only: the file is parsed in-browser
 * (lib/docimport) and held in module state until it's replaced or removed —
 * nothing is uploaded or stored. Both passes are pure functions in lib/scan.ts;
 * this file is just the wiring and the result rendering.
 */

let doc: { text: string; name: string } | null = null;
let report: ScanReport | null = null;
let conversion: ConversionResult | null = null;
let fileError: string | null = null;

/** Online-lookup state for the unknown citations left by a conversion. */
interface Lookup {
  citation: UnmatchedCitation;
  found: CachedItem[];
}
let lookups: Lookup[] | null = null;
let lookupLoading = false;
let lookupError: string | null = null;
/** Ids of found sources the user has already added (across re-renders). */
const addedFound = new Set<string>();

function resetResults(): void {
  report = null;
  conversion = null;
  fileError = null;
  resetLookup();
}

function resetLookup(): void {
  lookups = null;
  lookupLoading = false;
  lookupError = null;
  addedFound.clear();
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
      ' — upload a draft that already contains CitePocket markers, or use “Convert citations” below to create them from plain-text citations.'));
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
    /* the converted document, ready to copy back or download */
    const out = h('textarea', {
      class: 'doc-output', rows: '8', readonly: true, 'aria-label': 'Converted document text',
    }) as HTMLTextAreaElement;
    out.value = c.text;
    out.addEventListener('focus', () => out.select());
    host.append(
      h('p', { class: 'doc-ok' }, `✓ Download or copy the converted document below and put it back in place of your draft, then run the ODF-Scan desktop step.`),
      out,
      h('div', { class: 'doc-actions' },
        h('button', {
          class: 'btn block',
          onclick: () => {
            downloadTextFile(convertedFilename(), c.text);
            vibrate();
            toast('Converted document downloaded');
          },
        }, svgIcon(ICONS.download, 18), 'Download converted document'),
        h('button', {
          class: 'btn secondary block',
          onclick: async () => {
            const ok = await copyText(c.text);
            if (ok) { vibrate(); toast('Converted document copied'); }
            else showClipboardFallback(c.text);
          },
        }, 'Copy converted document'),
      ),
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

    renderLookupSection(host, c);
  }
}

/** Filename for the converted document: the original name, "-markers.txt". */
function convertedFilename(): string {
  const base = (doc?.name ?? 'document').replace(/\.[^.]+$/, '');
  return `${base}-markers.txt`;
}

/* ------------------------------------------------------------------ */
/* Online lookup — find unknown sources on Zotero and add them         */
/* ------------------------------------------------------------------ */

/** The unmatched citations worth searching Zotero for (missing, not ambiguous). */
function lookupTargets(c: ConversionResult): UnmatchedCitation[] {
  return c.unmatched.filter((u) => u.reason === 'no-match' && !!u.query);
}

async function runLookup(c: ConversionResult): Promise<void> {
  const targets = lookupTargets(c);
  if (targets.length === 0 || lookupLoading) return;
  if (!state.online) {
    lookupError = 'Looking up sources needs an internet connection — try again once you’re back online.';
    notify();
    return;
  }
  lookupLoading = true;
  lookupError = null;
  notify();
  try {
    const results: Lookup[] = [];
    for (const citation of targets) {
      results.push({ citation, found: await lookupOnlineSources(citation.query!) });
    }
    lookups = results;
  } catch (err) {
    lookupError = err instanceof ZoteroApiError
      ? err.message
      : 'Couldn’t search Zotero. Check your connection and try again.';
  } finally {
    lookupLoading = false;
    notify();
  }
}

/** A found candidate row: the source, plus an Add / Added button. */
function foundRow(item: CachedItem): HTMLElement {
  const who = item.creatorsDisplay || item.title;
  const added = addedFound.has(item.id);
  const action = added
    ? h('span', { class: 'lookup-added' }, '✓ Added')
    : h('button', {
        class: 'btn small',
        onclick: async () => {
          addedFound.add(item.id); // mark before the re-render addFoundSources triggers
          await addFoundSources([item]);
          toast(`Added ${who}`);
        },
      }, 'Add');
  return h('li', { class: 'doc-item lookup-found-item' },
    h('div', { class: 'lookup-found-body' },
      h('span', { class: 'row-who' }, who, ' ', h('span', { class: 'year' }, `(${item.year ?? 'n.d.'})`)),
      h('span', { class: 'row-title' }, item.title)),
    action);
}

/** One unknown citation paired with the candidates found on Zotero. */
function lookupPair(l: Lookup): HTMLElement {
  const foundList = l.found.length > 0
    ? h('ul', { class: 'results doc-list lookup-found-list' }, ...l.found.map(foundRow))
    : h('p', { class: 'lookup-none' }, 'No match on Zotero — the source may not be in your library at all.');

  return h('div', { class: 'lookup-pair' },
    h('div', { class: 'lookup-unknown' },
      h('span', { class: 'lookup-label' }, 'In your document'),
      h('span', { class: 'lookup-unknown-text' }, l.citation.original)),
    h('div', { class: 'lookup-results' },
      h('span', { class: 'lookup-label' }, l.found.length > 0 ? 'Found on Zotero' : 'Not found'),
      foundList),
  );
}

function renderLookupSection(host: HTMLElement, c: ConversionResult): void {
  const targets = lookupTargets(c);
  if (targets.length === 0) return;

  if (lookupError) {
    host.append(h('p', { class: 'doc-file-error', role: 'alert' }, lookupError));
  }

  // Not searched yet: offer the lookup button.
  if (!lookups) {
    host.append(
      h('p', { class: 'lookup-intro' },
        'Some of these sources may be in your Zotero library but not synced to this device yet. Search Zotero online for them, then add the right ones.'),
      h('button', {
        class: 'btn secondary block',
        disabled: lookupLoading || undefined,
        onclick: () => void runLookup(c),
      }, lookupLoading
        ? 'Searching Zotero…'
        : `Look up ${targets.length} unknown source${targets.length === 1 ? '' : 's'} on Zotero`),
    );
    return;
  }

  // Searched: show the found candidates beside each unknown citation.
  const addable = new Map<string, CachedItem>();
  for (const l of lookups) for (const item of l.found) if (!addedFound.has(item.id)) addable.set(item.id, item);
  const addableItems = [...addable.values()];

  host.append(
    h('h2', {}, 'Look up on Zotero'),
    h('p', {}, 'Check each match against the citation in your document, then add the ones that are right — individually, or all at once. Added sources join your library and bibliography, so re-running “Convert” will turn them into markers.'),
    ...lookups.map(lookupPair),
  );

  if (addableItems.length > 0) {
    host.append(
      h('button', {
        class: 'btn block',
        onclick: async () => {
          for (const item of addableItems) addedFound.add(item.id); // mark before re-render
          const n = await addFoundSources(addableItems);
          toast(`Added ${n} source${n === 1 ? '' : 's'}`);
        },
      }, `Add all ${addableItems.length} found source${addableItems.length === 1 ? '' : 's'}`),
    );
  } else {
    host.append(h('p', { class: 'doc-ok' }, '✓ Added the sources you picked — re-run “Convert citations” to insert their markers.'));
  }
}

function rescan(): ScanReport {
  return scanDocument({
    text: doc?.text ?? '',
    items: state.items,
    bibliographyIds: state.bibliography.map((e) => e.id),
  });
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function renderDocument(root: HTMLElement): void {
  root.replaceChildren();

  // Upload a .docx/.odt/.txt file. The file is parsed in-browser
  // (lib/docimport) and its text kept in module state; the file itself is
  // never uploaded or stored.
  let uploadBtn: HTMLButtonElement;
  const fileInput = h('input', {
    type: 'file',
    accept: ACCEPTED_DOC_TYPES,
    class: 'visually-hidden',
    'aria-hidden': 'true',
    tabindex: '-1',
    onchange: async (e: Event) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = ''; // let the same file be re-picked later
      if (!file) return;
      uploadBtn.setAttribute('disabled', '');
      uploadBtn.textContent = 'Reading…';
      resetResults();
      try {
        const imported = await readDocumentFile(file);
        if (!imported.text.trim()) {
          fileError = `“${imported.name}” looks empty — no text to scan.`;
        } else {
          doc = { text: imported.text, name: imported.name };
          toast(`Loaded ${imported.name}`);
        }
      } catch (err) {
        fileError = err instanceof DocImportError
          ? err.message
          : 'Couldn’t read that file — try another format.';
      }
      notify(); // re-render: shows the loaded-document card (or the error)
    },
  }) as HTMLInputElement;

  uploadBtn = h('button', {
    class: 'btn secondary block',
    onclick: () => fileInput.click(),
  }, svgIcon(ICONS.upload, 18), doc ? 'Upload a different document' : 'Upload document (.docx, .odt, .txt)') as HTMLButtonElement;

  // The visible "a document is loaded" state: file name, size, and a way to
  // clear it. Everything below acts on this document.
  const loadedCard = doc
    ? h('div', { class: 'doc-loaded', role: 'status' },
        svgIcon(ICONS.doc, 20),
        h('div', { class: 'doc-loaded-info' },
          h('span', { class: 'doc-loaded-name' }, doc.name),
          h('span', { class: 'doc-loaded-meta' }, `${wordCount(doc.text).toLocaleString()} words · ready to scan`)),
        h('button', {
          class: 'doc-loaded-remove',
          'aria-label': 'Remove document',
          onclick: () => { doc = null; resetResults(); notify(); },
        }, svgIcon(ICONS.x, 18)))
    : h('p', { class: 'doc-empty-hint' },
        'No document loaded yet — upload your draft to scan it. It’s read locally on this device, never uploaded.');

  const scanBtn = h('button', {
    class: 'btn block',
    disabled: !doc,
    onclick: () => {
      if (!doc) return;
      conversion = null;
      fileError = null;
      resetLookup();
      report = rescan();
      notify();
    },
  }, 'Scan document');

  const convertBtn = h('button', {
    class: 'btn secondary block',
    disabled: !doc,
    onclick: () => {
      if (!doc) return;
      report = null;
      fileError = null;
      resetLookup();
      conversion = convertCitations({
        text: doc.text,
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
    h('button', { class: 'back-btn', onclick: () => { resetResults(); navigate('picker'); }, 'aria-label': 'Back to search' },
      svgIcon(ICONS.back, 18), 'Back'),
    h('h1', {}, 'Scan document'),
    h('p', {},
      h('strong', {}, 'Scan document'),
      ' reads the markers already in a draft and checks them against your bibliography list. ',
      h('strong', {}, 'Convert citations'),
      ' turns plain-text citations like (Meier, 2021) into markers so the desktop ODF-Scan pass and the reference list pick them up.'),
    h('div', { class: 'doc-upload' }, uploadBtn, fileInput),
    fileError ? h('p', { class: 'doc-file-error', role: 'alert' }, fileError) : null,
    loadedCard,
    h('div', { class: 'doc-actions' }, scanBtn, convertBtn),
    results,
  );
  root.append(page);
}
