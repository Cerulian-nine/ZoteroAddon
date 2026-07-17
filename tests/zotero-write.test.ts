import { describe, it, expect } from 'vitest';
import { createItems, validateKey, ZoteroApiError, type FetchLike, type NewItem } from '../src/lib/zotero';
import type { LibraryRef } from '../src/lib/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const USER_LIB: LibraryRef = { type: 'user', id: 42 };
const ITEM: NewItem = { itemType: 'journalArticle', title: 'A Study', creators: [], date: '2021' };

describe('validateKey — write access', () => {
  it('reports write:true when access.user.write is set', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ userID: 42, username: 'x', access: { user: { write: true } } });
    expect((await validateKey('k', fetchFn)).write).toBe(true);
  });

  it('reports write:false when the key is read-only', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ userID: 42, username: 'x', access: { user: { library: true } } });
    expect((await validateKey('k', fetchFn)).write).toBe(false);
  });
});

describe('createItems', () => {
  it('POSTs to /items with the key and returns the parsed created item', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        successful: {
          '0': {
            key: 'NEWKEY01',
            version: 5,
            data: { key: 'NEWKEY01', itemType: 'journalArticle', title: 'A Study', date: '2021', publicationTitle: 'J' },
          },
        },
        failed: {},
      });
    };

    const [created] = await createItems('secret-key', USER_LIB, [ITEM], fetchFn);
    expect(created.id).toBe('u:42:NEWKEY01');
    expect(created.itemKey).toBe('NEWKEY01');
    expect(created.title).toBe('A Study');
    expect(created.library).toEqual(USER_LIB);

    expect(calls[0].url).toBe('https://api.zotero.org/users/42/items');
    expect(calls[0].init?.method).toBe('POST');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['Zotero-API-Key']).toBe('secret-key');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual([ITEM]);
  });

  it('throws a clear forbidden error on 403 (read-only key)', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({}, 403);
    await expect(createItems('k', USER_LIB, [ITEM], fetchFn)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    await expect(createItems('k', USER_LIB, [ITEM], fetchFn)).rejects.toBeInstanceOf(ZoteroApiError);
  });

  it('surfaces a Zotero validation failure when nothing succeeded', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse({ successful: {}, failed: { '0': { code: 400, message: 'title is invalid' } } });
    await expect(createItems('k', USER_LIB, [ITEM], fetchFn)).rejects.toThrow(/title is invalid/);
  });

  it('returns [] for an empty item list without calling the network', async () => {
    let called = false;
    const fetchFn: FetchLike = async () => { called = true; return jsonResponse({}); };
    expect(await createItems('k', USER_LIB, [], fetchFn)).toEqual([]);
    expect(called).toBe(false);
  });
});
