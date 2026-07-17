import type { FetchLike, NewItem } from './zotero';
import type { ZoteroCreator } from './types';

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
 * A match is *identify-only* on its own — a Crossref work has no Zotero item
 * key, so it can't directly become an ODF-Scan marker (which resolves
 * `zu:userID:itemKey`). With a write-enabled key the app can create the item in
 * the user's Zotero library (`crossrefToZoteroItem` → `zotero.createItems`),
 * which mints a real key; with a read-only key we just show the match + DOI so
 * the writer can add it in Zotero themselves.
 *
 * Only the citation text (a "Surname Year" string) is ever sent to Crossref —
 * never the API key or the document.
 */

const CROSSREF_BASE = 'https://api.crossref.org/works';

/** One matched work from Crossref, trimmed to what the UI and item-builder need. */
export interface CrossrefWork {
  /** Best title, or "(untitled)". */
  title: string;
  /** Display byline, e.g. "Kraus & Berger" / "Smith et al." / "". */
  authors: string;
  /** Structured authors, for creating a Zotero item. */
  creators: ZoteroCreator[];
  /** Four-digit publication year, or null. */
  year: number | null;
  /** Full date string ("2021", "2021-05", "2021-05-04"), for the Zotero item. */
  date: string;
  /** Journal / book / proceedings title, or "". */
  containerTitle: string;
  /** Raw Crossref work type, e.g. "journal-article", used to pick a Zotero type. */
  type: string;
  /** Bare DOI, e.g. "10.1000/xyz". */
  doi: string;
  /** Resolver URL, e.g. "https://doi.org/10.1000/xyz". */
  url: string;
  volume: string;
  issue: string;
  pages: string;
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
  type?: string;
  volume?: string;
  issue?: string;
  page?: string;
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
function issuedParts(issued: CrossrefItem['issued']): number[] {
  const parts = issued?.['date-parts']?.[0];
  return Array.isArray(parts) ? parts.filter((n) => typeof n === 'number' && Number.isFinite(n)) : [];
}

/** "2021" / "2021-05" / "2021-05-04" from Crossref date-parts (Zotero-friendly). */
function partsToDate(parts: number[]): string {
  if (parts.length === 0) return '';
  return parts.map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, '0'))).join('-');
}

/** Structured Zotero creators from a Crossref author array. */
function toCreators(authors: CrossrefAuthor[] | undefined): ZoteroCreator[] {
  if (!authors) return [];
  const out: ZoteroCreator[] = [];
  for (const a of authors) {
    if (a.family) out.push({ creatorType: 'author', firstName: a.given ?? '', lastName: a.family });
    else if (a.name) out.push({ creatorType: 'author', name: a.name });
  }
  return out;
}

function parseWork(item: CrossrefItem): CrossrefWork | null {
  const doi = (item.DOI || '').trim();
  const parts = issuedParts(item.issued);
  return {
    title: item.title?.[0]?.trim() || '(untitled)',
    authors: authorsDisplay(item.author),
    creators: toCreators(item.author),
    year: parts[0] ?? null,
    date: partsToDate(parts),
    containerTitle: item['container-title']?.[0]?.trim() || '',
    type: item.type || '',
    doi,
    url: doi ? `https://doi.org/${doi}` : '',
    volume: item.volume?.trim() || '',
    issue: item.issue?.trim() || '',
    pages: item.page?.trim() || '',
  };
}

/* ------------------------------------------------------------------ */
/* Crossref work → Zotero item                                         */
/* ------------------------------------------------------------------ */

/** Crossref work type → Zotero item type. Unknown falls back to journalArticle. */
const TYPE_MAP: Record<string, string> = {
  'journal-article': 'journalArticle',
  'proceedings-article': 'conferencePaper',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'reference-book': 'book',
  'book-chapter': 'bookSection',
  'book-section': 'bookSection',
  'posted-content': 'preprint',
  dissertation: 'thesis',
  report: 'report',
  dataset: 'dataset',
};

/** The Zotero field a container title maps to, per item type (else none). */
function containerField(itemType: string): string | null {
  switch (itemType) {
    case 'journalArticle': return 'publicationTitle';
    case 'conferencePaper': return 'proceedingsTitle';
    case 'bookSection': return 'bookTitle';
    default: return null;
  }
}

/**
 * Build a Zotero item-creation payload from a Crossref work. Kept to a
 * conservative, always-valid field set so the write never fails validation:
 * title / creators / date / url are universal; the container title goes to its
 * per-type field; the DOI uses the real `DOI` field on the types that have it
 * and otherwise rides in the universal `extra` field (which Zotero's citation
 * processor still reads as a DOI).
 */
export function crossrefToZoteroItem(work: CrossrefWork): NewItem {
  const itemType = TYPE_MAP[work.type] ?? 'journalArticle';
  const item: NewItem = {
    itemType,
    title: work.title,
    creators: work.creators,
    date: work.date,
  };
  if (work.url) item.url = work.url;

  const cf = containerField(itemType);
  if (cf && work.containerTitle) item[cf] = work.containerTitle;

  if (itemType === 'journalArticle') {
    if (work.volume) item.volume = work.volume;
    if (work.issue) item.issue = work.issue;
    if (work.pages) item.pages = work.pages;
  } else if (itemType === 'conferencePaper' || itemType === 'bookSection') {
    if (work.pages) item.pages = work.pages;
  }

  if (work.doi) {
    if (itemType === 'journalArticle' || itemType === 'conferencePaper') item.DOI = work.doi;
    else item.extra = `DOI: ${work.doi}`;
  }
  return item;
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
    select: 'DOI,title,author,issued,container-title,type,volume,issue,page',
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
