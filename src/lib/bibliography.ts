import type { CachedItem, LibraryRef } from './types';
import { API_BASE, apiGet, libraryPrefix, ZoteroApiError, type FetchLike } from './zotero';

/**
 * "Copy bibliography" — render a finished, styled reference list on-device by
 * delegating the CSL formatting to Zotero's Web API (the same engine the
 * desktop ODF-Scan plugin uses), so the desktop conversion step can be
 * skipped entirely.
 *
 * Endpoint (Zotero Web API v3):
 *   GET /{library}/items?itemKey=KEY1,KEY2,…&format=bib&style={style}
 *
 * `format=bib` returns an XHTML reference list wrapped in
 *   <div class="csl-bib-body"> … <div class="csl-entry"> … </div> … </div>
 * sorted per the chosen CSL style. Verified against the current Web API v3
 * docs (https://www.zotero.org/support/dev/web_api/v3/basics) on 2026-07-17:
 *  - `style` is a CSL short-name (filename without `.csl`), e.g. "apa".
 *  - `itemKey` is a comma-separated filter; `format=bib` honors it but ignores
 *    limit/sort/start, so there is no pagination — but the key list is capped,
 *    hence CHUNK_SIZE below.
 *  - The call cannot mix libraries, so we issue one request per library
 *    (user vs each group) and concatenate the rendered entries.
 *
 * `fetchFn` is injected exactly like the sync engine so this is testable
 * without a network or browser DOM.
 */

/** Max item keys per `itemKey=` request (Zotero caps the list). */
export const CHUNK_SIZE = 50;

export interface BibliographyOptions {
  apiKey: string;
  /** CSL style short-name, e.g. "apa". */
  style: string;
  fetchFn?: FetchLike;
  /** Test hook: replaces real waiting during backoff. */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface Bibliography {
  /** Combined reference list as one `<div class="csl-bib-body">…</div>`. */
  html: string;
  /** Plain-text rendering, one entry per paragraph (blank-line separated). */
  text: string;
  /** Number of rendered entries. */
  count: number;
}

/* ------------------------------------------------------------------ */
/* Grouping & chunking                                                 */
/* ------------------------------------------------------------------ */

interface LibraryGroup {
  library: LibraryRef;
  keys: string[];
}

/**
 * Group item keys by their library, preserving first-seen order both across
 * libraries and within each library (so bibliography order is deterministic).
 */
export function groupByLibrary(items: CachedItem[]): LibraryGroup[] {
  const groups = new Map<string, LibraryGroup>();
  for (const item of items) {
    const key = `${item.library.type}:${item.library.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { library: item.library, keys: [] };
      groups.set(key, group);
    }
    if (!group.keys.includes(item.itemKey)) group.keys.push(item.itemKey);
  }
  return [...groups.values()];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */
/* XHTML parsing (DOM-free, so it runs under vitest/node)              */
/* ------------------------------------------------------------------ */

const ENTRY_RE = /<div class="csl-entry"[^>]*>([\s\S]*?)<\/div>/g;

/** Pull the inner HTML of each `csl-entry` div out of a `format=bib` body. */
export function extractEntries(bibHtml: string): string[] {
  const entries: string[] = [];
  let m: RegExpExecArray | null;
  ENTRY_RE.lastIndex = 0;
  while ((m = ENTRY_RE.exec(bibHtml)) !== null) entries.push(m[1]);
  return entries;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/** Decode the entity set CSL output uses (named + numeric). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Strip tags from one entry's HTML into clean single-line plain text. */
export function entryToText(entryHtml: string): string {
  return decodeEntities(entryHtml.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

async function fetchLibraryEntries(
  group: LibraryGroup,
  opts: BibliographyOptions,
  fetchFn: FetchLike,
): Promise<string[]> {
  const prefix = libraryPrefix(group.library);
  const entries: string[] = [];
  for (const keys of chunk(group.keys, CHUNK_SIZE)) {
    const params = new URLSearchParams({
      itemKey: keys.join(','),
      format: 'bib',
      style: opts.style,
    });
    const res = await apiGet(`${API_BASE}${prefix}/items?${params}`, opts.apiKey, fetchFn, opts.sleepFn);
    if (res.status === 403) {
      throw new ZoteroApiError('forbidden', 'API key is invalid or lacks access to this library.');
    }
    if (!res.ok) {
      throw new ZoteroApiError('http', `Zotero API returned ${res.status}.`, res.status);
    }
    entries.push(...extractEntries(await res.text()));
  }
  return entries;
}

/**
 * Build a finished, styled bibliography for the given items. Makes one API
 * request per library (chunked by key count) and concatenates the rendered
 * entries into a single reference list.
 *
 * Throws {@link ZoteroApiError} on auth/HTTP failures and rethrows network
 * errors from `fetchFn` (the caller surfaces a friendly offline message).
 */
export async function fetchBibliography(
  items: CachedItem[],
  opts: BibliographyOptions,
): Promise<Bibliography> {
  const fetchFn = opts.fetchFn ?? ((u, i) => fetch(u, i));
  if (items.length === 0) return { html: '<div class="csl-bib-body"></div>', text: '', count: 0 };

  const entries: string[] = [];
  for (const group of groupByLibrary(items)) {
    entries.push(...await fetchLibraryEntries(group, opts, fetchFn));
  }

  const html = `<div class="csl-bib-body">${entries.map((e) => `<div class="csl-entry">${e}</div>`).join('')}</div>`;
  const text = entries.map(entryToText).filter(Boolean).join('\n\n');
  return { html, text, count: entries.length };
}
