import type { CachedItem, Settings } from './lib/types';
import { buildIndex, type IndexedEntry } from './lib/search';
import * as db from './lib/db';
import { syncLibrary, listGroups, type SyncProgress } from './lib/zotero';

/**
 * Central app state. Deliberately simple: one mutable store, screens
 * re-render themselves from it. No framework required at this size.
 */

export type Screen = 'picker' | 'onboarding' | 'settings' | 'bibliography';

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
