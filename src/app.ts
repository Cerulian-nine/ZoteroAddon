import type { CachedItem, Settings } from './lib/types';
import { buildIndex, type IndexedEntry } from './lib/search';
import * as db from './lib/db';
import { syncLibrary, listGroups, ZoteroApiError, type SyncProgress } from './lib/zotero';
import { fetchBibliography, type Bibliography } from './lib/bibliography';

/**
 * Central app state. Deliberately simple: one mutable store, screens
 * re-render themselves from it. No framework required at this size.
 */

export type Screen = 'picker' | 'onboarding' | 'settings';

export interface AppState {
  screen: Screen;
  settings: Settings;
  items: Map<string, CachedItem>;
  index: IndexedEntry[];
  recents: db.RecentEntry[];
  cited: db.CitedEntry[]; // the current document's running cited-items list
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
  cited: [],
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
  const [settings, items, recents, cited, lastSync] = await Promise.all([
    db.getSettings(),
    db.getAllItems(),
    db.getRecents(),
    db.getCited(),
    db.getSyncMeta(),
  ]);
  state.settings = settings;
  state.items = new Map(items.map((i) => [i.id, i]));
  state.index = buildIndex(items);
  state.recents = recents;
  state.cited = cited;
  state.lastSync = lastSync ?? null;
  state.screen = settings.onboarded ? 'picker' : 'onboarding';
}

export async function refreshItemsFromDb(): Promise<void> {
  const items = await db.getAllItems();
  state.items = new Map(items.map((i) => [i.id, i]));
  state.index = buildIndex(items);
}

export async function markCited(itemIdValue: string): Promise<void> {
  // A copy both bumps the capped "recents" list and appends to the running
  // cited-items list that feeds "Copy bibliography".
  await Promise.all([db.touchRecent(itemIdValue), db.addCited(itemIdValue)]);
  [state.recents, state.cited] = await Promise.all([db.getRecents(), db.getCited()]);
  notify();
}

/* ---------------- bibliography ---------------- */

/** Resolve the cited-items list to cached items, in document order. */
export function citedItems(): CachedItem[] {
  return state.cited
    .map((c) => state.items.get(c.id))
    .filter((i): i is CachedItem => !!i);
}

/**
 * Build a finished, styled reference list for the current document's cited
 * items via the Zotero Web API. This is the one deliberately-online feature;
 * it fails with a clear message rather than crashing when offline or on error.
 */
export async function buildBibliography(): Promise<Bibliography> {
  const items = citedItems();
  if (items.length === 0) {
    throw new Error('No cited items yet — copy a citation first.');
  }
  const { apiKey, citationStyle } = state.settings;
  if (!apiKey) {
    throw new Error('Add your Zotero API key in Settings to build a bibliography.');
  }
  if (!state.online) {
    throw new Error('You’re offline. Reconnect to build a bibliography.');
  }
  try {
    return await fetchBibliography(items, { apiKey, style: citationStyle });
  } catch (err) {
    if (err instanceof ZoteroApiError) throw err;
    // Network / fetch rejection — surface a friendly, actionable message.
    throw new Error('Could not reach Zotero. Check your connection and try again.');
  }
}

/** Start a fresh document: clear the running cited-items list. */
export async function clearCitedList(): Promise<void> {
  await db.clearCited();
  state.cited = await db.getCited();
  notify();
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
