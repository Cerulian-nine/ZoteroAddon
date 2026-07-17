import { state, navigate, notify, addToBibliographyList, removeFromBibliographyList, clearBibliographyList } from '../app';
import type { CachedItem } from '../lib/types';
import { search } from '../lib/search';
import { saveSettings } from '../lib/db';
import { CITATION_STYLES, fetchBibliography } from '../lib/bibliography';
import { ZoteroApiError } from '../lib/zotero';
import { copyHtml, vibrate } from '../lib/clipboard';
import { h, toast, svgIcon, ICONS, showClipboardFallback } from './dom';

/**
 * Screen 4 — Bibliography. Builds a full, correctly styled reference list
 * from items you've cited (or added by hand) and copies it as rich text —
 * the "skip the desktop ODF-Scan step" path. Unlike marker copying this
 * needs a network round-trip: the style rendering happens on Zotero's end.
 */

const CUSTOM_STYLE = '__custom__';

let addQuery = '';
let addOpen = false;
let generating = false;
let genError = '';
/** Sticky override: once the user picks "Custom style ID…" in the dropdown,
 *  keep the text field visible even before they've typed (and saved)
 *  anything — the saved style alone can't tell us that's what they chose. */
let forceCustomField = false;

async function copyBibliography(): Promise<void> {
  if (generating) return;
  const items = state.bibliography
    .map((e) => state.items.get(e.id))
    .filter((i): i is CachedItem => !!i);
  if (items.length === 0) return;
  if (!state.online) {
    genError = 'Generating needs an internet connection — try again once you’re back online.';
    notify();
    return;
  }
  generating = true;
  genError = '';
  notify();
  try {
    const rendered = await fetchBibliography(items, state.settings.bibliographyStyle, state.settings.apiKey);
    const ok = await copyHtml(rendered.html, rendered.plainText);
    if (ok) {
      vibrate();
      toast(`Copied ${rendered.count} ${rendered.count === 1 ? 'reference' : 'references'} — paste into your doc`);
    } else {
      showClipboardFallback(rendered.plainText);
    }
  } catch (err) {
    genError = err instanceof ZoteroApiError ? err.message : 'Could not generate the bibliography. Try again.';
  } finally {
    generating = false;
    notify();
  }
}

function bibRow(item: CachedItem, action: HTMLElement): HTMLElement {
  const who = item.creatorsDisplay || item.title;
  return h(
    'li',
    { class: 'row bib-row' },
    h(
      'div',
      { class: 'row-main' },
      h(
        'div',
        { class: 'row-body' },
        h('span', { class: 'row-who' }, who, ' ', h('span', { class: 'year' }, `(${item.year ?? 'n.d.'})`)),
        h('span', { class: 'row-title' }, item.title),
      ),
      h('div', { class: 'row-actions' }, action),
    ),
  );
}

function renderBibRow(item: CachedItem): HTMLElement {
  const who = item.creatorsDisplay || item.title;
  return bibRow(
    item,
    h(
      'button',
      { class: 'icon-btn', 'aria-label': `Remove ${who} from bibliography`, onclick: () => void removeFromBibliographyList(item.id) },
      svgIcon(ICONS.x, 20),
    ),
  );
}

function renderAddRow(item: CachedItem): HTMLElement {
  const who = item.creatorsDisplay || item.title;
  return bibRow(
    item,
    h(
      'button',
      { class: 'icon-btn', 'aria-label': `Add ${who} to bibliography`, onclick: () => void addToBibliographyList(item.id) },
      svgIcon(ICONS.plus, 20),
    ),
  );
}

export function renderBibliography(root: HTMLElement): void {
  root.replaceChildren();
  const s = state.settings;
  const inBib = new Set(state.bibliography.map((e) => e.id));
  const items = state.bibliography
    .map((e) => state.items.get(e.id))
    .filter((i): i is CachedItem => !!i);

  /* ---------------- style picker ---------------- */
  const isCurated = CITATION_STYLES.some((c) => c.id === s.bibliographyStyle);
  const showCustomField = forceCustomField || !isCurated;
  const styleSelect = h('select', {
    'aria-label': 'Citation style',
    onchange: async (e: Event) => {
      const value = (e.target as HTMLSelectElement).value;
      if (value === CUSTOM_STYLE) { forceCustomField = true; notify(); return; } // reveal the custom field; nothing to save yet
      forceCustomField = false;
      state.settings = await saveSettings({ bibliographyStyle: value });
      notify();
    },
  }) as HTMLSelectElement;
  for (const style of CITATION_STYLES) {
    styleSelect.append(
      h('option', { value: style.id, ...(s.bibliographyStyle === style.id ? { selected: true } : {}) }, style.label),
    );
  }
  styleSelect.append(h('option', { value: CUSTOM_STYLE, ...(showCustomField ? { selected: true } : {}) }, 'Custom style ID…'));

  const customInput = h('input', {
    type: 'text',
    'aria-label': 'Custom CSL style ID',
    placeholder: 'e.g. chicago-fullnote-bibliography',
    autocomplete: 'off',
    onchange: async (e: Event) => {
      const value = (e.target as HTMLInputElement).value.trim();
      if (!value) return;
      forceCustomField = false;
      state.settings = await saveSettings({ bibliographyStyle: value });
      toast('Citation style saved');
    },
  }) as HTMLInputElement;
  if (!isCurated) customInput.value = s.bibliographyStyle;

  const styleField = h(
    'div',
    { class: 'field' },
    h('label', {}, 'Citation style'),
    styleSelect,
    showCustomField
      ? h(
          'div',
          { style: 'margin-top:8px' },
          customInput,
          h('p', { class: 'hint' }, 'Any style ID from the ',
            h('a', { href: 'https://www.zotero.org/styles', target: '_blank', rel: 'noopener' }, 'Zotero style repository'), '.'),
        )
      : null,
  );

  /* ---------------- add source ---------------- */
  const addInput = h('input', {
    type: 'search',
    placeholder: 'Search to add a source…',
    'aria-label': 'Search your library to add a source',
    autocomplete: 'off',
    oninput: (e: Event) => { addQuery = (e.target as HTMLInputElement).value; renderAddResults(); },
  }) as HTMLInputElement;
  addInput.value = addQuery;

  const addResults = h('ul', { class: 'results' });
  function renderAddResults(): void {
    addResults.replaceChildren();
    if (!addQuery.trim()) return;
    const hits = search(state.index, addQuery).filter((i) => !inBib.has(i.id)).slice(0, 8);
    for (const hit of hits) addResults.append(renderAddRow(hit));
  }

  const addToggle = h(
    'button',
    { class: 'btn secondary block', onclick: () => { addOpen = !addOpen; notify(); } },
    addOpen ? 'Close' : '+ Add a source manually',
  );
  const addPanel = addOpen ? h('div', { class: 'add-source' }, addInput, addResults) : null;
  if (addOpen) queueMicrotask(() => { renderAddResults(); addInput.focus(); });

  /* ---------------- list ---------------- */
  const listSection: HTMLElement = items.length === 0
    ? h('p', { class: 'empty' }, h('strong', {}, 'No sources yet'), ' — copy a citation from the picker, or add one below.')
    : h('ul', { class: 'results bib-list' }, ...items.map(renderBibRow));

  /* ---------------- page ---------------- */
  const page = h(
    'div',
    { class: 'page' },
    h('button', { class: 'back-btn', onclick: () => navigate('picker'), 'aria-label': 'Back to search' },
      svgIcon(ICONS.back, 18), 'Back'),
    h('h1', {}, 'Bibliography'),
    h('p', {}, 'Renders a complete, correctly formatted reference list from your Zotero data and copies it straight to your clipboard — no desktop conversion step needed.'),
    styleField,
    h('h2', {}, `Your sources (${items.length})`),
    genError ? h('p', { class: 'field-error', role: 'alert' }, genError) : null,
    listSection,
    addToggle,
    addPanel,
  );
  root.append(page);

  /* ---------------- copy bar ---------------- */
  if (items.length > 0) {
    root.append(
      h(
        'div',
        { class: 'tray bib-copy-bar', role: 'region', 'aria-label': 'Copy bibliography' },
        h('span', { class: 'tray-count' }, `${items.length} source${items.length === 1 ? '' : 's'}`),
        h(
          'button',
          { class: 'btn', disabled: generating || undefined, onclick: () => void copyBibliography() },
          generating ? 'Generating…' : 'Copy bibliography',
        ),
        h(
          'button',
          {
            class: 'icon-btn',
            'aria-label': 'Clear bibliography list',
            onclick: async () => {
              if (!confirm('Clear all sources from the bibliography list?')) return;
              await clearBibliographyList();
            },
          },
          svgIcon(ICONS.x, 20),
        ),
      ),
    );
  }
}
