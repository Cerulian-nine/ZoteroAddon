import { describe, it, expect } from 'vitest';
import {
  fetchBibliography,
  groupByLibrary,
  extractEntries,
  decodeEntities,
  entryToText,
  CHUNK_SIZE,
} from '../src/lib/bibliography';
import { ZoteroApiError, type FetchLike } from '../src/lib/zotero';
import type { CachedItem, LibraryRef } from '../src/lib/types';

/* ---------------- helpers ---------------- */

function item(key: string, library: LibraryRef): CachedItem {
  return {
    id: `${library.type === 'user' ? 'u' : 'g'}:${library.id}:${key}`,
    itemKey: key,
    library,
    itemType: 'journalArticle',
    title: `Title ${key}`,
    creatorsDisplay: 'Author',
    creatorLastNames: ['author'],
    year: 2020,
    publicationTitle: '',
    dateModified: '',
  };
}

/** A `format=bib` body wrapping the given entry inner-HTML fragments. */
function bibBody(...entries: string[]): string {
  const inner = entries.map((e) => `<div class="csl-entry">${e}</div>`).join('');
  return `<div class="csl-bib-body" style="line-height: 1.35;">${inner}</div>`;
}

function htmlResponse(body: string, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html', ...headers } });
}

const USER: LibraryRef = { type: 'user', id: 42 };
const GROUP: LibraryRef = { type: 'group', id: 77 };
const noSleep = async () => {};

/* ---------------- pure helpers ---------------- */

describe('groupByLibrary', () => {
  it('groups keys by library preserving first-seen order and dedupes', () => {
    const groups = groupByLibrary([
      item('A', USER),
      item('G1', GROUP),
      item('B', USER),
      item('A', USER), // duplicate
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].library).toEqual(USER);
    expect(groups[0].keys).toEqual(['A', 'B']);
    expect(groups[1].library).toEqual(GROUP);
    expect(groups[1].keys).toEqual(['G1']);
  });
});

describe('extractEntries / decodeEntities / entryToText', () => {
  it('pulls each csl-entry inner-HTML from a bib body', () => {
    const html = bibBody('<span>First</span>', '<span>Second</span>');
    expect(extractEntries(html)).toEqual(['<span>First</span>', '<span>Second</span>']);
  });

  it('decodes named and numeric entities', () => {
    expect(decodeEntities('Smith &amp; Jones')).toBe('Smith & Jones');
    expect(decodeEntities('r&#233;sum&#233;')).toBe('résumé');
    expect(decodeEntities('quote&#x2019;s')).toBe('quote’s');
  });

  it('turns an entry into clean single-line text', () => {
    const entry = 'Kraus, T., &amp; Berger, L. (2023).\n  <i>Digital  Workflows</i>.';
    expect(entryToText(entry)).toBe('Kraus, T., & Berger, L. (2023). Digital Workflows.');
  });
});

/* ---------------- fetchBibliography ---------------- */

describe('fetchBibliography', () => {
  it('requests format=bib with the chosen style and item keys', async () => {
    const urls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      urls.push(url);
      return htmlResponse(bibBody('<span>Ref A</span>', '<span>Ref B</span>'));
    };
    const bib = await fetchBibliography([item('A', USER), item('B', USER)], {
      apiKey: 'k', style: 'apa', fetchFn, sleepFn: noSleep,
    });

    expect(urls).toHaveLength(1);
    const u = new URL(urls[0]);
    expect(u.pathname).toBe('/users/42/items');
    expect(u.searchParams.get('format')).toBe('bib');
    expect(u.searchParams.get('style')).toBe('apa');
    expect(u.searchParams.get('itemKey')).toBe('A,B');

    expect(bib.count).toBe(2);
    expect(bib.html).toBe('<div class="csl-bib-body"><div class="csl-entry"><span>Ref A</span></div><div class="csl-entry"><span>Ref B</span></div></div>');
    expect(bib.text).toBe('Ref A\n\nRef B');
  });

  it('sends the Zotero API auth headers via apiGet', async () => {
    let headers: Record<string, string> = {};
    const fetchFn: FetchLike = async (_url, init) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return htmlResponse(bibBody('<span>Ref</span>'));
    };
    await fetchBibliography([item('A', USER)], { apiKey: 'secret', style: 'apa', fetchFn, sleepFn: noSleep });
    expect(headers['Zotero-API-Version']).toBe('3');
    expect(headers['Zotero-API-Key']).toBe('secret');
  });

  it('makes one call per library and concatenates entries in library order', async () => {
    const urls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      urls.push(url);
      if (url.includes('/groups/77/')) return htmlResponse(bibBody('<span>Group ref</span>'));
      return htmlResponse(bibBody('<span>User ref</span>'));
    };
    const bib = await fetchBibliography([item('A', USER), item('G1', GROUP)], {
      apiKey: 'k', style: 'apa', fetchFn, sleepFn: noSleep,
    });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/users/42/items');
    expect(urls[1]).toContain('/groups/77/items');
    expect(bib.count).toBe(2);
    expect(bib.text).toBe('User ref\n\nGroup ref');
  });

  it('chunks large key lists into multiple requests', async () => {
    const keys = Array.from({ length: CHUNK_SIZE + 5 }, (_, i) => `K${i}`);
    const requestedKeys: string[][] = [];
    const fetchFn: FetchLike = async (url) => {
      const k = new URL(url).searchParams.get('itemKey')!.split(',');
      requestedKeys.push(k);
      return htmlResponse(bibBody(...k.map((x) => `<span>${x}</span>`)));
    };
    const bib = await fetchBibliography(keys.map((k) => item(k, USER)), {
      apiKey: 'k', style: 'apa', fetchFn, sleepFn: noSleep,
    });
    expect(requestedKeys).toHaveLength(2);
    expect(requestedKeys[0]).toHaveLength(CHUNK_SIZE);
    expect(requestedKeys[1]).toHaveLength(5);
    expect(bib.count).toBe(CHUNK_SIZE + 5);
  });

  it('returns an empty bibliography without calling the API for no items', async () => {
    let called = false;
    const fetchFn: FetchLike = async () => { called = true; return htmlResponse(''); };
    const bib = await fetchBibliography([], { apiKey: 'k', style: 'apa', fetchFn, sleepFn: noSleep });
    expect(called).toBe(false);
    expect(bib.count).toBe(0);
    expect(bib.text).toBe('');
  });

  it('throws a friendly ZoteroApiError on 403', async () => {
    const fetchFn: FetchLike = async () => htmlResponse('Forbidden', {}, 403);
    await expect(
      fetchBibliography([item('A', USER)], { apiKey: 'bad', style: 'apa', fetchFn, sleepFn: noSleep }),
    ).rejects.toThrow(ZoteroApiError);
  });

  it('throws on other non-ok statuses', async () => {
    const fetchFn: FetchLike = async () => htmlResponse('nope', {}, 500);
    await expect(
      fetchBibliography([item('A', USER)], { apiKey: 'k', style: 'apa', fetchFn, sleepFn: noSleep }),
    ).rejects.toThrow(/500/);
  });
});
