import type { ZoteroCreator } from './types';

/**
 * Creator types that count as "authors" for display purposes, in order of
 * preference. If an item has no authors we fall back to editors, then to
 * whatever creators exist.
 */
const PRIMARY_TYPES = ['author', 'editor', 'director', 'presenter', 'artist', 'programmer'];

function lastNameOf(c: ZoteroCreator): string {
  if (c.lastName) return c.lastName;
  if (c.name) return c.name; // institutional author
  return '';
}

function pickPrimary(creators: ZoteroCreator[]): ZoteroCreator[] {
  for (const t of PRIMARY_TYPES) {
    const matching = creators.filter((c) => c.creatorType === t);
    if (matching.length > 0) return matching;
  }
  return creators;
}

/**
 * "Kraus & Berger" style display string:
 *   1 creator  -> "Kraus"
 *   2 creators -> "Kraus & Berger"
 *   3+         -> "Kraus et al."
 * No creators  -> "" (callers substitute the title).
 */
export function creatorsDisplay(creators: ZoteroCreator[] | undefined): string {
  if (!creators || creators.length === 0) return '';
  const primary = pickPrimary(creators);
  const names = primary.map(lastNameOf).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}

/** Lowercased last names of all creators, for the search index. */
export function creatorLastNames(creators: ZoteroCreator[] | undefined): string[] {
  if (!creators) return [];
  return creators.map(lastNameOf).filter(Boolean).map((n) => n.toLowerCase());
}

/** Parse a four-digit year out of a Zotero free-form date string. */
export function parseYear(date: string | undefined): number | null {
  if (!date) return null;
  const m = date.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return m ? Number(m[1]) : null;
}
