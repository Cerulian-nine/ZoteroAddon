import { describe, it, expect } from 'vitest';
import {
  parseMarkers,
  uriToItemId,
  scanDocument,
  convertCitations,
} from '../src/lib/scan';
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

const kraus = item();
const meier = item({
  id: 'u:1234567:EFGH5678',
  itemKey: 'EFGH5678',
  title: 'Another Paper',
  creatorsDisplay: 'Meier',
  creatorLastNames: ['meier'],
  year: 2021,
});

function libraryOf(...items: CachedItem[]): Map<string, CachedItem> {
  return new Map(items.map((i) => [i.id, i]));
}

describe('uriToItemId', () => {
  it('maps a personal-library URI', () => {
    expect(uriToItemId('zu:1234567:ABCD1234')).toBe('u:1234567:ABCD1234');
  });
  it('maps a group-library URI', () => {
    expect(uriToItemId('zg:99:XYZ99999')).toBe('g:99:XYZ99999');
  });
  it('rejects malformed URIs', () => {
    expect(uriToItemId('nope')).toBeNull();
    expect(uriToItemId('zu:abc:KEY')).toBeNull();
  });
});

describe('parseMarkers', () => {
  it('extracts a single marker with its fields and offsets', () => {
    const text = 'Intro { | Kraus & Berger, (2023) |pp. 44-46 | |zu:1234567:ABCD1234} tail';
    const markers = parseMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].id).toBe('u:1234567:ABCD1234');
    expect(markers[0].uri).toBe('zu:1234567:ABCD1234');
    expect(markers[0].readableCite).toBe('Kraus & Berger, (2023)');
    expect(markers[0].locator).toBe('pp. 44-46');
    expect(text.slice(markers[0].start, markers[0].end)).toBe(
      '{ | Kraus & Berger, (2023) |pp. 44-46 | |zu:1234567:ABCD1234}',
    );
  });

  it('extracts several markers in order', () => {
    const text =
      '{ | Kraus & Berger, (2023) | | |zu:1234567:ABCD1234} and { | Meier, (2021) | | |zu:1234567:EFGH5678}';
    const markers = parseMarkers(text);
    expect(markers.map((m) => m.id)).toEqual(['u:1234567:ABCD1234', 'u:1234567:EFGH5678']);
  });

  it('ignores braces that are not valid markers', () => {
    expect(parseMarkers('a {plain brace} b')).toHaveLength(0);
    expect(parseMarkers('{ | cite | | |not-a-uri}')).toHaveLength(0);
  });
});

describe('scanDocument', () => {
  const text =
    'First { | Kraus & Berger, (2023) | | |zu:1234567:ABCD1234}, again ' +
    '{ | Kraus & Berger, (2023) |p. 5 | |zu:1234567:ABCD1234}, then ' +
    '{ | Meier, (2021) | | |zu:1234567:EFGH5678}.';

  it('counts markers and distinct cited sources', () => {
    const report = scanDocument({ text, items: libraryOf(kraus, meier), bibliographyIds: [] });
    expect(report.totalMarkers).toBe(3);
    expect(report.cited).toHaveLength(2);
    const krausRow = report.cited.find((c) => c.item.id === kraus.id)!;
    expect(krausRow.count).toBe(2);
    expect(krausRow.inBibliography).toBe(false);
  });

  it('flags cited sources missing from the bibliography list', () => {
    const report = scanDocument({
      text,
      items: libraryOf(kraus, meier),
      bibliographyIds: [kraus.id],
    });
    expect(report.citedNotInBibliography.map((i) => i.id)).toEqual([meier.id]);
    expect(report.cited.find((c) => c.item.id === kraus.id)!.inBibliography).toBe(true);
  });

  it('flags bibliography orphans that are not cited', () => {
    const orphan = item({ id: 'u:1234567:ORPH0000', itemKey: 'ORPH0000', creatorLastNames: ['orphan'] });
    const report = scanDocument({
      text,
      items: libraryOf(kraus, meier, orphan),
      bibliographyIds: [orphan.id],
    });
    expect(report.inBibliographyNotCited.map((i) => i.id)).toEqual([orphan.id]);
  });

  it('reports markers whose item is not in the local library', () => {
    const report = scanDocument({ text, items: libraryOf(kraus), bibliographyIds: [] });
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0].uri).toBe('zu:1234567:EFGH5678');
    expect(report.unresolved[0].count).toBe(1);
  });
});

describe('convertCitations', () => {
  const lib = [kraus, meier];

  it('rewrites a plain author-year citation as an ODF-Scan marker', () => {
    const res = convertCitations({
      text: 'As shown (Kraus & Berger, 2023) the field grew.',
      items: lib,
      format: 'odf-scan',
    });
    expect(res.text).toBe(
      'As shown { | Kraus & Berger, (2023) | | |zu:1234567:ABCD1234} the field grew.',
    );
    expect(res.substitutions).toHaveLength(1);
    expect(res.unmatched).toHaveLength(0);
  });

  it('carries a locator through to the marker', () => {
    const res = convertCitations({
      text: 'See (Meier, 2021, pp. 44-46).',
      items: lib,
      format: 'odf-scan',
    });
    expect(res.text).toBe('See { | Meier, (2021) |pp. 44-46 | |zu:1234567:EFGH5678}.');
  });

  it('rewrites a multi-source parenthetical into adjacent markers', () => {
    const res = convertCitations({
      text: '(Kraus & Berger, 2023; Meier, 2021)',
      items: lib,
      format: 'odf-scan',
    });
    expect(res.text).toBe(
      '{ | Kraus & Berger, (2023) | | |zu:1234567:ABCD1234} { | Meier, (2021) | | |zu:1234567:EFGH5678}',
    );
    expect(res.substitutions[0].items.map((i) => i.id)).toEqual([kraus.id, meier.id]);
  });

  it('rewrites a narrative citation', () => {
    const res = convertCitations({ text: 'Meier (2021) argued otherwise.', items: lib, format: 'odf-scan' });
    expect(res.text).toBe('{ | Meier, (2021) | | |zu:1234567:EFGH5678} argued otherwise.');
  });

  it('leaves an unknown citation untouched and reports it', () => {
    const res = convertCitations({ text: 'A claim (Nobody, 1999).', items: lib, format: 'odf-scan' });
    expect(res.text).toBe('A claim (Nobody, 1999).');
    expect(res.unmatched).toEqual([{ original: '(Nobody, 1999)', reason: 'no-match' }]);
  });

  it('leaves an ambiguous citation untouched and reports the candidate count', () => {
    const kraus2 = item({ id: 'u:1234567:ZZZZ9999', itemKey: 'ZZZZ9999', title: 'A different Kraus 2023 paper' });
    const res = convertCitations({
      text: '(Kraus, 2023)',
      items: [kraus, kraus2],
      format: 'odf-scan',
    });
    expect(res.text).toBe('(Kraus, 2023)');
    expect(res.unmatched).toEqual([{ original: '(Kraus, 2023)', reason: 'ambiguous', candidateCount: 2 }]);
  });

  it('preserves existing markers and does not convert the year inside them', () => {
    const text = 'Existing { | Kraus & Berger, (2023) | | |zu:1234567:ABCD1234} stays put.';
    const res = convertCitations({ text, items: lib, format: 'odf-scan' });
    expect(res.text).toBe(text);
    expect(res.substitutions).toHaveLength(0);
    expect(res.markersPreserved).toBe(1);
  });

  it('folds diacritics when matching surnames', () => {
    const muller = item({
      id: 'u:1234567:MULL0001',
      itemKey: 'MULL0001',
      creatorsDisplay: 'Müller',
      creatorLastNames: ['müller'],
      year: 2019,
    });
    const res = convertCitations({ text: '(Muller, 2019)', items: [muller], format: 'odf-scan' });
    expect(res.text).toBe('{ | Müller, (2019) | | |zu:1234567:MULL0001}');
  });

  it('respects the configured output format', () => {
    const res = convertCitations({ text: '(Meier, 2021)', items: lib, format: 'plain' });
    expect(res.text).toBe('(Meier, 2021)'); // plain round-trips to itself
    expect(res.substitutions).toHaveLength(1);
  });
});
