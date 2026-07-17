import type { CachedItem, LibraryRef, Settings } from './lib/types';
import { buildIndex, type IndexedEntry } from './lib/search';
import * as db from './lib/db';
import { syncLibrary, listGroups, searchItems, createItems, ZoteroApiError, type SyncProgress } from './lib/zotero';
import { searchCrossref, crossrefToZoteroItem, type CrossrefWork } from './lib/crossref';

/**
 * Central app state. Deliberately simple: one mutable store, screens
 * re-render themselves from it. No framework required at this size.
 */

export type Screen = 'picker' | 'onboarding' | 'settings' | 'bibliography' | 'document';

export interface AppState {
  screen: Screen;
  settings: Settings;
  items: Map<string, CachedItem>;
  index: IndexedEntry[];
  recents: db.RecentEntry[];
  bibliography: db.BibliographyEntry[];
  tray: string[]; // item ids in the multi-cite tray
  syncing: boolean;
  syncProgress: SyncProgress | null;
  syncError: string | null;
  lastSync: db.SyncMeta | null;
  online: boolean;
}

export const state: AppState = {
  screen: 'picker',
  settings: null as unknown as Settings,
  items: new Map(),
  index: [],
  recents: [],
  bibliography: [],
  tray: [],
  syncing: false,
  syncProgress: null,
  syncError: null,
  lastSync: null,
  online: navigator.onLine,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(): void {
  for (const fn of listeners) fn();
}

export function navigate(screen: Screen): void {
  state.screen = screen;
  notify();
}

/* ---------------- data loading ---------------- */

export async function loadFromCache(): Promise<void> {
  const [settings, items, recents, bibliography, lastSync] = await Promise.all([
    db.getSettings(),
    db.getAllItems(),
    db.getRecents(),
    db.getBibliographyItems(),
    db.getSyncMeta(),
  ]);
  state.settings = settings;
  state.items = new Map(items.map((i) => [i.id, i]));
  state.index = buildIndex(items);
  state.recents = recents;
  state.bibliography = bibliography;
  state.lastSync = lastSync ?? null;
  state.screen = settings.onboarded ? 'picker' : 'onboarding';
}

export async function refreshItemsFromDb(): Promise<void> {
  const items = await db.getAllItems();
  state.items = new Map(items.map((i) => [i.id, i]));
  state.index = buildIndex(items);
}

export async function markCited(itemIdValue: string): Promise<void> {
  await Promise.all([db.touchRecent(itemIdValue), db.addToBibliography(itemIdValue)]);
  const [recents, bibliography] = await Promise.all([db.getRecents(), db.getBibliographyItems()]);
  state.recents = recents;
  state.bibliography = bibliography;
  notify();
}

/* ---------------- bibliography list (manual curation) ---------------- */

export async function addToBibliographyList(itemIdValue: string): Promise<void> {
  await db.addToBibliography(itemIdValue);
  state.bibliography = await db.getBibliographyItems();
  notify();
}

/** Add several items at once (document scan → reconcile the bibliography). */
export async function addManyToBibliographyList(itemIdValues: string[]): Promise<number> {
  const inBib = new Set(state.bibliography.map((e) => e.id));
  const toAdd = itemIdValues.filter((id) => !inBib.has(id));
  await Promise.all(toAdd.map((id) => db.addToBibliography(id)));
  state.bibliography = await db.getBibliographyItems();
  notify();
  return toAdd.length;
}

export async function removeFromBibliographyList(itemIdValue: string): Promise<void> {
  await db.removeFromBibliography(itemIdValue);
  state.bibliography = await db.getBibliographyItems();
  notify();
}

export async function clearBibliographyList(): Promise<void> {
  await db.clearBibliography();
  state.bibliography = [];
  notify();
}

/* ---------------- online source lookup (document scan) ---------------- */

/**
 * Search the online Zotero library for a source the local cache doesn't have
 * yet — e.g. a citation in a draft that was added to Zotero after the last
 * sync. Searches the personal library, plus any groups when group-sync is on,
 * and returns de-duplicated matches. Returns [] (rather than throwing) when
 * there's nothing to search with; genuine request failures propagate.
 */
export async function lookupOnlineSources(query: string): Promise<CachedItem[]> {
  const { apiKey, userId, syncGroups } = state.settings;
  if (!apiKey || !userId || !query.trim()) return [];

  const libraries: LibraryRef[] = [{ type: 'user', id: userId }];
  if (syncGroups) {
    try {
      for (const g of await listGroups(apiKey, userId)) libraries.push({ type: 'group', id: g.id });
    } catch {
      /* fall back to just the personal library */
    }
  }

  const seen = new Set<string>();
  const out: CachedItem[] = [];
  for (const library of libraries) {
    for (const hit of await searchItems(apiKey, library, query)) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      out.push(hit);
    }
  }
  return out;
}

/**
 * Fall back to Crossref for a citation that isn't in the Zotero library at all.
 * Read-only identification: Crossref works have no Zotero item key, so they
 * can't be added as markers here — the UI shows the match and its DOI so the
 * writer can add it to Zotero and re-sync. Only the "Surname Year" string is
 * sent to Crossref, never the API key or the document. Returns [] offline.
 */
export async function lookupCrossrefSources(query: string): Promise<CrossrefWork[]> {
  if (!state.online || !query.trim()) return [];
  return searchCrossref(query);
}

/**
 * Create a Zotero item from a Crossref work in the user's personal library,
 * then cache it and add it to the bibliography — so it resolves like any synced
 * source and a re-run Convert turns it into a marker. Needs a write-enabled key
 * (a read-only key throws a clear ZoteroApiError, surfaced by the caller).
 * Returns the newly-created cached item.
 */
export async function addCrossrefToZotero(w: CrossrefWork): Promise<CachedItem> {
  const { apiKey, userId } = state.settings;
  if (!apiKey || !userId) throw new ZoteroApiError('forbidden', 'Connect Zotero in Settings first.');
  const library: LibraryRef = { type: 'user', id: userId };
  const [created] = await createItems(apiKey, library, [crossrefToZoteroItem(w)]);
  await db.idbItemStore.putItems([created]);
  await db.addToBibliography(created.id);
  await refreshItemsFromDb();
  state.bibliography = await db.getBibliographyItems();
  notify();
  return created;
}

/**
 * Persist sources discovered via online lookup: cache them in the local
 * library (so future scans/conversions resolve them) and add them to the
 * bibliography list. Returns how many were stored.
 */
export async function addFoundSources(items: CachedItem[]): Promise<number> {
  if (items.length === 0) return 0;
  await db.idbItemStore.putItems(items);
  await Promise.all(items.map((i) => db.addToBibliography(i.id)));
  await refreshItemsFromDb();
  state.bibliography = await db.getBibliographyItems();
  notify();
  return items.length;
}

/* ---------------- sync orchestration ---------------- */

export async function runSync(): Promise<void> {
  const { apiKey, userId, syncGroups } = state.settings;
  if (!apiKey || !userId || state.syncing) return;
  state.syncing = true;
  state.syncError = null;
  state.syncProgress = null;
  notify();
  try {
    const opts = {
      apiKey,
      onProgress: (p: SyncProgress) => {
        state.syncProgress = p;
        notify();
      },
    };
    await syncLibrary(db.idbItemStore, { type: 'user', id: userId }, opts);
    if (syncGroups) {
      const groups = await listGroups(apiKey, userId);
      for (const g of groups) {
        await syncLibrary(db.idbItemStore, { type: 'group', id: g.id }, opts);
      }
    }
    await refreshItemsFromDb();
    const meta = { lastSyncAt: Date.now(), itemCount: state.items.size };
    await db.setSyncMeta(meta);
    state.lastSync = meta;
  } catch (err) {
    state.syncError = err instanceof Error ? err.message : 'Sync failed.';
  } finally {
    state.syncing = false;
    state.syncProgress = null;
    notify();
  }
}

/* ---------------- connectivity ---------------- */

window.addEventListener('online', () => { state.online = true; notify(); });
window.addEventListener('offline', () => { state.online = false; notify(); });
