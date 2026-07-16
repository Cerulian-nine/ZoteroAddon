import { openDB, type IDBPDatabase } from 'idb';
import type { CachedItem, LibraryRef, Settings } from './types';
import { DEFAULT_SETTINGS } from './types';
import type { ItemStore } from './zotero';

/**
 * Local persistence. Everything lives on-device in IndexedDB:
 *   items    — the cached library (keyed by composite id)
 *   meta     — settings, per-library sync versions, last-sync info
 *   recents  — recently copied items (small, capped)
 *
 * The API key never leaves this database except in requests to
 * api.zotero.org.
 */

const DB_NAME = 'citepocket';
const DB_VERSION = 1;
const RECENTS_CAP = 15;

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        d.createObjectStore('items', { keyPath: 'id' });
        d.createObjectStore('meta');
        d.createObjectStore('recents', { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
}

/* ---------------- items ---------------- */

export async function getAllItems(): Promise<CachedItem[]> {
  return (await db()).getAll('items');
}

export async function getItem(id: string): Promise<CachedItem | undefined> {
  return (await db()).get('items', id);
}

export async function clearItems(): Promise<void> {
  await (await db()).clear('items');
}

/* ---------------- meta / settings ---------------- */

export async function getSettings(): Promise<Settings> {
  const stored = await (await db()).get('meta', 'settings');
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await (await db()).put('meta', next, 'settings');
  return next;
}

export interface SyncMeta {
  lastSyncAt: number; // epoch ms
  itemCount: number;
}

export async function getSyncMeta(): Promise<SyncMeta | undefined> {
  return (await db()).get('meta', 'syncMeta');
}

export async function setSyncMeta(meta: SyncMeta): Promise<void> {
  await (await db()).put('meta', meta, 'syncMeta');
}

function versionKey(library: LibraryRef): string {
  return `version:${library.type}:${library.id}`;
}

/** ItemStore implementation backed by IndexedDB, used by the sync engine. */
export const idbItemStore: ItemStore = {
  async putItems(items: CachedItem[]) {
    const d = await db();
    const tx = d.transaction('items', 'readwrite');
    for (const item of items) tx.store.put(item);
    await tx.done;
  },
  async deleteItems(ids: string[]) {
    const d = await db();
    const tx = d.transaction('items', 'readwrite');
    for (const id of ids) tx.store.delete(id);
    await tx.done;
  },
  async getLibraryVersion(library: LibraryRef) {
    const v = await (await db()).get('meta', versionKey(library));
    return typeof v === 'number' ? v : null;
  },
  async setLibraryVersion(library: LibraryRef, version: number) {
    await (await db()).put('meta', version, versionKey(library));
  },
};

/* ---------------- recents ---------------- */

export interface RecentEntry {
  id: string; // item id
  copiedAt: number;
}

export async function getRecents(): Promise<RecentEntry[]> {
  const all: RecentEntry[] = await (await db()).getAll('recents');
  return all.sort((a, b) => b.copiedAt - a.copiedAt).slice(0, RECENTS_CAP);
}

export async function touchRecent(itemIdValue: string): Promise<void> {
  const d = await db();
  await d.put('recents', { id: itemIdValue, copiedAt: Date.now() } satisfies RecentEntry);
  // Trim beyond the cap.
  const all: RecentEntry[] = await d.getAll('recents');
  if (all.length > RECENTS_CAP) {
    all.sort((a, b) => b.copiedAt - a.copiedAt);
    const tx = d.transaction('recents', 'readwrite');
    for (const stale of all.slice(RECENTS_CAP)) tx.store.delete(stale.id);
    await tx.done;
  }
}

/* ---------------- full reset ---------------- */

export async function resetAllData(): Promise<void> {
  const d = await db();
  await Promise.all([d.clear('items'), d.clear('meta'), d.clear('recents')]);
}
