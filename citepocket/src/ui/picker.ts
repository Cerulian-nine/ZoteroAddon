import { state, navigate, markCited, notify } from '../app';
import type { CachedItem } from '../lib/types';
import { search } from '../lib/search';
import { formatMarker, formatMultiMarker } from '../lib/marker';
import { copyText, vibrate } from '../lib/clipboard';
import { h, toast, svgIcon, ICONS, showClipboardFallback } from './dom';

/**
 * Screen 1 — the Picker. 95% of usage: open, type, tap, paste.
 * Search is debounced at 80ms over the in-memory index; the empty state
 * shows "Recently cited".
 */

let query = '';
let expandedId: string | null = null;
let debounceTimer: number | undefined;
/** Snapshot of an open locator field, taken before a re-render. */
let restoreLocator: { value: string; hadFocus: boolean } | null = null;
const LONG_PRESS_MS = 450;

async function copyForItem(item: CachedItem, locator?: string): Promise<void> {
  const text = formatMarker(item, {
    format: state.settings.format,
    locator,
    citekeyPattern: state.settings.citekeyPattern,
  });
  const ok = await copyText(text);
  if (ok) {
    vibrate();
    toast('Copied — paste into your doc');
  } else {
    showClipboardFallback(text);
  }
  expandedId = null;
  await markCited(item.id); // also re-renders via notify()
}

async function copyTray(): Promise<void> {
  const items = state.tray
    .map((id) => state.items.get(id))
    .filter((i): i is CachedItem => !!i);
  if (items.length === 0) return;
  const text = formatMultiMarker(items, {
    format: state.settings.format,
    citekeyPattern: state.settings.citekeyPattern,
  });
  const ok = await copyText(text);
  if (ok) {
    vibrate();
    toast(`Copied ${items.length} citations — paste into your doc`);
  } else {
    showClipboardFallback(text);
  }
  for (const item of items) await markCited(item.id);
  state.tray = [];
  notify();
}

function toggleTray(item: CachedItem): void {
  const idx = state.tray.indexOf(item.id);
  if (idx >= 0) state.tray.splice(idx, 1);
  else state.tray.push(item.id);
  vibrate();
  notify();
}

/* ---------------- row ---------------- */

function renderRow(item: CachedItem): HTMLElement {
  const isExpanded = expandedId === item.id;
  const isRecent = state.recents.some((r) => r.id === item.id);
  const who = item.creatorsDisplay || item.title;
  const label = `${who}, ${item.year ?? 'no date'} — ${item.title}`;

  // Long-press adds to the multi-cite tray.
  let pressTimer: number | undefined;
  let longPressed = false;

  const body = h(
    'button',
    {
      class: 'row-body',
      'aria-expanded': String(isExpanded),
      'aria-label': `${label}. Tap to add a page number.`,
      onclick: () => {
        if (longPressed) { longPressed = false; return; }
        expandedId = isExpanded ? null : item.id;
        notify();
      },
      onpointerdown: () => {
        longPressed = false;
        pressTimer = window.setTimeout(() => {
          longPressed = true;
          toggleTray(item);
        }, LONG_PRESS_MS);
      },
      onpointerup: () => window.clearTimeout(pressTimer),
      onpointerleave: () => window.clearTimeout(pressTimer),
      oncontextmenu: (e: Event) => e.preventDefault(),
    },
    h('span', { class: 'row-who' }, who, ' ', h('span', { class: 'year' }, `(${item.year ?? 'n.d.'})`)),
    h('span', { class: 'row-title' }, item.title),
  );

  const inTray = state.tray.includes(item.id);
  const trayBtn = h(
    'button',
    {
      class: 'icon-btn',
      'aria-label': inTray ? `Remove ${who} from multi-cite tray` : `Add ${who} to multi-cite tray`,
      'aria-pressed': String(inTray),
      onclick: () => toggleTray(item),
    },
    svgIcon(inTray ? ICONS.x : ICONS.plus, 20),
  );

  const copyBtn = h(
    'button',
    {
      class: 'icon-btn copy',
      'aria-label': `Copy citation for ${who} ${item.year ?? ''}`,
      onclick: () => void copyForItem(item),
    },
    svgIcon(ICONS.copy),
  );

  const row = h(
    'li',
    { class: `row${isRecent ? ' cited' : ''}` },
    h('div', { class: 'row-main' }, body, h('div', { class: 'row-actions' }, trayBtn, copyBtn)),
  );

  if (isExpanded) {
    const input = h('input', {
      class: 'locator-input',
      type: 'text',
      inputmode: 'numeric',
      placeholder: 'p. 44–46',
      'aria-label': 'Page number or locator',
      onkeydown: (e: Event) => {
        if ((e as KeyboardEvent).key === 'Enter') void copyForItem(item, input.value);
      },
    }) as HTMLInputElement;
    const copy = h('button', { class: 'btn', onclick: () => void copyForItem(item, input.value) }, 'Copy');
    row.append(h('div', { class: 'row-expand' }, input, copy));
    if (restoreLocator) {
      // Re-render while the panel was already open: keep what was typed,
      // only re-take focus if the field had it.
      input.value = restoreLocator.value;
      if (restoreLocator.hadFocus) {
        queueMicrotask(() => {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        });
      }
    } else {
      // Newly expanded: move focus straight to the page-number field.
      queueMicrotask(() => input.focus());
    }
  }

  return row;
}

/* ---------------- screen ---------------- */

export function renderPicker(root: HTMLElement): void {
  // Full re-renders happen on any state change (sync progress, tray, …).
  // Capture the live search input state first so typing is never disturbed.
  const prevInput = root.querySelector<HTMLInputElement>('.search-input');
  const liveValue = prevInput?.value ?? query;
  const hadFocus = prevInput !== null && document.activeElement === prevInput;
  const selStart = prevInput?.selectionStart ?? null;
  const selEnd = prevInput?.selectionEnd ?? null;

  // Same for an open locator field.
  const prevLocator = root.querySelector<HTMLInputElement>('.locator-input');
  restoreLocator = prevLocator
    ? { value: prevLocator.value, hadFocus: document.activeElement === prevLocator }
    : null;

  root.replaceChildren();

  /* top bar */
  const input = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: 'Search author, year, title…',
    autocomplete: 'off',
    autocapitalize: 'off',
    'aria-label': 'Search your Zotero library',
    oninput: (e: Event) => {
      const value = (e.target as HTMLInputElement).value;
      wrap.classList.toggle('has-text', value.length > 0);
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        query = value;
        expandedId = null;
        renderList();
      }, 80);
    },
  }) as HTMLInputElement;
  input.value = liveValue;

  const clearBtn = h(
    'button',
    {
      class: 'search-clear',
      'aria-label': 'Clear search',
      onclick: () => {
        query = '';
        input.value = '';
        wrap.classList.remove('has-text');
        renderList();
        input.focus();
      },
    },
    svgIcon(ICONS.x, 18),
  );

  const wrap = h('div', { class: `search-wrap${liveValue ? ' has-text' : ''}` }, input, clearBtn);
  const gear = h(
    'button',
    { class: 'gear-btn', 'aria-label': 'Settings', onclick: () => navigate('settings') },
    svgIcon(ICONS.gear),
  );
  root.append(h('div', { class: 'topbar' }, wrap, gear));

  /* status strip */
  const status = h('div', { class: 'status-strip', 'aria-live': 'polite' });
  if (state.syncing) {
    status.classList.add('syncing');
    const p = state.syncProgress;
    const detail = p && p.total ? ` ${Math.min(p.fetched, p.total)} / ${p.total}` : '…';
    status.append(h('span', { class: 'status-dot' }), `Syncing library${detail}`);
  } else if (!state.online && state.lastSync) {
    status.append(
      h('span', { class: 'status-dot' }),
      `Offline — library from ${new Date(state.lastSync.lastSyncAt).toLocaleDateString()}`,
    );
  } else if (state.syncError) {
    status.append(h('span', { class: 'status-dot' }), `Sync failed — using cached library. ${state.syncError}`);
  }
  root.append(status);

  /* list */
  const listContainer = h('div');
  root.append(listContainer);

  function renderList(): void {
    listContainer.replaceChildren();
    if (query.trim()) {
      const results = search(state.index, query);
      if (results.length === 0) {
        listContainer.append(
          h('p', { class: 'empty' }, h('strong', {}, 'No matches'), ' — try an author last name or year.'),
        );
      } else {
        const ul = h('ul', { class: 'results' });
        for (const item of results) ul.append(renderRow(item));
        listContainer.append(ul);
      }
    } else {
      const recents = state.recents
        .map((r) => state.items.get(r.id))
        .filter((i): i is CachedItem => !!i);
      if (recents.length > 0) {
        listContainer.append(h('div', { class: 'section-label' }, 'Recently cited'));
        const ul = h('ul', { class: 'results' });
        for (const item of recents) ul.append(renderRow(item));
        listContainer.append(ul);
      } else if (state.items.size === 0) {
        listContainer.append(
          h('p', { class: 'empty' },
            state.syncing ? 'Your library is syncing…' : 'Your library is empty. Open Settings to sync it.'),
        );
      } else {
        listContainer.append(
          h('p', { class: 'empty' }, `Search ${state.items.size.toLocaleString()} items in your library.`),
        );
      }
    }
  }
  renderList();

  /* multi-cite tray */
  if (state.tray.length > 0) {
    root.append(
      h(
        'div',
        { class: 'tray', role: 'region', 'aria-label': 'Multi-cite tray' },
        h('span', { class: 'tray-count' }, `${state.tray.length} in tray`),
        h('button', { class: 'btn', onclick: () => void copyTray() }, 'Copy all'),
        h(
          'button',
          { class: 'icon-btn', 'aria-label': 'Clear tray', onclick: () => { state.tray = []; notify(); } },
          svgIcon(ICONS.x, 20),
        ),
      ),
    );
  }

  // Focus handling: on a fresh mount (opening the app / returning from
  // Settings) auto-focus the search box — the whole point of the app. On
  // re-renders, restore focus and caret only if the user was typing there,
  // and never steal focus from an inline locator field.
  const shouldFocus = prevInput === null ? !expandedId : hadFocus;
  if (shouldFocus) {
    queueMicrotask(() => {
      input.focus();
      if (selStart !== null && selEnd !== null) {
        try { input.setSelectionRange(selStart, selEnd); } catch { /* type=search quirks */ }
      }
    });
  }
}
