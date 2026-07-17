/** Domain types shared across the app. */

/** Which Zotero library an item lives in. */
export type LibraryRef =
  | { type: 'user'; id: number }
  | { type: 'group'; id: number };

/** A single Zotero creator as returned by the Web API. */
export interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  /** Institutional authors use a single `name` field. */
  name?: string;
}

/** The slice of a Zotero item we cache locally. */
export interface CachedItem {
  /** Composite primary key: `${libPrefix}:${libraryId}:${itemKey}` (e.g. "u:12345:ABCD1234"). */
  id: string;
  itemKey: string;
  library: LibraryRef;
  itemType: string;
  title: string;
  /** Display string like "Kraus & Berger" or "Smith et al." */
  creatorsDisplay: string;
  /** Lowercased author last names, for search. */
  creatorLastNames: string[];
  /** Four-digit year parsed from the item date, or null. */
  year: number | null;
  publicationTitle: string;
  dateModified: string;
}

export type OutputFormat = 'odf-scan' | 'pandoc' | 'plain';

export interface Settings {
  apiKey: string;
  userId: number;
  format: OutputFormat;
  /** Better BibTeX-style citekey pattern, e.g. "[auth][year]". */
  citekeyPattern: string;
  /**
   * CSL style short-name used by the "Copy bibliography" feature — the
   * filename (without `.csl`) of a style on the Zotero styles repository,
   * e.g. "apa", "chicago-note-bibliography", "modern-language-association".
   * Passed straight to the Web API's `style=` param for server-side CSL
   * rendering.
   */
  citationStyle: string;
  syncGroups: boolean;
  onboarded: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  userId: 0,
  format: 'odf-scan',
  citekeyPattern: '[auth][year]',
  citationStyle: 'apa',
  syncGroups: false,
  onboarded: false,
};

export function itemId(library: LibraryRef, itemKey: string): string {
  return `${library.type === 'user' ? 'u' : 'g'}:${library.id}:${itemKey}`;
}
