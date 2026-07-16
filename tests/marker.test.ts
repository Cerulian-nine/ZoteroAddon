import { describe, it, expect } from 'vitest';
import { formatMarker, formatMultiMarker, normalizeLocator, generateCitekey } from '../src/lib/marker';
import type { CachedItem } from '../src/lib/types';

function item(overrides: Partial<CachedItem> = {}): CachedItem {
  return {
    id: 'u:1234567:ABCD1234',
    itemKey: 'ABCD1234',
    library: { type: 'user', id: 1234567 },
    itemType: 'journalArticle',
    title: 'Digital Workflows in the Humanities',
    creatorsDisplay: 'Kraus & Berger',
    creatorLastNames: ['kraus', 'berger'],
    year: 2023,
    publicationTitle: 'Journal of Digital Scholarship',
    dateModified: '2023-05-01T00:00:00Z',
    ...overrides,
  };
}

describe('normalizeLocator', () => {
  it('turns a bare number into a page locator', () => {
    expect(normalizeLocator('44')).toBe('p. 44');
  });
  it('turns a range into pp.', () => {
    expect(normalizeLocator('44-46')).toBe('pp. 44-46');
  });
  it('handles en-dash ranges', () => {
    expect(normalizeLocator('44–46')).toBe('pp. 44–46');
  });
  it('enforces the required space after an existing label', () => {
    expect(normalizeLocator('p.44')).toBe('p. 44');
    expect(normalizeLocator('ch.3')).toBe('ch. 3');
  });
  it('keeps well-formed labeled locators as-is', () => {
    expect(normalizeLocator('ch. 3')).toBe('ch. 3');
    expect(normalizeLocator('para. 12')).toBe('para. 12');
  });
  it('returns empty for empty/whitespace input', () => {
    expect(normalizeLocator(undefined)).toBe('');
    expect(normalizeLocator('  ')).toBe('');
  });
});

describe('formatMarker — ODF-Scan', () => {
  it('produces the five-field marker with empty prefix/suffix, no locator', () => {
    const m = formatMarker(item(), { format: 'odf-scan' });
    expect(m).toBe('{ | Kraus & Berger, (2023) | | |zu:1234567:ABCD1234}');
  });

  it('has exactly four pipes and the URI between the last pipe and closing brace', () => {
    const m = formatMarker(item(), { format: 'odf-scan', locator: '44-46' });
    expect(m.startsWith('{')).toBe(true);
    expect(m.endsWith('}')).toBe(true);
    expect(m.split('|').length - 1).toBe(4);
    expect(m).toMatch(/\|zu:1234567:ABCD1234\}$/);
  });

  it('includes a normalized page locator in field 3', () => {
    const m = formatMarker(item(), { format: 'odf-scan', locator: '44-46' });
    expect(m).toBe('{ | Kraus & Berger, (2023) |pp. 44-46 | |zu:1234567:ABCD1234}');
  });

  it('uses zg: for group-library items', () => {
    const m = formatMarker(item({ id: 'g:99:XYZ99999', library: { type: 'group', id: 99 }, itemKey: 'XYZ99999' }), {
      format: 'odf-scan',
    });
    expect(m).toMatch(/\|zg:99:XYZ99999\}$/);
  });

  it('falls back to n.d. and title when metadata is missing', () => {
    const m = formatMarker(item({ creatorsDisplay: '', creatorLastNames: [], year: null }), { format: 'odf-scan' });
    expect(m).toContain('(n.d.)');
    expect(m).toContain('Digital Workflows in the Huma…'); // truncated title stands in for the author
  });
});

describe('formatMarker — pandoc', () => {
  it('generates [@authyear] by default', () => {
    expect(formatMarker(item(), { format: 'pandoc' })).toBe('[@kraus2023]');
  });
  it('appends the locator inside the brackets', () => {
    expect(formatMarker(item(), { format: 'pandoc', locator: '44' })).toBe('[@kraus2023, p. 44]');
  });
  it('honors a custom pattern with all tokens', () => {
    const key = generateCitekey(item(), '[Auth]_[year]_[shorttitle]');
    expect(key).toBe('Kraus_2023_digital');
  });
  it('strips diacritics and unsafe characters from keys', () => {
    const it2 = item({ creatorLastNames: ['müller-o’brien'] });
    expect(generateCitekey(it2, '[auth][year]')).toBe('mullerobrien2023');
  });
  it('never produces an empty key', () => {
    const it2 = item({ creatorLastNames: [], title: '' });
    expect(generateCitekey(it2, '[auth][year]')).toBe('anon2023');
  });
});

describe('formatMarker — plain text', () => {
  it('renders author-year', () => {
    expect(formatMarker(item(), { format: 'plain' })).toBe('(Kraus & Berger, 2023)');
  });
  it('renders pages with an en dash', () => {
    expect(formatMarker(item(), { format: 'plain', locator: '44-46' })).toBe('(Kraus & Berger, 2023, pp. 44\u201346)');
  });
  it('uses n.d. when the year is unknown', () => {
    expect(formatMarker(item({ year: null }), { format: 'plain' })).toBe('(Kraus & Berger, n.d.)');
  });
});

describe('formatMultiMarker', () => {
  const a = item();
  const b = item({
    id: 'u:1234567:EFGH5678', itemKey: 'EFGH5678',
    creatorsDisplay: 'Meier', creatorLastNames: ['meier'], year: 2021,
    title: 'Another Paper',
  });

  it('emits adjacent ODF-Scan markers separated by a space (scanner merges them)', () => {
    const m = formatMultiMarker([a, b], { format: 'odf-scan' });
    expect(m).toBe(
      '{ | Kraus & Berger, (2023) | | |zu:1234567:ABCD1234} { | Meier, (2021) | | |zu:1234567:EFGH5678}',
    );
  });
  it('emits pandoc group syntax', () => {
    expect(formatMultiMarker([a, b], { format: 'pandoc' })).toBe('[@kraus2023; @meier2021]');
  });
  it('emits combined plain citations', () => {
    expect(formatMultiMarker([a, b], { format: 'plain' })).toBe('(Kraus & Berger, 2023; Meier, 2021)');
  });
  it('degrades to a single marker for one item', () => {
    expect(formatMultiMarker([a], { format: 'odf-scan' })).toBe(formatMarker(a, { format: 'odf-scan' }));
  });
  it('returns empty for no items', () => {
    expect(formatMultiMarker([], { format: 'odf-scan' })).toBe('');
  });
});
