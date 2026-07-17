import { describe, it, expect } from 'vitest';
import { syncLibrary, searchItems, apiGet, type ItemStore, type FetchLike } from '../src/lib/zotero';
import type { CachedItem, LibraryRef } from '../src/lib/types';

/* ---------------- helpers ---------------- */

function memoryStore() {
  const items = new Map<string, CachedItem>();
  const versions = new Map<string, number>();
  const store: ItemStore = {
    async putItems(batch) { for (const i of batch) items.set(i.id, i); },
    async deleteItems(ids) { for (const id of ids) items.delete(id); },
    async getLibraryVersion(lib) { return versions.get(`${lib.type}:${lib.id}`) ?? null; },
    async setLibraryVersion(lib, v) { versions.set(`${lib.type}:${lib.id}`, v); },
  };
  return { store, items, versions };
}

function apiItem(key: string, title: string, author: string, year: number) {
  return {
    key,
    version: 1,
    data: {
      key,
      itemType: 'journalArticle',
      title,
      creators: [{ creatorType: 'author', firstName: 'A.', lastName: author }],
      date: String(year),
      dateModified: `${year}-01-01T00:00:00Z`,
    },
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const USER_LIB: LibraryRef = { type: 'user', id: 42 };
const noSleep = async () => {};

/* ---------------- tests ---------------- */

describe('syncLibrary — full sync with pagination', () => {
  it('follows start offsets until Total-Results is reached', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => apiItem(`KEY${i}`, `Paper ${i}`, `Author${i}`, 2000 + (i % 20)));
    const page2 = Array.from({ length: 50 }, (_, i) => apiItem(`KEY${100 + i}`, `Paper ${100 + i}`, `Author${100 + i}`, 2010));
    const requests: string[] = [];

    const fetchFn: FetchLike = async (url) => {
      requests.push(url);
      const u = new URL(url);
      const start = Number(u.searchParams.get('start'));
      const body = start === 0 ? page1 : page2;
      return jsonResponse(body, { 'Total-Results': '150', 'Last-Modified-Version': '500' });
    };

    const { store, items } = memoryStore();
    const result = await syncLibrary(store, USER_LIB, { apiKey: 'k', fetchFn, sleepFn: noSleep });

    expect(items.size).toBe(150);
    expect(result.added).toBe(150);
    expect(result.version).toBe(500);
    expect(result.unchanged).toBe(false);
    expect(requests.length).toBe(2);
    expect(requests[0]).toContain('/users/42/items/top');
    expect(requests[0]).toContain('itemType=-attachment');
    expect(requests[0]).toContain('start=0');
    expect(requests[1]).toContain('start=100');
    // Full sync must not send ?since=
    expect(requests[0]).not.toContain('since=');
  });

  it('sends the required API headers', async () => {
    let headers: Record<string, string> = {};
    const fetchFn: FetchLike = async (_url, init) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse([], { 'Total-Results': '0', 'Last-Modified-Version': '1' });
    };
    const { store } = memoryStore();
    await syncLibrary(store, USER_LIB, { apiKey: 'secret-key', fetchFn, sleepFn: noSleep });
    expect(headers['Zotero-API-Version']).toBe('3');
    expect(headers['Zotero-API-Key']).toBe('secret-key');
  });

  it('filters standalone notes client-side', async () => {
    const note = { key: 'NOTE1', version: 1, data: { key: 'NOTE1', itemType: 'note' } };
    const fetchFn: FetchLike = async () =>
      jsonResponse([apiItem('REAL1', 'Real', 'Author', 2020), note], {
        'Total-Results': '2',
        'Last-Modified-Version': '10',
      });
    const { store, items } = memoryStore();
    await syncLibrary(store, USER_LIB, { apiKey: 'k', fetchFn, sleepFn: noSleep });
    expect(items.size).toBe(1);
    expect([...items.values()][0].itemKey).toBe('REAL1');
  });

  it('reports progress', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse([apiItem('A1', 'T', 'X', 2020)], { 'Total-Results': '1', 'Last-Modified-Version': '2' });
    const { store } = memoryStore();
    const progress: { fetched: number; total: number | null }[] = [];
    await syncLibrary(store, USER_LIB, {
      apiKey: 'k', fetchFn, sleepFn: noSleep,
      onProgress: (p) => progress.push({ fetched: p.fetched, total: p.total }),
    });
    expect(progress).toEqual([{ fetched: 1, total: 1 }]);
  });
});

describe('syncLibrary — incremental sync', () => {
  it('sends ?since={version} and applies deletions', async () => {
    const requests: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      requests.push(url);
      if (url.includes('/deleted')) {
        return jsonResponse({ items: ['GONE1'], collections: [] });
      }
      return jsonResponse([apiItem('NEW1', 'New Paper', 'Neu', 2026)], {
        'Total-Results': '1',
        'Last-Modified-Version': '600',
      });
    };

    const { store, items } = memoryStore();
    // Simulate a prior sync at version 500 with one item that will be deleted.
    await store.setLibraryVersion(USER_LIB, 500);
    await store.putItems([
      {
        id: 'u:42:GONE1', itemKey: 'GONE1', library: USER_LIB, itemType: 'book',
        title: 'Old', creatorsDisplay: 'Alt', creatorLastNames: ['alt'],
        year: 1990, publicationTitle: '', dateModified: '',
      },
    ]);

    const result = await syncLibrary(store, USER_LIB, { apiKey: 'k', fetchFn, sleepFn: noSleep });

    expect(requests[0]).toContain('since=500');
    expect(requests.some((u) => u.includes('/deleted?since=500'))).toBe(true);
    expect(items.has('u:42:GONE1')).toBe(false);
    expect(items.has('u:42:NEW1')).toBe(true);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.version).toBe(600);
  });

  it('treats 304 Not Modified as up-to-date and cheap', async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls++;
      return new Response(null, { status: 304 });
    };
    const { store } = memoryStore();
    await store.setLibraryVersion(USER_LIB, 500);
    const result = await syncLibrary(store, USER_LIB, { apiKey: 'k', fetchFn, sleepFn: noSleep });
    expect(result.unchanged).toBe(true);
    expect(result.version).toBe(500);
    expect(calls).toBe(1); // no /deleted call needed
  });

  it('throws a friendly error on 403', async () => {
    const fetchFn: FetchLike = async () => new Response('Forbidden', { status: 403 });
    const { store } = memoryStore();
    await expect(syncLibrary(store, USER_LIB, { apiKey: 'bad', fetchFn, sleepFn: noSleep })).rejects.toThrow(
      /API key/,
    );
  });

  it('uses zg-style ids for group libraries', async () => {
    const fetchFn: FetchLike = async (url) => {
      expect(url).toContain('/groups/77/items/top');
      return jsonResponse([apiItem('G1', 'Group Paper', 'Grp', 2022)], {
        'Total-Results': '1',
        'Last-Modified-Version': '9',
      });
    };
    const { store, items } = memoryStore();
    await syncLibrary(store, { type: 'group', id: 77 }, { apiKey: 'k', fetchFn, sleepFn: noSleep });
    expect(items.has('g:77:G1')).toBe(true);
  });
});

describe('searchItems — online quick search', () => {
  it('queries titleCreatorYear and returns parsed items', async () => {
    let requested = '';
    const fetchFn: FetchLike = async (url) => {
      requested = url;
      return jsonResponse([apiItem('FOUND1', 'A Found Paper', 'Nobody', 1999)]);
    };
    const items = await searchItems('k', USER_LIB, 'Nobody 1999', fetchFn);
    expect(requested).toContain('/users/42/items/top');
    expect(requested).toContain('qmode=titleCreatorYear');
    expect(requested).toContain('q=Nobody+1999');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('u:42:FOUND1');
    expect(items[0].creatorLastNames).toEqual(['nobody']);
  });

  it('throws a friendly error on 403', async () => {
    const fetchFn: FetchLike = async () => new Response('Forbidden', { status: 403 });
    await expect(searchItems('bad', USER_LIB, 'x 2000', fetchFn)).rejects.toThrow(/API key/);
  });

  it('searches group libraries with the group prefix', async () => {
    const fetchFn: FetchLike = async (url) => {
      expect(url).toContain('/groups/77/items/top');
      return jsonResponse([apiItem('G9', 'Group Find', 'Grp', 2022)]);
    };
    const items = await searchItems('k', { type: 'group', id: 77 }, 'Grp 2022', fetchFn);
    expect(items[0].id).toBe('g:77:G9');
  });
});

describe('apiGet — rate limiting', () => {
  it('retries 429 after Retry-After seconds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '2' } });
      return jsonResponse([]);
    };
    const res = await apiGet('https://api.zotero.org/x', 'k', fetchFn, async (ms) => { waits.push(ms); });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(waits).toEqual([2000]);
  });

  it('honors a Backoff header before the next request', async () => {
    const waits: number[] = [];
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls++;
      return jsonResponse([], calls === 1 ? { Backoff: '3' } : {});
    };
    const sleepFn = async (ms: number) => { waits.push(ms); };
    await apiGet('https://api.zotero.org/a', 'k', fetchFn, sleepFn);
    expect(waits).toEqual([]); // backoff is pending, not applied yet
    await apiGet('https://api.zotero.org/b', 'k', fetchFn, sleepFn);
    expect(waits).toEqual([3000]); // applied before the following request
  });

  it('gives up after maxRetries and returns the 429', async () => {
    const fetchFn: FetchLike = async () => new Response(null, { status: 429 });
    const res = await apiGet('https://api.zotero.org/x', 'k', fetchFn, noSleep, 2);
    expect(res.status).toBe(429);
  });
});
