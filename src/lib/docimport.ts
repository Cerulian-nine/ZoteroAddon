import { unzipSync, strFromU8 } from 'fflate';

/**
 * Local document import. Turns an uploaded file into the same plain-text string
 * the Scan screen already works with — so nothing is ever uploaded or stored.
 * Everything here runs in the browser, on the picked file, and is thrown away
 * once the text is extracted.
 *
 *   • .txt / .md    — read as-is.
 *   • .docx         — a ZIP; the prose lives in `word/document.xml` as <w:t> runs.
 *   • .odt          — a ZIP; the prose lives in `content.xml` (Zotero/LibreOffice).
 *   • .doc (legacy) — the pre-2007 binary Word format. There is no reliable
 *                     in-browser parser for it, so we reject it with a clear
 *                     "save as .docx" message instead of returning garbage.
 *
 * The XML→text extractors are pure string functions so they can be unit-tested
 * in Node (the test env has no DOMParser); only readDocumentFile touches the
 * File/ZIP layer.
 */

export type DocFormat = 'txt' | 'docx' | 'odt';

export interface ImportedDocument {
  text: string;
  format: DocFormat;
  /** Original file name, for display. */
  name: string;
}

/** Thrown for anything we can't turn into text; `message` is user-facing. */
export class DocImportError extends Error {}

/* ------------------------------------------------------------------ */
/* XML helpers                                                         */
/* ------------------------------------------------------------------ */

/** Decode the five predefined XML entities plus numeric character refs. */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last so we don't double-decode (&amp;lt; → &lt;, not <).
    .replace(/&amp;/g, '&');
}

function codePoint(n: number): string {
  return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
}

/** Collapse 3+ consecutive newlines to a blank line and trim the ends. */
function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------ */
/* .docx — Office Open XML                                             */
/* ------------------------------------------------------------------ */

/**
 * Extract prose from a Word `document.xml`. Text lives only in <w:t> runs; we
 * ignore everything else (field codes, styles) and rebuild line structure from
 * paragraph (<w:p>) and break (<w:br>, <w:tab>) markers.
 */
export function extractDocxText(documentXml: string): string {
  const paragraphs = documentXml.split(/<\/w:p>/);
  const lines = paragraphs.map((para) => {
    const text = para
      // Drop non-visible text: Zotero field codes and tracked deletions.
      .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '')
      .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, '')
      // Turn structural breaks into the whitespace they represent…
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/?>/g, '\n')
      // …then strip the remaining tags, leaving only <w:t> content and the
      // whitespace we just injected (both sit as loose text between tags).
      .replace(/<[^>]+>/g, '');
    return decodeXmlEntities(text);
  });
  return tidy(lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* .odt — OpenDocument Text                                            */
/* ------------------------------------------------------------------ */

/**
 * Extract prose from an OpenDocument `content.xml`. Text sits directly between
 * tags, so we handle the special whitespace elements, mark paragraph/heading
 * boundaries, then strip the remaining markup.
 */
export function extractOdtText(contentXml: string): string {
  // Only the body carries prose; dropping the automatic-styles header avoids
  // pulling font/style names into the text.
  const bodyMatch = contentXml.match(/<office:body\b[^>]*>([\s\S]*?)<\/office:body>/);
  const body = bodyMatch ? bodyMatch[1] : contentXml;

  const withWhitespace = body
    .replace(/<text:tab\b[^>]*\/?>/g, '\t')
    .replace(/<text:line-break\b[^>]*\/?>/g, '\n')
    .replace(/<text:s\b[^>]*text:c="(\d+)"[^>]*\/?>/g, (_, n) => ' '.repeat(Number(n)))
    .replace(/<text:s\b[^>]*\/?>/g, ' ')
    // End of a paragraph or heading → line break.
    .replace(/<\/text:(?:p|h)>/g, '\n');

  const stripped = withWhitespace.replace(/<[^>]+>/g, '');
  return tidy(decodeXmlEntities(stripped));
}

/* ------------------------------------------------------------------ */
/* File → text                                                         */
/* ------------------------------------------------------------------ */

/** Read a named entry out of a ZIP and decode it as UTF-8 text. */
function zipEntryText(zip: Uint8Array, path: string): string {
  const files = unzipSync(zip);
  const entry = files[path];
  if (!entry) {
    throw new DocImportError(
      `This file is missing its ${path} — it may be corrupt or not a real document.`,
    );
  }
  return strFromU8(entry);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * What we'll actually parse the file as. `doc` is a recognised-but-rejected
 * kind so we can give the "save as .docx" message instead of the generic one.
 */
type DocKind = DocFormat | 'doc';

/** Filename extension → kind. */
const EXT_KIND: Record<string, DocKind> = {
  txt: 'txt', md: 'txt', markdown: 'txt', text: 'txt',
  docx: 'docx', odt: 'odt', doc: 'doc',
};

/**
 * MIME type → kind, used as a fallback when the extension is missing or
 * unknown. Android content providers routinely hand over a file whose display
 * name has no extension (a `content://` URI resolved to a generic name), so
 * without this a perfectly good .docx/.txt would be rejected as "unsupported".
 */
const MIME_KIND: Record<string, DocKind> = {
  'text/plain': 'txt',
  'text/markdown': 'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/msword': 'doc',
};

/**
 * Turn an uploaded file into plain text, entirely on-device. Rejects formats
 * we can't read reliably with a message meant to be shown to the user.
 *
 * The format is decided by the filename extension first, then by the file's
 * MIME type — the extension is authoritative when present, but the MIME
 * fallback keeps uploads working for the extension-less files common on
 * Android.
 */
export async function readDocumentFile(file: File): Promise<ImportedDocument> {
  const ext = extensionOf(file.name);
  const kind = EXT_KIND[ext] ?? MIME_KIND[file.type] ?? null;

  if (kind === 'txt') {
    return { text: (await file.text()).trim(), format: 'txt', name: file.name };
  }

  if (kind === 'docx') {
    const buf = new Uint8Array(await file.arrayBuffer());
    return { text: extractDocxText(zipEntryText(buf, 'word/document.xml')), format: 'docx', name: file.name };
  }

  if (kind === 'odt') {
    const buf = new Uint8Array(await file.arrayBuffer());
    return { text: extractOdtText(zipEntryText(buf, 'content.xml')), format: 'odt', name: file.name };
  }

  if (kind === 'doc') {
    throw new DocImportError(
      'The old .doc format can’t be read in the browser. Open it in Word or Google Docs and “Save As” .docx, then upload that.',
    );
  }

  throw new DocImportError(
    `Unsupported file type “.${ext || '?'}”. Upload a .docx, .odt, .txt or .md file.`,
  );
}

/**
 * File-picker `accept` string matching the formats readDocumentFile handles.
 * Extensions *and* MIME types are both listed: on Android the file chooser
 * routes through providers (Drive, Downloads, the Files app) that filter by
 * MIME type, and an extension-only list greys out the very documents the user
 * is trying to pick.
 */
export const ACCEPTED_DOC_TYPES = [
  '.docx', '.odt', '.txt', '.md', '.markdown', '.text',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'text/plain',
  'text/markdown',
].join(',');
