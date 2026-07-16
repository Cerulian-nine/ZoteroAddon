import { describe, it, expect } from 'vitest';
import { tokenize, buildIndex, search } from '../src/lib/search';
import { creatorsDisplay, parseYear } from '../src/lib/creators';
import type { CachedItem } from '../src/lib/types';

function item(overrides: Partial<CachedItem>): CachedItem {
  return {
    id: `u:1:${Math.random().toString(36).slice(2, 10)}`,
    itemKey: 'K',
    library: { type: 'user', id: 1 },
    itemType: 'journalArticle',
    title: '',
    creatorsDisplay: '',
    creatorLastNames: [],
    year: null,
    publicationTitle: '',
    dateModified: '',
    ...overrides,
  };
}

const kraus = item({
  title: 'Digital Workflows in the Humanities',
  creatorsDisplay: 'Kraus & Berger',
  creatorLastNames: ['kraus', 'berger'],
  year: 2023,
});
const meier = item({
  title: 'Archival Methods Reconsidered',
  creatorsDisplay: 'Meier',
  creatorLastNames: ['meier'],
  year: 2021,
});
const mueller = item({
  title: 'Über die Praxis',
  creatorsDisplay: 'Müller',
  creatorLastNames: ['müller'],
  year: 2019,
});

const index = buildIndex([kraus, meier, mueller]);

describe('tokenize', () => {
  it('lowercases and splits on non-word characters', () => {
    expect(tokenize('Digital Workflows: 2nd ed.')).toEqual(['digital', 'workflows', '2nd', 'ed']);
  });
  it('folds diacritics', () => {
    expect(tokenize('Müller-Lüdenscheidt')).toEqual(['muller', 'ludenscheidt']);
  });
  it('handles empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('search', () => {
  it('matches an author prefix ("kra")', () => {
    expect(search(index, 'kra')).toEqual([kraus]);
  });
  it('matches author + year ("kraus 2023")', () => {
    expect(search(index, 'kraus 2023')).toEqual([kraus]);
  });
  it('rejects author + wrong year', () => {
    expect(search(index, 'kraus 2021')).toEqual([]);
  });
  it('matches title words ("digital workflows")', () => {
    expect(search(index, 'digital workflows')).toEqual([kraus]);
  });
  it('every term must match (AND semantics)', () => {
    expect(search(index, 'digital meier')).toEqual([]);
  });
  it('matches diacritics-insensitively ("muller" finds Müller)', () => {
    expect(search(index, 'muller')).toEqual([mueller]);
  });
  it('returns nothing for an empty query', () => {
    expect(search(index, '   ')).toEqual([]);
  });
  it('ranks author-name hits above title-word hits', () => {
    const bergerBook = item({
      title: 'The Meier Principle', // title mentions "meier"
      creatorsDisplay: 'Berger',
      creatorLastNames: ['berger'],
      year: 2020,
    });
    const idx = buildIndex([bergerBook, meier]);
    expect(search(idx, 'meier')[0]).toBe(meier);
  });
  it('is fast on 5,000+ items', () => {
    const big = Array.from({ length: 5500 }, (_, i) =>
      item({
        title: `Paper number ${i} about topic ${i % 97}`,
        creatorsDisplay: `Author${i % 311}`,
        creatorLastNames: [`author${i % 311}`],
        year: 1990 + (i % 36),
      }),
    );
    const idx = buildIndex(big);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) search(idx, 'author12 20');
    const perQuery = (performance.now() - t0) / 50;
    expect(perQuery).toBeLessThan(20); // ms — instant relative to the 100ms debounce
  });
});

describe('creators helpers', () => {
  it('formats 1 / 2 / 3+ creators', () => {
    expect(creatorsDisplay([{ creatorType: 'author', lastName: 'Kraus' }])).toBe('Kraus');
    expect(
      creatorsDisplay([
        { creatorType: 'author', lastName: 'Kraus' },
        { creatorType: 'author', lastName: 'Berger' },
      ]),
    ).toBe('Kraus & Berger');
    expect(
      creatorsDisplay([
        { creatorType: 'author', lastName: 'Kraus' },
        { creatorType: 'author', lastName: 'Berger' },
        { creatorType: 'author', lastName: 'Meier' },
      ]),
    ).toBe('Kraus et al.');
  });
  it('prefers authors over other creator types', () => {
    expect(
      creatorsDisplay([
        { creatorType: 'editor', lastName: 'Editor' },
        { creatorType: 'author', lastName: 'Writer' },
      ]),
    ).toBe('Writer');
  });
  it('falls back to editors when there is no author', () => {
    expect(creatorsDisplay([{ creatorType: 'editor', lastName: 'Editor' }])).toBe('Editor');
  });
  it('handles institutional single-field names', () => {
    expect(creatorsDisplay([{ creatorType: 'author', name: 'World Health Organization' }])).toBe(
      'World Health Organization',
    );
  });
  it('parses years from free-form Zotero dates', () => {
    expect(parseYear('2023-05-01')).toBe(2023);
    expect(parseYear('May 2021')).toBe(2021);
    expect(parseYear('circa 1999?')).toBe(1999);
    expect(parseYear('')).toBeNull();
    expect(parseYear('n.d.')).toBeNull();
  });
});
