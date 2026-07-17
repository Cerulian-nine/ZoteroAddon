import { state, notify, navigate, runSync, clearCitedList } from '../app';
import { saveSettings, resetAllData } from '../lib/db';
import { validateKey, ZoteroApiError } from '../lib/zotero';
import type { OutputFormat } from '../lib/types';
import { h, toast, svgIcon, ICONS } from './dom';
import { copyBibliographyAction } from './copyBib';

/** Citation styles offered for the "Copy bibliography" feature (CSL short-names). */
const CITATION_STYLES: { id: string; label: string }[] = [
  { id: 'apa', label: 'APA (7th edition)' },
  { id: 'modern-language-association', label: 'MLA (9th edition)' },
  { id: 'chicago-note-bibliography', label: 'Chicago (note, bibliography)' },
  { id: 'chicago-author-date', label: 'Chicago (author-date)' },
  { id: 'harvard-cite-them-right', label: 'Harvard (Cite Them Right)' },
  { id: 'vancouver', label: 'Vancouver' },
  { id: 'ieee', label: 'IEEE' },
];

/** Screen 3 — Settings. Deliberately minimal, per the spec. */

let credError = '';

export function renderSettings(root: HTMLElement): void {
  root.replaceChildren();
  const s = state.settings;

  /* credentials */
  const keyInput = h('input', { type: 'password', 'aria-label': 'Zotero API key', autocomplete: 'off' }) as HTMLInputElement;
  keyInput.value = s.apiKey;
  const idInput = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Zotero user ID', autocomplete: 'off' }) as HTMLInputElement;
  idInput.value = s.userId ? String(s.userId) : '';
  const credErrorEl = h('p', { class: 'field-error', role: 'alert' }, credError);

  const saveCreds = h(
    'button',
    {
      class: 'btn secondary block',
      onclick: async () => {
        credError = '';
        saveCreds.textContent = 'Validating…';
        (saveCreds as HTMLButtonElement).disabled = true;
        try {
          const info = await validateKey(keyInput.value.trim());
          state.settings = await saveSettings({
            apiKey: keyInput.value.trim(),
            userId: Number(idInput.value.trim()) || info.userID,
          });
          toast('Zotero connection updated');
        } catch (err) {
          credError = err instanceof ZoteroApiError ? err.message : 'Validation failed.';
        }
        notify();
      },
    },
    'Validate & save',
  ) as HTMLButtonElement;

  /* format */
  const formats: { format: OutputFormat; label: string }[] = [
    { format: 'odf-scan', label: 'ODF-Scan marker (Google Docs + desktop conversion)' },
    { format: 'pandoc', label: 'Pandoc citekey — [@meier2021]' },
    { format: 'plain', label: 'Plain text — (Meier, 2021)' },
  ];
  const formatCards = formats.map((f) =>
    h(
      'button',
      {
        class: `choice-card${s.format === f.format ? ' selected' : ''}`,
        'aria-pressed': String(s.format === f.format),
        onclick: async () => {
          state.settings = await saveSettings({ format: f.format });
          notify();
        },
      },
      h('span', { class: 'card-title' }, f.label),
    ),
  );

  /* citekey pattern */
  const patternInput = h('input', {
    type: 'text', 'aria-label': 'Citekey pattern', autocomplete: 'off',
    onchange: async (e: Event) => {
      state.settings = await saveSettings({ citekeyPattern: (e.target as HTMLInputElement).value || '[auth][year]' });
      toast('Citekey pattern saved');
    },
  }) as HTMLInputElement;
  patternInput.value = s.citekeyPattern;

  /* citation style (for Copy bibliography) */
  const styleSelect = h('select', {
    class: 'select', 'aria-label': 'Citation style for the bibliography',
    onchange: async (e: Event) => {
      state.settings = await saveSettings({ citationStyle: (e.target as HTMLSelectElement).value });
      toast('Citation style saved');
    },
  }) as HTMLSelectElement;
  const known = CITATION_STYLES.some((st) => st.id === s.citationStyle);
  for (const st of CITATION_STYLES) {
    styleSelect.append(h('option', { value: st.id }, st.label));
  }
  // Preserve a style a user may have set that isn't in our shortlist.
  if (!known && s.citationStyle) {
    styleSelect.append(h('option', { value: s.citationStyle }, s.citationStyle));
  }
  styleSelect.value = s.citationStyle;

  const citedCount = state.cited.length;
  const copyBibBtn = h(
    'button',
    {
      class: 'btn secondary block',
      disabled: citedCount === 0 || undefined,
      onclick: () => void copyBibliographyAction(),
    },
    citedCount === 0 ? 'Copy bibliography' : `Copy bibliography (${citedCount} item${citedCount === 1 ? '' : 's'})`,
  );

  const clearCitedBtn = h(
    'button',
    {
      class: 'btn danger block',
      disabled: citedCount === 0 || undefined,
      onclick: async () => {
        if (!confirm('Clear the current document’s cited items and start fresh?')) return;
        await clearCitedList();
        toast('Cited list cleared');
      },
    },
    'Clear cited list',
  );

  /* groups toggle */
  const groupsCheckbox = h('input', {
    type: 'checkbox', id: 'sync-groups',
    onchange: async (e: Event) => {
      state.settings = await saveSettings({ syncGroups: (e.target as HTMLInputElement).checked });
      notify();
    },
  }) as HTMLInputElement;
  groupsCheckbox.checked = s.syncGroups;

  /* sync */
  const lastSyncText = state.lastSync
    ? `Last synced ${new Date(state.lastSync.lastSyncAt).toLocaleString()} — ${state.lastSync.itemCount.toLocaleString()} items cached.`
    : 'Not synced yet.';

  const page = h(
    'div',
    { class: 'page' },
    h('button', { class: 'back-btn', onclick: () => navigate('picker'), 'aria-label': 'Back to search' },
      svgIcon(ICONS.back, 18), 'Back'),
    h('h1', {}, 'Settings'),

    h('h2', {}, 'Zotero connection'),
    h('p', {}, 'A read-only key is all CitePocket needs. It stays on this device.'),
    h('div', { class: 'field' }, h('label', {}, 'API key'), keyInput),
    h('div', { class: 'field' }, h('label', {}, 'User ID'), idInput),
    credErrorEl,
    saveCreds,

    h('h2', {}, 'Copy format'),
    ...formatCards,
    s.format === 'pandoc'
      ? h('div', { class: 'field' },
          h('label', {}, 'Citekey pattern'),
          patternInput,
          h('p', { class: 'hint' },
            'Tokens: [auth] [Auth] [year] [shorttitle]. This is a best-effort match — make sure it mirrors your Better BibTeX key format, or Pandoc won\u2019t find the entries.'))
      : null,

    h('h2', {}, 'Group libraries'),
    h('label', { class: 'check-row', for: 'sync-groups' }, groupsCheckbox, 'Also sync group libraries this key can access'),

    h('h2', {}, 'Bibliography'),
    h('p', {}, 'Build a finished, styled reference list from the items you’ve cited in the current document — rendered by Zotero, no desktop conversion needed. Needs a connection.'),
    h('div', { class: 'field' }, h('label', {}, 'Citation style'), styleSelect),
    copyBibBtn,
    citedCount === 0
      ? h('p', { class: 'settings-meta' }, 'No cited items yet — copy a citation to start building one.')
      : clearCitedBtn,

    h('h2', {}, 'Library'),
    h('p', { class: 'settings-meta' }, lastSyncText),
    h(
      'button',
      {
        class: 'btn secondary block',
        disabled: state.syncing || undefined,
        onclick: () => void runSync(),
      },
      state.syncing ? 'Syncing…' : 'Re-sync library now',
    ),

    h('h2', {}, 'Data'),
    h('p', {}, 'Removes the cached library, recents, and your API key from this device.'),
    h(
      'button',
      {
        class: 'btn danger block',
        onclick: async () => {
          if (!confirm('Delete all local CitePocket data, including your API key?')) return;
          await resetAllData();
          location.reload();
        },
      },
      'Reset all local data',
    ),
  );
  root.append(page);
}
