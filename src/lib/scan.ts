import type { CachedItem, LibraryRef, OutputFormat } from './types';
import { itemId } from './types';
import { formatMarker } from './marker';

/**
 * Document scanning. Two jobs, both pure and unit-tested:
 *
 *   1. scanDocument()      — parse the ODF-Scan markers already sitting in a
 *      pasted draft, resolve them against the local library, and compare what
 *      is *cited* in the document against what is in the *bibliography list*.
 *      This is the "evaluate the current state" pass: it tells you which
 *      sources you cite but haven't listed (so the reference list would be
 *      missing them) and which listed sources you no longer cite.
 *
 *   2. convertCitations()  — find plain-text author-year citations (the kind
 *      you get from CitePocket's "plain" copy format, or that you typed by
 *      hand) and substitute a real marker for each, so a later ODF-Scan pass
 *      can turn them into live citations and rebuild the bibliography. This is
 *      deliberately best-effort: a citation is only rewritten when it maps to
 *      exactly one library item; anything ambiguous or unknown is left
 *      untouched and reported.
 *
 * All marker *output* still comes from marker.ts — this module only decides
 * which item a piece of text refers to and where the markers already are.
 */

/* ------------------------------------------------------------------ */
/* Marker parsing                                                      */
/* ------------------------------------------------------------------ */

/** A marker already present in the document text. */
export interface ParsedMarker {
  /** Composite item id (`u:12345:KEY` / `g:678:KEY`), matching CachedItem.id. */
  id: string;
  /** Raw item URI as written in the marker (`zu:12345:KEY`). */
  uri: string;
  /** Field 2 — the human-readable cite, display only. */
  readableCite: string;
  /** Field 3 — the locator, if any. */
  locator: string;
  /** Character offsets of the whole `{…}` marker in the source text. */
  start: number;
  end: number;
}

/** zu:/zg: URI as written in a marker → this app's composite CachedItem id. */
export function uriToItemId(uri: string): string | null {
  const m = uri.match(/^(zu|zg):(\d+):([A-Za-z0-9]+)$/);
  if (!m) return null;
  const library: LibraryRef =
    m[1] === 'zg' ? { type: 'group', id: Number(m[2]) } : { type: 'user', id: Number(m[2]) };
  return itemId(library, m[3]);
}

/**
 * Extract every ODF-Scan marker from a block of text. A marker is a `{…}`
 * group (markers never nest, so no braces inside) with at least four pipes
 * and a `zu:`/`zg:` URI in the final field — matching what marker.ts emits and
 * what the desktop scanner requires.
 */
export function parseMarkers(text: string): ParsedMarker[] {
  const out: ParsedMarker[] = [];
  const re = /\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const fields = m[1].split('|');
    if (fields.length < 5) continue; // needs the four pipes
    const uri = fields[fields.length - 1].trim();
    const id = uriToItemId(uri);
    if (!id) continue; // last field isn't a valid item URI — not our marker
    out.push({
      id,
      uri,
      readableCite: fields[1].trim(),
      locator: fields[2].trim(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* scanDocument — cited vs. bibliography                               */
/* ------------------------------------------------------------------ */

export interface CitedSource {
  item: CachedItem;
  /** How many marker occurrences point at this item. */
  count: number;
  /** Whether the item is already in the bibliography list. */
  inBibliography: boolean;
}

/** A marker whose item isn't in the local library (unsynced / other device). */
export interface UnresolvedMarker {
  uri: string;
  readableCite: string;
  count: number;
}

export interface ScanReport {
  /** Total marker occurrences found (counts repeats). */
  totalMarkers: number;
  /** Distinct resolved sources cited in the document. */
  cited: CitedSource[];
  /** Markers we couldn't resolve to a synced library item. */
  unresolved: UnresolvedMarker[];
  /** Cited sources missing from the bibliography list (would be un-listed). */
  citedNotInBibliography: CachedItem[];
  /** Bibliography-list sources not cited anywhere in the document (orphans). */
  inBibliographyNotCited: CachedItem[];
}

export interface ScanInput {
  text: string;
  /** The local library, keyed by composite id. */
  items: Map<string, CachedItem>;
  /** Composite ids currently in the bibliography list. */
  bibliographyIds: string[];
}

/**
 * Evaluate a pasted draft: which sources it cites (via markers), how that
 * lines up with the saved bibliography list, and which markers point at items
 * this device hasn't synced.
 */
export function scanDocument({ text, items, bibliographyIds }: ScanInput): ScanReport {
  const markers = parseMarkers(text);
  const bibSet = new Set(bibliographyIds);

  const resolvedCounts = new Map<string, number>();
  const unresolvedMap = new Map<string, UnresolvedMarker>();

  for (const marker of markers) {
    if (items.has(marker.id)) {
      resolvedCounts.set(marker.id, (resolvedCounts.get(marker.id) ?? 0) + 1);
    } else {
      const existing = unresolvedMap.get(marker.uri);
      if (existing) existing.count += 1;
      else unresolvedMap.set(marker.uri, { uri: marker.uri, readableCite: marker.readableCite, count: 1 });
    }
  }

  const cited: CitedSource[] = [...resolvedCounts.entries()]
    .map(([id, count]) => ({ item: items.get(id)!, count, inBibliography: bibSet.has(id) }))
    .sort((a, b) => b.count - a.count || sortLabel(a.item).localeCompare(sortLabel(b.item)));

  const citedIds = new Set(resolvedCounts.keys());
  const citedNotInBibliography = cited.filter((c) => !c.inBibliography).map((c) => c.item);
  const inBibliographyNotCited = bibliographyIds
    .filter((id) => !citedIds.has(id))
    .map((id) => items.get(id))
    .filter((i): i is CachedItem => !!i);

  return {
    totalMarkers: markers.length,
    cited,
    unresolved: [...unresolvedMap.values()].sort((a, b) => b.count - a.count),
    citedNotInBibliography,
    inBibliographyNotCited,
  };
}

function sortLabel(item: CachedItem): string {
  return (item.creatorsDisplay || item.title).toLowerCase();
}

/* ------------------------------------------------------------------ */
/* convertCitations — plain text → markers                            */
/* ------------------------------------------------------------------ */

export interface Substitution {
  /** The exact document text that was replaced. */
  original: string;
  /** The marker(s) it became. */
  replacement: string;
  /** The item(s) matched (one per author-year group inside the citation). */
  items: CachedItem[];
}

export interface UnmatchedCitation {
  /** The citation text we recognised but did not rewrite. */
  original: string;
  reason: 'no-match' | 'ambiguous';
  /** For an ambiguous match, how many library items fit. */
  candidateCount?: number;
  /** For a no-match, a "Surname Year" string to search Zotero online with. */
  query?: string;
}

export interface ConversionResult {
  /** The document with confidently-matched citations rewritten as markers. */
  text: string;
  substitutions: Substitution[];
  unmatched: UnmatchedCitation[];
  /** Markers that were already present and left untouched. */
  markersPreserved: number;
}

export interface ConvertOptions {
  text: string;
  items: Iterable<CachedItem>;
  format: OutputFormat;
  citekeyPattern?: string;
}

const YEAR_RE = /\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/;
/** A locator tail after the year: "pp. 44-46", "p. 3", "ch. 2", "12". */
const LOCATOR_TAIL =
  /^(pp?\.|ch\.|sec\.|vol\.|fig\.|art\.|col\.|para\.|pt\.|no\.|n\.|l\.)\s*\S|^\d/i;

interface Entry {
  surname: string;
  year: number;
  locator: string;
}

interface Candidate {
  start: number;
  end: number;
  raw: string;
  entries: Entry[];
}

/** ASCII-fold a surname so "Müller" and "Muller" compare equal. */
function foldName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .trim();
}

/** First capitalised word of an author phrase — the (first) surname. */
function firstSurname(authorPart: string): string {
  const m = authorPart.match(/\p{Lu}[\p{L}'’-]+/u);
  return m ? m[0] : '';
}

/** Parse one "Author, 2023, pp. 44-46" clause into an Entry. */
function parseEntry(clause: string): Entry | null {
  const ym = clause.match(YEAR_RE);
  if (!ym) return null;
  const year = Number(ym[1]);
  const before = clause.slice(0, ym.index);
  const surname = firstSurname(before);
  if (!surname) return null;
  const after = clause.slice(ym.index! + ym[0].length).replace(/^[a-z]/, ''); // drop a "2023a" suffix letter
  const tail = after.replace(/^[\s,;.:]+/, '').trim();
  const locator = LOCATOR_TAIL.test(tail) ? tail : '';
  return { surname, year, locator };
}

/**
 * Collect citation-shaped spans from the text, skipping any that overlap an
 * existing marker (a marker's readable cite contains "(2023)", which we must
 * not treat as a fresh citation to convert).
 */
function findCandidates(text: string, markerRanges: [number, number][]): Candidate[] {
  const overlapsMarker = (start: number, end: number): boolean =>
    markerRanges.some(([ms, me]) => start < me && end > ms);

  const found: Candidate[] = [];

  // Parenthetical: "(Kraus & Berger, 2023, pp. 44-46; Meier, 2021)".
  const paren = /\(([^()]*)\)/g;
  let pm: RegExpExecArray | null;
  while ((pm = paren.exec(text)) !== null) {
    const inner = pm[1];
    if (!YEAR_RE.test(inner)) continue;
    const start = pm.index;
    const end = pm.index + pm[0].length;
    if (overlapsMarker(start, end)) continue;
    const entries: Entry[] = [];
    let ok = true;
    for (const clause of inner.split(';')) {
      const entry = parseEntry(clause);
      if (!entry) { ok = false; break; }
      entries.push(entry);
    }
    if (ok && entries.length > 0) found.push({ start, end, raw: pm[0], entries });
  }

  // Narrative: "Kraus et al. (2023)" / "Meier (2021)".
  const narrative =
    /(\p{Lu}[\p{L}'’-]+(?:\s+(?:et al\.|and|&)\s+\p{Lu}[\p{L}'’-]+|\s+et al\.)?)\s+\((\d{4}[a-z]?)\)/gu;
  let nm: RegExpExecArray | null;
  while ((nm = narrative.exec(text)) !== null) {
    const start = nm.index;
    const end = nm.index + nm[0].length;
    if (overlapsMarker(start, end)) continue;
    // Skip if this span overlaps a parenthetical candidate already found
    // (the trailing "(2023)" would otherwise be double-counted).
    if (found.some((c) => start < c.end && end > c.start)) continue;
    const yearMatch = nm[2].match(YEAR_RE);
    if (!yearMatch) continue;
    const surname = firstSurname(nm[1]);
    if (!surname) continue;
    found.push({
      start,
      end,
      raw: nm[0],
      entries: [{ surname, year: Number(yearMatch[1]), locator: '' }],
    });
  }

  return found.sort((a, b) => a.start - b.start);
}

/** Build a (foldedSurname|year) → items lookup keyed on each item's FIRST author. */
function buildLookup(items: Iterable<CachedItem>): Map<string, CachedItem[]> {
  const lookup = new Map<string, CachedItem[]>();
  for (const item of items) {
    if (item.year === null) continue;
    const first = item.creatorLastNames[0];
    if (!first) continue;
    const key = `${foldName(first)}|${item.year}`;
    const bucket = lookup.get(key);
    if (bucket) bucket.push(item);
    else lookup.set(key, [item]);
  }
  return lookup;
}

/**
 * Rewrite plain-text author-year citations as markers. Only citations that
 * resolve to exactly one library item are rewritten; ambiguous or unknown
 * ones are left in place and reported so the writer can fix them by hand.
 */
export function convertCitations({ text, items, format, citekeyPattern }: ConvertOptions): ConversionResult {
  const lookup = buildLookup(items);
  const markers = parseMarkers(text);
  const markerRanges = markers.map((m) => [m.start, m.end] as [number, number]);
  const candidates = findCandidates(text, markerRanges);

  const substitutions: Substitution[] = [];
  const unmatched: UnmatchedCitation[] = [];

  // Rebuild the string left-to-right, splicing in replacements.
  let result = '';
  let cursor = 0;
  for (const cand of candidates) {
    if (cand.start < cursor) continue; // defensive: skip any overlap

    const matchedItems: CachedItem[] = [];
    let reason: UnmatchedCitation['reason'] | null = null;
    let candidateCount: number | undefined;
    let failed: Entry | null = null;

    for (const entry of cand.entries) {
      const bucket = lookup.get(`${foldName(entry.surname)}|${entry.year}`);
      if (!bucket || bucket.length === 0) { reason = 'no-match'; failed = entry; break; }
      if (bucket.length > 1) { reason = 'ambiguous'; candidateCount = bucket.length; failed = entry; break; }
      matchedItems.push(bucket[0]);
    }

    if (reason) {
      unmatched.push({
        original: cand.raw,
        reason,
        ...(candidateCount ? { candidateCount } : {}),
        // A no-match is the one worth searching Zotero for; carry the offending
        // author-year so the UI can look it up online without re-parsing.
        ...(reason === 'no-match' && failed ? { query: `${failed.surname} ${failed.year}` } : {}),
      });
      continue; // leave the original text as-is
    }

    const replacement = cand.entries
      .map((entry, i) => formatMarker(matchedItems[i], { format, locator: entry.locator, citekeyPattern }))
      .join(' ');

    result += text.slice(cursor, cand.start) + replacement;
    cursor = cand.end;
    substitutions.push({ original: cand.raw, replacement, items: matchedItems });
  }
  result += text.slice(cursor);

  return { text: result, substitutions, unmatched, markersPreserved: markers.length };
}
