import type { FetchLike } from './zotero';

/**
 * Crossref lookup — the "find a source that isn't in your Zotero library at
 * all" fallback for the document scanner.
 *
 * The online Zotero search (lib/zotero `searchItems`) only ever finds items
 * that already exist in the user's *own* library (just not synced to this
 * device yet). When a citation points at something the user has never added to
 * Zotero, that search rightly returns nothing — so we fall back to Crossref,
 * the community-run metadata registry behind DOIs (~150M scholarly works,
 * https://api.crossref.org). It needs no API key, sends CORS headers, and is
 * the same registry Zotero itself queries for "Add Item by Identifier".
 *
 * These results are *identify-only*: a Crossref work has no Zotero item key, so
 * it can't become an ODF-Scan marker (which resolves `zu:userID:itemKey`
 * against the real library) or a rendered bibliography entry. We surface the
 * match plus its DOI so the writer can add it to Zotero themselves and re-sync.
 *
 * Only the citation text (a "Surname Year" string) is ever sent to Crossref —
 * never the API key or the document.
 */

const CROSSREF_BASE = 'https://api.crossref.org/works';

/** One matched work from Crossref, trimmed to what the UI shows. */
export interface CrossrefWork {
  /** Best title, or "(untitled)". */
  title: string;
  /** Display byline, e.g. "Kraus & Berger" / "Smith et al." / "". */
  authors: string;
  /** Four-digit publication year, or null. */
  year: number | null;
  /** Journal / book / proceedings title, or "". */
  containerTitle: string;
  /** Bare DOI, e.g. "10.1000/xyz". */
  doi: string;
  /** Resolver URL, e.g. "https://doi.org/10.1000/xyz". */
  url: string;
}

interface CrossrefAuthor {
  family?: string;
  given?: string;
  name?: string;
}

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: CrossrefAuthor[];
  issued?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
}

interface CrossrefResponse {
  message?: { items?: CrossrefItem[] };
}

/** "Kraus & Berger" / "Smith et al." from a Crossref author array. */
function authorsDisplay(authors: CrossrefAuthor[] | undefined): string {
  if (!authors || authors.length === 0) return '';
  const names = authors
    .map((a) => a.family || a.name || (a.given ? a.given : ''))
    .filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}

/** First element of `issued.date-parts` is `[year, month?, day?]`. */
function issuedYear(issued: CrossrefItem['issued']): number | null {
  const year = issued?.['date-parts']?.[0]?.[0];
  return typeof year === 'number' && Number.isFinite(year) ? year : null;
}

function parseWork(item: CrossrefItem): CrossrefWork | null {
  const doi = (item.DOI || '').trim();
  return {
    title: item.title?.[0]?.trim() || '(untitled)',
    authors: authorsDisplay(item.author),
    year: issuedYear(item.issued),
    containerTitle: item['container-title']?.[0]?.trim() || '',
    doi,
    url: doi ? `https://doi.org/${doi}` : '',
  };
}

/**
 * Search Crossref for a free-text "Surname Year" citation. Returns the top
 * `rows` bibliographic matches, best-first (Crossref's relevance order).
 * Network/parse failures resolve to `[]` — this is a best-effort fallback, so
 * a Crossref outage must not break the surrounding lookup flow.
 */
export async function searchCrossref(
  query: string,
  fetchFn: FetchLike = (u, i) => fetch(u, i),
  rows = 5,
): Promise<CrossrefWork[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({
    'query.bibliographic': q,
    rows: String(rows),
    select: 'DOI,title,author,issued,container-title',
  });
  try {
    const res = await fetchFn(`${CROSSREF_BASE}?${params}`);
    if (!res.ok) return [];
    const body = (await res.json()) as CrossrefResponse;
    const items = body.message?.items ?? [];
    return items.map(parseWork).filter((w): w is CrossrefWork => w !== null);
  } catch {
    return [];
  }
}
