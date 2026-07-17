import { describe, it, expect } from 'vitest';
import { fetchBibliography, extractBibEntries, stripHtml } from '../src/lib/bibliography';
import type { FetchLike } from '../src/lib/zotero';
import type { CachedItem, LibraryRef } from '../src/lib/types';

const USER_LIB: LibraryRef = { type: 'user', id: 42 };
const GROUP_LIB: LibraryRef = { type: 'group', id: 77 };

function item(key: string, library: LibraryRef = USER_LIB): CachedItem {
  return {
    id: `${library.type === 'user' ? 'u' : 'g'}:${library.id}:${key}`,
    itemKey: key,
    library,
    itemType: 'journalArticle',
    title: `Paper ${key}`,
    creatorsDisplay: `Author ${key}`,
    creatorLastNames: [`author${key}`],
    year: 2020,
    publicationTitle: '',
    dateModified: '',
  };
}

function bibResponse(keys: string[]): Response {
  const entries = keys.map((k) => `<div class="csl-entry">Author ${k}. (2020). Paper ${k}.</div>`).join('\n');
  return new Response(`<div class="csl-bib-body">\n${entries}\n</div>`, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

describe('extractBibEntries', () => {
  it('pulls each csl-entry block out of a bib response', () => {
    const html = '<div class="csl-bib-body">\n<div class="csl-entry">A</div>\n<div class="csl-entry">B</div>\n</div>';
    expect(extractBibEntries(html)).toEqual(['<div class="csl-entry">A</div>', '<div class="csl-entry">B</div>']);
  });

  it('falls back to the whole bib body when no csl-entry markup is present', () => {
    const html = '<div class="csl-bib-body">just some text</div>';
    expect(extractBibEntries(html)).toEqual(['just some text']);
  });

  it('returns an empty array for empty input', () => {
    expect(extractBibEntries('')).toEqual([]);
  });
});

describe('stripHtml', () => {
  it('removes tags and decodes common entities', () => {
    expect(stripHtml('<i>Meier</i>, A. &amp; Kraus, B. &nbsp;(2021)')).toBe('Meier, A. & Kraus, B.  (2021)'.trim());
  });
});

describe('fetchBibliography', () => {
  it('requests format=bib with the chosen style and itemKey list', async () => {
    const requests: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      requests.push(url);
      return bibResponse(['A1', 'B2']);
    };
    const result = await fetchBibliography([item('A1'), item('B2')], 'apa', 'key', fetchFn);
    expect(requests.length).toBe(1);
    expect(requests[0]).toContain('/users/42/items');
    expect(requests[0]).toContain('format=bib');
    expect(requests[0]).toContain('style=apa');
    expect(requests[0]).toContain('itemKey=A1%2CB2');
    expect(result.count).toBe(2);
    expect(result.html).toContain('csl-bib-body');
    expect(result.plainText).toContain('Author A1. (2020). Paper A1.');
    expect(result.plainText).toContain('Author B2. (2020). Paper B2.');
  });

  it('sends one request per library', async () => {
    const requests: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      requests.push(url);
      return bibResponse(['X1']);
    };
    const result = await fetchBibliography([item('X1', USER_LIB), item('Y1', GROUP_LIB)], 'apa', 'key', fetchFn);
    expect(requests.length).toBe(2);
    expect(requests.some((u) => u.includes('/users/42/items'))).toBe(true);
    expect(requests.some((u) => u.includes('/groups/77/items'))).toBe(true);
    expect(result.count).toBe(2); // one entry from each mocked response
  });

  it('chunks itemKey lists at 50 items per request', async () => {
    const requests: string[] = [];
    const items = Array.from({ length: 120 }, (_, i) => item(`K${i}`));
    const fetchFn: FetchLike = async (url) => {
      requests.push(url);
      const keys = new URL(url).searchParams.get('itemKey')!.split(',');
      return bibResponse(keys);
    };
    const result = await fetchBibliography(items, 'apa', 'key', fetchFn);
    expect(requests.length).toBe(3); // 50 + 50 + 20
    expect(result.count).toBe(120);
  });

  it('throws a friendly error when the style is rejected', async () => {
    const fetchFn: FetchLike = async () => new Response('Bad style', { status: 400 });
    await expect(fetchBibliography([item('A1')], 'not-a-style', 'key', fetchFn)).rejects.toThrow(/style/);
  });

  it('throws on a forbidden key', async () => {
    const fetchFn: FetchLike = async () => new Response('Forbidden', { status: 403 });
    await expect(fetchBibliography([item('A1')], 'apa', 'bad-key', fetchFn)).rejects.toThrow(/API key/);
  });

  it('returns an empty bibliography for no items without making a request', async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => { calls++; return bibResponse([]); };
    const result = await fetchBibliography([], 'apa', 'key', fetchFn);
    expect(calls).toBe(0);
    expect(result.count).toBe(0);
    expect(result.plainText).toBe('');
  });
});
