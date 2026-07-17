import type { CachedItem, LibraryRef } from './types';
import { API_BASE, apiGet, ZoteroApiError, type FetchLike } from './zotero';

/**
 * Full bibliography rendering — the "bypass the desktop roundtrip" path.
 *
 * Rather than shipping a CSL processor, this calls the Zotero Web API's own
 * `format=bib&style=…` mode, which returns a fully rendered, style-sorted
 * bibliography as HTML (`<div class="csl-bib-body">` wrapping one
 * `<div class="csl-entry">` per item). We just collect entries and hand the
 * HTML to the clipboard so pasting into Google Docs keeps italics etc.
 * Docs: https://www.zotero.org/support/dev/web_api/v3/basics ("format=bib")
 *
 * This needs a network round-trip per library (unlike marker copying, which
 * is instant and fully offline) since the rendering happens server-side.
 */

/** Curated shortlist of common CSL style IDs (Zotero style-repo filenames,
 *  without ".csl"). Settings also accepts any other style id/URL by hand. */
export const CITATION_STYLES: { id: string; label: string }[] = [
  { id: 'apa', label: 'APA 7th edition' },
  { id: 'modern-language-association', label: 'MLA 9th edition' },
  { id: 'chicago-author-date', label: 'Chicago (Author-Date)' },
  { id: 'chicago-note-bibliography', label: 'Chicago (Notes-Bibliography)' },
  { id: 'harvard-cite-them-right', label: 'Harvard (Cite Them Right)' },
  { id: 'ieee', label: 'IEEE' },
  { id: 'vancouver', label: 'Vancouver' },
  { id: 'nature', label: 'Nature' },
];

// The Zotero API accepts at most 50 keys in one `itemKey=` filter.
const ITEM_KEY_CHUNK = 50;

function libraryPrefix(library: LibraryRef): string {
  return library.type === 'user' ? `/users/${library.id}` : `/groups/${library.id}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Pull each `<div class="csl-entry">…</div>` block out of a bib response. */
export function extractBibEntries(html: string): string[] {
  const matches = html.match(/<div class="csl-entry"[^>]*>[\s\S]*?<\/div>/g);
  if (matches) return matches;
  // Unrecognized shape (a style that doesn't use csl-entry markup, say):
  // keep the whole body as one entry rather than silently losing it.
  const body = html.match(/<div class="csl-bib-body"[^>]*>([\s\S]*)<\/div>\s*$/);
  if (body) return [body[1].trim()];
  return html.trim() ? [html.trim()] : [];
}

/** Strip tags and decode the handful of entities CSL output actually emits. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, '\'')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export interface RenderedBibliography {
  /** One <div class="csl-bib-body">…</div>, ready to copy as rich text. */
  html: string;
  /** Entries separated by a blank line, for the text/plain clipboard payload. */
  plainText: string;
  count: number;
}

/**
 * Render a full bibliography for `items` in `style`. Items are grouped by
 * library (each library needs its own request) and chunked to the API's
 * 50-key limit; entries are concatenated in the order the chunks come back.
 * Cross-chunk/cross-library ordering isn't re-sorted client-side — each
 * chunk is already sorted within itself, which is a fine approximation for
 * the common case of a single personal library under 50 sources.
 */
export async function fetchBibliography(
  items: CachedItem[],
  style: string,
  apiKey: string,
  fetchFn: FetchLike = (u, i) => fetch(u, i),
): Promise<RenderedBibliography> {
  const byLibrary = new Map<string, { library: LibraryRef; keys: string[] }>();
  for (const item of items) {
    const libId = `${item.library.type}:${item.library.id}`;
    let group = byLibrary.get(libId);
    if (!group) {
      group = { library: item.library, keys: [] };
      byLibrary.set(libId, group);
    }
    group.keys.push(item.itemKey);
  }

  const entries: string[] = [];
  for (const { library, keys } of byLibrary.values()) {
    const prefix = libraryPrefix(library);
    for (const batch of chunk(keys, ITEM_KEY_CHUNK)) {
      const params = new URLSearchParams({
        itemKey: batch.join(','),
        format: 'bib',
        style,
        linkwrap: '1',
      });
      const res = await apiGet(`${API_BASE}${prefix}/items?${params}`, apiKey, fetchFn);
      if (res.status === 400) {
        throw new ZoteroApiError('http', `Zotero didn't recognize the style "${style}".`, 400);
      }
      if (res.status === 403) {
        throw new ZoteroApiError('forbidden', 'API key is invalid or lacks access to this library.');
      }
      if (!res.ok) throw new ZoteroApiError('http', `Zotero API returned ${res.status}.`, res.status);
      const body = await res.text();
      entries.push(...extractBibEntries(body));
    }
  }

  return {
    html: `<div class="csl-bib-body">${entries.join('\n')}</div>`,
    plainText: entries.map(stripHtml).join('\n\n'),
    count: entries.length,
  };
}
