import { describe, it, expect, vi } from 'vitest';
import { searchCrossref, crossrefToZoteroItem, type CrossrefWork } from '../src/lib/crossref';

/** Build a Crossref-shaped JSON Response from a list of message items. */
function crossrefResponse(items: unknown[], ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => ({ message: { items } }),
  } as unknown as Response;
}

const WORK = {
  DOI: '10.1000/xyz123',
  title: ['A Study of Things'],
  author: [{ family: 'Meier', given: 'Anna' }],
  issued: { 'date-parts': [[2021, 5]] },
  'container-title': ['Journal of Things'],
  type: 'journal-article',
  volume: '12',
  issue: '3',
  page: '44-46',
};

describe('searchCrossref', () => {
  it('returns [] for a blank query without calling the network', async () => {
    const fetchFn = vi.fn();
    expect(await searchCrossref('   ', fetchFn)).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('maps a Crossref work to the trimmed shape with a doi.org URL', async () => {
    const fetchFn = vi.fn(async () => crossrefResponse([WORK]));
    const [w] = await searchCrossref('Meier 2021', fetchFn);
    expect(w).toEqual({
      title: 'A Study of Things',
      authors: 'Meier',
      creators: [{ creatorType: 'author', firstName: 'Anna', lastName: 'Meier' }],
      year: 2021,
      date: '2021-05',
      containerTitle: 'Journal of Things',
      type: 'journal-article',
      doi: '10.1000/xyz123',
      url: 'https://doi.org/10.1000/xyz123',
      volume: '12',
      issue: '3',
      pages: '44-46',
    });
  });

  it('sends the query as query.bibliographic and honours the row limit', async () => {
    const fetchFn = vi.fn(async (_url: string) => crossrefResponse([WORK]));
    await searchCrossref('Meier 2021', fetchFn, 3);
    const url = fetchFn.mock.calls[0][0];
    expect(url).toContain('query.bibliographic=Meier+2021');
    expect(url).toContain('rows=3');
  });

  it('formats two authors with "&" and three-plus with "et al."', async () => {
    const two = { ...WORK, author: [{ family: 'Kraus' }, { family: 'Berger' }] };
    const many = { ...WORK, author: [{ family: 'Smith' }, { family: 'Jones' }, { family: 'Lee' }] };
    const fetchFn = vi.fn(async () => crossrefResponse([two, many]));
    const [a, b] = await searchCrossref('q', fetchFn);
    expect(a.authors).toBe('Kraus & Berger');
    expect(b.authors).toBe('Smith et al.');
  });

  it('tolerates missing fields (no author, no date, no container)', async () => {
    const bare = { DOI: '10.5/bare', title: ['Bare'] };
    const fetchFn = vi.fn(async () => crossrefResponse([bare]));
    const [w] = await searchCrossref('q', fetchFn);
    expect(w).toEqual({
      title: 'Bare',
      authors: '',
      creators: [],
      year: null,
      date: '',
      containerTitle: '',
      type: '',
      doi: '10.5/bare',
      url: 'https://doi.org/10.5/bare',
      volume: '',
      issue: '',
      pages: '',
    });
  });

  it('returns [] on a non-ok response', async () => {
    const fetchFn = vi.fn(async () => crossrefResponse([], false, 503));
    expect(await searchCrossref('q', fetchFn)).toEqual([]);
  });

  it('returns [] (never throws) when the request rejects', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('network down'); });
    expect(await searchCrossref('q', fetchFn)).toEqual([]);
  });
});

/** A fully-populated CrossrefWork for the item-builder tests. */
function work(over: Partial<CrossrefWork> = {}): CrossrefWork {
  return {
    title: 'A Study of Things',
    authors: 'Meier',
    creators: [{ creatorType: 'author', firstName: 'Anna', lastName: 'Meier' }],
    year: 2021,
    date: '2021-05',
    containerTitle: 'Journal of Things',
    type: 'journal-article',
    doi: '10.1000/xyz123',
    url: 'https://doi.org/10.1000/xyz123',
    volume: '12',
    issue: '3',
    pages: '44-46',
    ...over,
  };
}

describe('crossrefToZoteroItem', () => {
  it('builds a journalArticle with the DOI field and article metadata', () => {
    expect(crossrefToZoteroItem(work())).toEqual({
      itemType: 'journalArticle',
      title: 'A Study of Things',
      creators: [{ creatorType: 'author', firstName: 'Anna', lastName: 'Meier' }],
      date: '2021-05',
      url: 'https://doi.org/10.1000/xyz123',
      publicationTitle: 'Journal of Things',
      volume: '12',
      issue: '3',
      pages: '44-46',
      DOI: '10.1000/xyz123',
    });
  });

  it('maps a book chapter to bookSection with bookTitle and DOI in extra', () => {
    const item = crossrefToZoteroItem(work({ type: 'book-chapter', volume: '', issue: '' }));
    expect(item.itemType).toBe('bookSection');
    expect(item.bookTitle).toBe('Journal of Things');
    expect(item.DOI).toBeUndefined();
    expect(item.extra).toBe('DOI: 10.1000/xyz123');
    expect(item.publicationTitle).toBeUndefined();
  });

  it('maps a proceedings article to conferencePaper with proceedingsTitle', () => {
    const item = crossrefToZoteroItem(work({ type: 'proceedings-article' }));
    expect(item.itemType).toBe('conferencePaper');
    expect(item.proceedingsTitle).toBe('Journal of Things');
    expect(item.DOI).toBe('10.1000/xyz123');
  });

  it('falls back to journalArticle for an unknown Crossref type', () => {
    expect(crossrefToZoteroItem(work({ type: 'other' })).itemType).toBe('journalArticle');
  });

  it('omits absent optional fields (no url, no container, no doi)', () => {
    const item = crossrefToZoteroItem(work({ url: '', containerTitle: '', doi: '', volume: '', issue: '', pages: '' }));
    expect(item).toEqual({
      itemType: 'journalArticle',
      title: 'A Study of Things',
      creators: [{ creatorType: 'author', firstName: 'Anna', lastName: 'Meier' }],
      date: '2021-05',
    });
  });
});
