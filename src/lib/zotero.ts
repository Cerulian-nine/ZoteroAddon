import type { CachedItem, LibraryRef, ZoteroCreator } from './types';
import { itemId } from './types';
import { creatorsDisplay, creatorLastNames, parseYear } from './creators';

/**
 * Zotero Web API v3 client + sync engine.
 * Docs: https://www.zotero.org/support/dev/web_api/v3/basics
 *       https://www.zotero.org/support/dev/web_api/v3/syncing
 *
 * Design notes:
 *  - `fetch` and the item store are injected so the sync logic (pagination,
 *    ?since= increments, Backoff/Retry-After handling, deletions) is testable
 *    without a browser or network.
 *  - We request `/items/top?itemType=-attachment`: `/top` excludes child
 *    notes/attachments/annotations, and the single negation (documented
 *    search syntax) excludes standalone attachments server-side. Standalone
 *    notes are then filtered client-side — chaining multiple negations with
 *    `||` is OR semantics in Zotero's search syntax and would not do what it
 *    appears to.
 */

export const API_BASE = 'https://api.zotero.org';
const PAGE_SIZE = 100;
const EXCLUDED_TYPES = new Set(['attachment', 'note', 'annotation']);

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ItemStore {
  putItems(items: CachedItem[]): Promise<void>;
  deleteItems(ids: string[]): Promise<void>;
  getLibraryVersion(library: LibraryRef): Promise<number | null>;
  setLibraryVersion(library: LibraryRef, version: number): Promise<void>;
}

export interface SyncProgress {
  library: LibraryRef;
  fetched: number;
  total: number | null;
}

export interface SyncOptions {
  apiKey: string;
  fetchFn?: FetchLike;
  onProgress?: (p: SyncProgress) => void;
  /** Test hook: replaces real waiting during backoff. */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface SyncResult {
  library: LibraryRef;
  added: number;
  removed: number;
  version: number;
  /** True when the library was already up to date (304). */
  unchanged: boolean;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Rate-limit aware request wrapper                                    */
/* ------------------------------------------------------------------ */

/**
 * Perform one API GET, honoring Backoff and Retry-After headers.
 * Retries 429/503 up to `maxRetries` times; propagates other statuses.
 */
let pendingBackoffMs = 0;

export async function apiGet(
  url: string,
  apiKey: string,
  fetchFn: FetchLike,
  sleepFn: (ms: number) => Promise<void> = realSleep,
  maxRetries = 3,
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    // Honor a Backoff requested by any previous response before hitting the
    // API again (module-level so it spans sequential paginated requests).
    if (pendingBackoffMs > 0) {
      const ms = pendingBackoffMs;
      pendingBackoffMs = 0;
      await sleepFn(ms);
    }

    const res = await fetchFn(url, {
      headers: {
        'Zotero-API-Version': '3',
        'Zotero-API-Key': apiKey,
      },
    });

    // Server asks clients to slow down (can come on ANY response, incl. 200).
    const backoff = res.headers.get('Backoff');
    if (backoff && Number(backoff) > 0) {
      pendingBackoffMs = Number(backoff) * 1000;
    }

    if (res.status === 429 || res.status === 503) {
      if (attempt >= maxRetries) return res;
      const retryAfter = Number(res.headers.get('Retry-After') || '0');
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
      attempt++;
      await sleepFn(waitMs);
      continue;
    }

    return res;
  }
}

/* ------------------------------------------------------------------ */
/* Item parsing                                                        */
/* ------------------------------------------------------------------ */

interface ApiItem {
  key: string;
  version: number;
  data: {
    key: string;
    itemType: string;
    title?: string;
    creators?: ZoteroCreator[];
    date?: string;
    publicationTitle?: string;
    bookTitle?: string;
    proceedingsTitle?: string;
    dateModified?: string;
  };
}

export function parseApiItem(raw: ApiItem, library: LibraryRef): CachedItem | null {
  const d = raw.data;
  if (!d || EXCLUDED_TYPES.has(d.itemType)) return null;
  return {
    id: itemId(library, raw.key),
    itemKey: raw.key,
    library,
    itemType: d.itemType,
    title: d.title || '(untitled)',
    creatorsDisplay: creatorsDisplay(d.creators),
    creatorLastNames: creatorLastNames(d.creators),
    year: parseYear(d.date),
    publicationTitle: d.publicationTitle || d.bookTitle || d.proceedingsTitle || '',
    dateModified: d.dateModified || '',
  };
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

function libraryPrefix(library: LibraryRef): string {
  return library.type === 'user' ? `/users/${library.id}` : `/groups/${library.id}`;
}

/**
 * Full or incremental sync of one library into the store.
 * - First run (no stored version): pages through the whole library.
 * - Later runs: `?since={version}` fetches only changed items, plus
 *   `/deleted?since=` to remove deletions.
 */
export async function syncLibrary(store: ItemStore, library: LibraryRef, opts: SyncOptions): Promise<SyncResult> {
  const fetchFn = opts.fetchFn ?? ((u, i) => fetch(u, i));
  const sleepFn = opts.sleepFn ?? realSleep;
  const prefix = libraryPrefix(library);
  const sinceVersion = await store.getLibraryVersion(library);

  let start = 0;
  let total: number | null = null;
  let added = 0;
  let removed = 0;
  let latestVersion = sinceVersion ?? 0;

  for (;;) {
    const params = new URLSearchParams({
      itemType: '-attachment',
      limit: String(PAGE_SIZE),
      start: String(start),
      sort: 'dateModified',
    });
    if (sinceVersion !== null) params.set('since', String(sinceVersion));

    const res = await apiGet(`${API_BASE}${prefix}/items/top?${params}`, opts.apiKey, fetchFn, sleepFn);

    if (res.status === 304) {
      return { library, added: 0, removed: 0, version: sinceVersion ?? 0, unchanged: true };
    }
    if (res.status === 403) throw new ZoteroApiError('forbidden', 'API key is invalid or lacks access to this library.');
    if (!res.ok) throw new ZoteroApiError('http', `Zotero API returned ${res.status}.`, res.status);

    const lmv = res.headers.get('Last-Modified-Version');
    if (lmv) latestVersion = Number(lmv);
    const totalHeader = res.headers.get('Total-Results');
    if (totalHeader !== null) total = Number(totalHeader);

    const page = (await res.json()) as ApiItem[];
    const parsed = page.map((r) => parseApiItem(r, library)).filter((x): x is CachedItem => x !== null);
    if (parsed.length > 0) await store.putItems(parsed);
    added += parsed.length;

    start += page.length;
    opts.onProgress?.({ library, fetched: start, total });

    const done = page.length < PAGE_SIZE || (total !== null && start >= total);
    if (done) break;
  }

  // Incremental runs must also apply deletions.
  if (sinceVersion !== null) {
    const res = await apiGet(`${API_BASE}${prefix}/deleted?since=${sinceVersion}`, opts.apiKey, fetchFn, sleepFn);
    if (res.ok) {
      const deleted = (await res.json()) as { items?: string[] };
      const ids = (deleted.items ?? []).map((k) => itemId(library, k));
      if (ids.length > 0) {
        await store.deleteItems(ids);
        removed = ids.length;
      }
    }
  }

  await store.setLibraryVersion(library, latestVersion);
  return { library, added, removed, version: latestVersion, unchanged: false };
}

/* ------------------------------------------------------------------ */
/* Key validation & groups                                             */
/* ------------------------------------------------------------------ */

export class ZoteroApiError extends Error {
  constructor(public kind: 'forbidden' | 'network' | 'http', message: string, public status?: number) {
    super(message);
  }
}

export interface KeyInfo {
  userID: number;
  username: string;
  /** Whether the key may write to the personal library (`access.user.write`). */
  write: boolean;
}

/**
 * Validate an API key via GET /keys/current (returns the key's owner and
 * privileges). Also used during onboarding to confirm the user ID and to learn
 * whether the key can write (which enables one-tap "Add to Zotero").
 */
export async function validateKey(apiKey: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<KeyInfo> {
  let res: Response;
  try {
    res = await apiGet(`${API_BASE}/keys/current`, apiKey, fetchFn);
  } catch {
    throw new ZoteroApiError('network', 'Could not reach api.zotero.org. Check your connection and try again.');
  }
  if (res.status === 403 || res.status === 404) {
    throw new ZoteroApiError('forbidden', 'Zotero did not accept this API key. Check it and try again.');
  }
  if (!res.ok) throw new ZoteroApiError('http', `Zotero API returned ${res.status}.`, res.status);
  const info = (await res.json()) as {
    userID: number;
    username?: string;
    access?: { user?: { write?: boolean } };
  };
  return { userID: info.userID, username: info.username ?? '', write: !!info.access?.user?.write };
}

/* ------------------------------------------------------------------ */
/* Item creation (write)                                               */
/* ------------------------------------------------------------------ */

/** A Zotero item payload for creation — `itemType` plus its fields/creators. */
export type NewItem = Record<string, unknown> & { itemType: string };

/**
 * Create items in a library via `POST /items` and return the parsed, cached
 * shape for the ones Zotero accepted (with their new item keys). This is the
 * only write the app makes, and only ever on an explicit user action: it needs
 * a key with write access (a read-only key gets a clear 403 message).
 * Docs: https://www.zotero.org/support/dev/web_api/v3/write_requests
 */
export async function createItems(
  apiKey: string,
  library: LibraryRef,
  items: NewItem[],
  fetchFn: FetchLike = (u, i) => fetch(u, i),
): Promise<CachedItem[]> {
  if (items.length === 0) return [];
  const prefix = libraryPrefix(library);
  let res: Response;
  try {
    res = await fetchFn(`${API_BASE}${prefix}/items`, {
      method: 'POST',
      headers: {
        'Zotero-API-Version': '3',
        'Zotero-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(items),
    });
  } catch {
    throw new ZoteroApiError('network', 'Could not reach api.zotero.org. Check your connection and try again.');
  }
  if (res.status === 403) {
    throw new ZoteroApiError(
      'forbidden',
      'This API key can’t write to your Zotero library. Create a key with “Allow write access” ticked at zotero.org/settings/keys, then save it in Settings.',
    );
  }
  if (!res.ok) throw new ZoteroApiError('http', `Zotero API returned ${res.status}.`, res.status);

  const body = (await res.json()) as {
    successful?: Record<string, ApiItem>;
    failed?: Record<string, { code: number; message: string }>;
  };
  const created: CachedItem[] = [];
  for (const raw of Object.values(body.successful ?? {})) {
    const parsed = parseApiItem(raw, library);
    if (parsed) created.push(parsed);
  }
  if (created.length === 0) {
    const failure = Object.values(body.failed ?? {})[0];
    throw new ZoteroApiError('http', failure ? `Zotero rejected the item: ${failure.message}` : 'Zotero didn’t create the item.');
  }
  return created;
}

/**
 * Quick-search one library online via the Web API. Uses `qmode=titleCreatorYear`
 * so a "Surname Year" query hits the creator and date fields (not just the
 * title), which is exactly what an author-year citation gives us. Returns
 * parsed top-level items; non-2xx statuses raise a ZoteroApiError so the caller
 * can tell "nothing found" apart from "the request failed".
 *
 * This is the online counterpart to the offline `search()` index: it exists to
 * find a source that the local cache doesn't have yet (added to Zotero since
 * the last sync), so it can be pulled in and cited.
 */
export async function searchItems(
  apiKey: string,
  library: LibraryRef,
  query: string,
  fetchFn: FetchLike = (u, i) => fetch(u, i),
  limit = 8,
): Promise<CachedItem[]> {
  const prefix = libraryPrefix(library);
  const params = new URLSearchParams({
    q: query,
    qmode: 'titleCreatorYear',
    itemType: '-attachment',
    limit: String(limit),
    sort: 'dateModified',
  });
  const res = await apiGet(`${API_BASE}${prefix}/items/top?${params}`, apiKey, fetchFn);
  if (res.status === 403) throw new ZoteroApiError('forbidden', 'API key is invalid or lacks access to this library.');
  if (!res.ok) throw new ZoteroApiError('http', `Zotero API returned ${res.status}.`, res.status);
  const page = (await res.json()) as ApiItem[];
  return page.map((r) => parseApiItem(r, library)).filter((x): x is CachedItem => x !== null);
}

export interface GroupInfo {
  id: number;
  name: string;
}

/** Groups the key can access: GET /users/{userID}/groups */
export async function listGroups(
  apiKey: string,
  userId: number,
  fetchFn: FetchLike = (u, i) => fetch(u, i),
): Promise<GroupInfo[]> {
  const res = await apiGet(`${API_BASE}/users/${userId}/groups`, apiKey, fetchFn);
  if (!res.ok) return [];
  const groups = (await res.json()) as { id: number; data?: { name?: string } }[];
  return groups.map((g) => ({ id: g.id, name: g.data?.name ?? `Group ${g.id}` }));
}
