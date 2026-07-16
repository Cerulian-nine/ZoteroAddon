import type { CachedItem } from './types';

/**
 * Instant client-side search.
 *
 * Strategy: pre-build an in-memory index of lowercase tokens per item
 * (author last names, year, title words, publication words). A query is
 * split into terms; every term must prefix-match at least one token of an
 * item for the item to match. This makes "kraus 2023", "digital workflows",
 * and "kra" all behave as expected, and is comfortably fast for libraries
 * of 5,000+ items (simple array scan with early exits — no allocation in
 * the hot loop).
 */

export interface IndexedEntry {
  item: CachedItem;
  tokens: string[];
}

/** Split text into lowercase word tokens (unicode-aware, diacritics folded). */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

export function buildIndex(items: CachedItem[]): IndexedEntry[] {
  return items.map((item) => {
    const tokens = new Set<string>();
    for (const name of item.creatorLastNames) for (const t of tokenize(name)) tokens.add(t);
    if (item.year !== null) tokens.add(String(item.year));
    for (const t of tokenize(item.title)) tokens.add(t);
    for (const t of tokenize(item.publicationTitle)) tokens.add(t);
    return { item, tokens: [...tokens] };
  });
}

function entryMatches(entry: IndexedEntry, terms: string[]): boolean {
  for (const term of terms) {
    let found = false;
    for (const token of entry.tokens) {
      if (token.startsWith(term)) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

/** Rank: author-name prefix hits first, then newer items. */
function score(entry: IndexedEntry, terms: string[]): number {
  let s = 0;
  for (const term of terms) {
    for (const name of entry.item.creatorLastNames) {
      if (name.startsWith(term)) { s += 10; break; }
    }
    if (entry.item.year !== null && String(entry.item.year) === term) s += 5;
  }
  return s;
}

export function search(index: IndexedEntry[], query: string, limit = 30): CachedItem[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const hits: { item: CachedItem; s: number }[] = [];
  for (const entry of index) {
    if (entryMatches(entry, terms)) {
      hits.push({ item: entry.item, s: score(entry, terms) });
    }
  }
  hits.sort((a, b) => b.s - a.s || (b.item.year ?? 0) - (a.item.year ?? 0) || a.item.title.localeCompare(b.item.title));
  return hits.slice(0, limit).map((h) => h.item);
}
