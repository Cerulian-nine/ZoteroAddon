import type { CachedItem, OutputFormat } from './types';

/**
 * Citation marker formatting. All output syntax lives in this module and
 * nowhere else.
 *
 * ODF-Scan ("Scannable Cite") syntax verified against the authoritative
 * sources on 2026-07-16:
 *
 *   - https://zotero-odf-scan.github.io/zotero-odf-scan/  (marker format table)
 *   - https://github.com/Juris-M/zotero-odf-scan-plugin   (README, translator)
 *
 * A marker has five pipe-separated fields inside curly braces:
 *
 *   {See | Smith, (2012) |p. 45 | for an example |zu:2433:WQVBH98K}
 *    ^prefix ^readable cite ^locator  ^suffix      ^item URI (do not modify)
 *
 * The Scannable Cite export translator emits empty fields like this:
 *
 *   { | Smith, (2012) | | |zu:2433:WQVBH98K}
 *
 * and we mirror that spacing exactly. Per the plugin maintainers, the scanner
 * only requires "curly brackets, four pipes, and the zu:... key between the
 * last pipe and the closing bracket"; the readable cite is display-only.
 *
 * Item URIs: zu:{userID}:{itemKey} for personal libraries (zu:0:{key} for
 * never-synced local libraries — not applicable here since we read from the
 * Web API), zg:{groupID}:{itemKey} for group libraries.
 *
 * Locator labels must be followed by a space ("p. 45", not "p.45").
 */

export interface MarkerOptions {
  format: OutputFormat;
  /** Raw locator input, e.g. "44-46", "p. 44", "ch. 3". Empty/undefined = none. */
  locator?: string;
  /** Better BibTeX-style pattern for pandoc citekeys, e.g. "[auth][year]". */
  citekeyPattern?: string;
}

/** Locator labels recognized by ODF-Scan (subset relevant here; page is default). */
const LOCATOR_LABELS = /^(pp?\.|ch\.|Ch\.|sec\.|vol\.|fig\.|art\.|col\.|l\.|n\.|no\.|op\.|para\.|pt\.|r\.|vrs\.)\s*/;

/**
 * Normalize user locator input to ODF-Scan's expected "label value" form.
 *   "44-46"     -> "pp. 44-46"   (range => pp.)
 *   "44"        -> "p. 44"
 *   "p.44"      -> "p. 44"       (ensure the required space)
 *   "ch. 3"     -> "ch. 3"       (already labeled, kept)
 *   ""          -> ""
 */
export function normalizeLocator(raw: string | undefined): string {
  const input = (raw ?? '').trim();
  if (!input) return '';
  const labelMatch = input.match(LOCATOR_LABELS);
  if (labelMatch) {
    const label = labelMatch[0].trim();
    const rest = input.slice(labelMatch[0].length).trim();
    return rest ? `${label} ${rest}` : label;
  }
  // Bare numbers/ranges: assume pages.
  const isRange = /[-–—,]/.test(input) || /\d\s+\d/.test(input);
  return `${isRange ? 'pp.' : 'p.'} ${input}`;
}

/** The "Kraus & Berger, (2023)" readable cite used in field 2. */
export function readableCite(item: CachedItem): string {
  const who = item.creatorsDisplay || truncate(item.title, 30) || '(no author)';
  const year = item.year ?? 'n.d.';
  return `${who}, (${year})`;
}

/** zu:/zg: item URI for field 5. */
export function itemUri(item: CachedItem): string {
  const prefix = item.library.type === 'group' ? 'zg' : 'zu';
  return `${prefix}:${item.library.id}:${item.itemKey}`;
}

function formatOdfScan(item: CachedItem, locator: string): string {
  // Mirrors the official Scannable Cite translator output:
  // {prefix | cite |locator | suffix |uri} with empty prefix/suffix.
  return `{ | ${readableCite(item)} |${locator} | |${itemUri(item)}}`;
}

/* ------------------------------------------------------------------ */
/* Pandoc citekeys                                                     */
/* ------------------------------------------------------------------ */

const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'on', 'of', 'in', 'and', 'or', 'for', 'to', 'from',
  'der', 'die', 'das', 'ein', 'eine', 'und', 'le', 'la', 'les', 'un', 'une',
]);

/** ASCII-fold and strip anything that is not a citekey-safe character. */
function citekeySafe(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/ß/g, 'ss')
    .replace(/[^a-zA-Z0-9]/g, '');
}

function firstAuthorLastName(item: CachedItem): string {
  if (item.creatorLastNames.length > 0) return item.creatorLastNames[0];
  // Fall back to first title word so keys are never empty.
  return firstSignificantTitleWord(item) || 'anon';
}

function firstSignificantTitleWord(item: CachedItem): string {
  const words = item.title.toLowerCase().split(/\s+/).map(citekeySafe).filter(Boolean);
  return words.find((w) => !TITLE_STOPWORDS.has(w)) ?? words[0] ?? '';
}

/**
 * Best-effort Better BibTeX-style citekey from a pattern. Supported tokens:
 *   [auth]       first author's last name, lowercased
 *   [Auth]       first author's last name, capitalized
 *   [year]       four-digit year ("nd" if unknown)
 *   [shorttitle] first significant title word, lowercased
 * Anything outside tokens is kept literally (after citekey-safe filtering).
 *
 * This is an approximation: it should match common BBT patterns like
 * [auth][year], but users are warned in the UI to align it with their own
 * Better BibTeX configuration.
 */
export function generateCitekey(item: CachedItem, pattern: string): string {
  const auth = citekeySafe(firstAuthorLastName(item)).toLowerCase();
  const year = item.year !== null ? String(item.year) : 'nd';
  const shorttitle = firstSignificantTitleWord(item);
  const replaced = pattern
    .replace(/\[auth\]/g, auth)
    .replace(/\[Auth\]/g, auth.charAt(0).toUpperCase() + auth.slice(1))
    .replace(/\[year\]/g, year)
    .replace(/\[shorttitle\]/g, shorttitle);
  // Citekeys must not contain whitespace or brackets.
  return replaced.replace(/\s+/g, '').replace(/[[\]{}@,;]/g, '') || 'anon';
}

function formatPandoc(item: CachedItem, locator: string, pattern: string): string {
  const key = generateCitekey(item, pattern);
  return locator ? `[@${key}, ${locator}]` : `[@${key}]`;
}

/* ------------------------------------------------------------------ */
/* Plain author-year text                                              */
/* ------------------------------------------------------------------ */

function formatPlain(item: CachedItem, locator: string): string {
  const who = item.creatorsDisplay || truncate(item.title, 30) || 'Anon.';
  const year = item.year ?? 'n.d.';
  // Use an en dash in page ranges for the human-readable format.
  const prettyLocator = locator.replace(/(\d)\s*-\s*(\d)/g, '$1\u2013$2');
  return prettyLocator ? `(${who}, ${year}, ${prettyLocator})` : `(${who}, ${year})`;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Format a citation for one item. The only place output syntax is produced. */
export function formatMarker(item: CachedItem, opts: MarkerOptions): string {
  const locator = normalizeLocator(opts.locator);
  switch (opts.format) {
    case 'odf-scan':
      return formatOdfScan(item, locator);
    case 'pandoc':
      return formatPandoc(item, locator, opts.citekeyPattern || '[auth][year]');
    case 'plain':
      return formatPlain(item, locator);
  }
}

/**
 * Format several items as one combined citation (the multi-cite tray).
 *   ODF-Scan: adjacent markers separated by a space — the desktop scanner
 *             merges adjacent markers into a single Zotero citation.
 *   Pandoc:   [@key1; @key2] group syntax.
 *   Plain:    "(A, 2020; B, 2021)".
 */
export function formatMultiMarker(items: CachedItem[], opts: Omit<MarkerOptions, 'locator'>): string {
  if (items.length === 0) return '';
  if (items.length === 1) return formatMarker(items[0], opts);
  switch (opts.format) {
    case 'odf-scan':
      return items.map((it) => formatOdfScan(it, '')).join(' ');
    case 'pandoc': {
      const pattern = opts.citekeyPattern || '[auth][year]';
      return `[${items.map((it) => `@${generateCitekey(it, pattern)}`).join('; ')}]`;
    }
    case 'plain': {
      const parts = items.map((it) => {
        const who = it.creatorsDisplay || truncate(it.title, 30) || 'Anon.';
        return `${who}, ${it.year ?? 'n.d.'}`;
      });
      return `(${parts.join('; ')})`;
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}
