import { state, notify, runSync, navigate } from '../app';
import { saveSettings } from '../lib/db';
import { validateKey, ZoteroApiError } from '../lib/zotero';
import { formatMarker } from '../lib/marker';
import type { CachedItem, OutputFormat } from '../lib/types';
import { copyText, vibrate } from '../lib/clipboard';
import { h, toast, markerChip, showClipboardFallback } from './dom';

/** Screen 2 — first-run onboarding: connect, choose workflow, trust the loop. */

let step = 1;
let draftKey = '';
let draftUserId = '';
let draftWrite = false;
let draftFormat: OutputFormat = 'odf-scan';
let busy = false;
let error = '';

const SAMPLE_ITEM: CachedItem = {
  id: 'u:0:SAMPLE01',
  itemKey: 'SAMPLE01',
  library: { type: 'user', id: 0 },
  itemType: 'journalArticle',
  title: 'A sample article to try the loop',
  creatorsDisplay: 'Meier',
  creatorLastNames: ['meier'],
  year: 2021,
  publicationTitle: 'Journal of Trying Things',
  dateModified: '',
};

function stepConnect(): HTMLElement {
  const keyInput = h('input', {
    type: 'password', autocomplete: 'off', 'aria-label': 'Zotero API key',
    oninput: (e: Event) => { draftKey = (e.target as HTMLInputElement).value.trim(); },
  }) as HTMLInputElement;
  keyInput.value = draftKey;

  const idInput = h('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off', 'aria-label': 'Zotero user ID',
    oninput: (e: Event) => { draftUserId = (e.target as HTMLInputElement).value.trim(); },
  }) as HTMLInputElement;
  idInput.value = draftUserId;

  const errorEl = h('p', { class: 'field-error', role: 'alert' }, error);
  const continueBtn = h(
    'button',
    {
      class: 'btn block',
      onclick: async () => {
        if (busy) return;
        busy = true;
        error = '';
        continueBtn.textContent = 'Checking with Zotero…';
        (continueBtn as HTMLButtonElement).disabled = true;
        try {
          const info = await validateKey(draftKey);
          draftWrite = info.write;
          // Trust Zotero's answer for the user ID; fill it in if left blank.
          if (!draftUserId) draftUserId = String(info.userID);
          else if (String(info.userID) !== draftUserId) {
            draftUserId = String(info.userID);
            toast('User ID corrected from your key');
          }
          step = 2;
        } catch (err) {
          error = err instanceof ZoteroApiError ? err.message : 'Something went wrong. Try again.';
        } finally {
          busy = false;
          notify();
        }
      },
    },
    'Continue',
  ) as HTMLButtonElement;

  return h(
    'div',
    {},
    h('span', { class: 'step-eyebrow' }, 'Step 1 of 3'),
    h('h1', {}, 'Connect Zotero'),
    h('p', {}, 'CitePocket reads your library straight from Zotero. Create a key at ',
      h('a', { href: 'https://www.zotero.org/settings/keys', target: '_blank', rel: 'noopener' }, 'zotero.org/settings/keys'),
      ' — ', h('strong', {}, 'read-only is all it needs to cite'), '. Tick ', h('strong', {}, '“Allow write access”'),
      ' too if you’d like CitePocket to add sources it finds online (via Crossref) straight into your Zotero library.'),
    h('div', { class: 'field' }, h('label', {}, 'API key'), keyInput,
      h('p', { class: 'hint' }, 'Stored only on this device. Sent only to api.zotero.org.')),
    h('div', { class: 'field' }, h('label', {}, 'User ID (optional)'), idInput,
      h('p', { class: 'hint' }, 'Shown on the same page, under "Your userID for use in API calls". Leave blank and we\u2019ll read it from your key.')),
    errorEl,
    continueBtn,
  );
}

const FORMAT_CARDS: { format: OutputFormat; title: string; desc: string }[] = [
  {
    format: 'odf-scan',
    title: 'Google Docs + desktop conversion (recommended)',
    desc: 'Copies a marker like { | Meier, (2021) | | |zu:…} that Zotero turns into a live citation later.',
  },
  {
    format: 'pandoc',
    title: 'Markdown / Pandoc',
    desc: 'Copies a citekey like [@meier2021] for Markdown writing with Pandoc.',
  },
  {
    format: 'plain',
    title: 'Plain text',
    desc: 'Copies a finished-looking citation like (Meier, 2021) that you manage by hand.',
  },
];

function stepWorkflow(): HTMLElement {
  const cards = FORMAT_CARDS.map((c) =>
    h(
      'button',
      {
        class: `choice-card${draftFormat === c.format ? ' selected' : ''}`,
        'aria-pressed': String(draftFormat === c.format),
        onclick: () => { draftFormat = c.format; notify(); },
      },
      h('span', { class: 'card-title' }, c.title),
      h('span', { class: 'card-desc' }, c.desc),
    ),
  );
  return h(
    'div',
    {},
    h('span', { class: 'step-eyebrow' }, 'Step 2 of 3'),
    h('h1', {}, 'Choose your workflow'),
    h('p', {}, 'This decides what lands on your clipboard. You can change it any time in Settings.'),
    ...cards,
    h('button', { class: 'btn block', onclick: () => { step = 3; notify(); } }, 'Continue'),
  );
}

function stepRoundtrip(): HTMLElement {
  const before = formatMarker(SAMPLE_ITEM, { format: 'odf-scan' });
  const testMarker = formatMarker(SAMPLE_ITEM, { format: draftFormat, citekeyPattern: '[auth][year]' });
  return h(
    'div',
    {},
    h('span', { class: 'step-eyebrow' }, 'Step 3 of 3'),
    h('h1', {}, 'Trust the roundtrip'),
    h('p', {}, 'Markers are plain text — completely harmless in your document. You write on the tablet, and later, on a desktop with Zotero and the ',
      h('a', { href: 'https://zotero-odf-scan.github.io/zotero-odf-scan/', target: '_blank', rel: 'noopener' }, 'RTF/ODF-Scan plugin'),
      ', one conversion pass turns every marker into a live citation and builds your bibliography.'),
    h('div', { class: 'roundtrip' },
      h('p', {}, h('strong', {}, 'In your doc while writing:')),
      markerChip(before),
      h('div', { class: 'roundtrip-arrow' }, '↓ desktop conversion ↓'),
      h('p', {}, h('strong', {}, 'After conversion:')),
      h('p', {}, '(Meier, 2021) — plus "Meier, A. (2021). A sample article… " in the bibliography.'),
    ),
    h(
      'button',
      {
        class: 'btn secondary block',
        onclick: async () => {
          const ok = await copyText(testMarker);
          if (ok) { vibrate(); toast('Test marker copied — try pasting it anywhere'); }
          else showClipboardFallback(testMarker);
        },
      },
      'Copy a test marker',
    ),
    h('div', { style: 'height:10px' }),
    h(
      'button',
      {
        class: 'btn block',
        onclick: async () => {
          state.settings = await saveSettings({
            apiKey: draftKey,
            userId: Number(draftUserId),
            format: draftFormat,
            writeAccess: draftWrite,
            onboarded: true,
          });
          draftKey = '';
          navigate('picker');
          void runSync();
        },
      },
      'Finish & sync my library',
    ),
  );
}

export function renderOnboarding(root: HTMLElement): void {
  root.replaceChildren();
  const page = h('div', { class: 'page' });
  if (step === 1) page.append(stepConnect());
  else if (step === 2) page.append(stepWorkflow());
  else page.append(stepRoundtrip());
  root.append(page);
}
