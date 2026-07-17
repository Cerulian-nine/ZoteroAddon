import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  decodeXmlEntities,
  extractDocxText,
  extractOdtText,
  readDocumentFile,
  DocImportError,
  ACCEPTED_DOC_TYPES,
} from '../src/lib/docimport';

/** Copy bytes into a fresh ArrayBuffer-backed view the File/Blob types accept. */
function part(bytes: Uint8Array): BlobPart {
  return bytes.slice().buffer;
}

/** A minimal but valid .docx byte payload wrapping the given body text. */
function docxBytes(text: string): BlobPart {
  const xml =
    '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>' +
    text +
    '</w:t></w:r></w:p></w:body></w:document>';
  return part(zipSync({ 'word/document.xml': strToU8(xml) }));
}

describe('decodeXmlEntities', () => {
  it('decodes the five predefined entities', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'))
      .toBe('a & b <c> "d" \'e\'');
  });

  it('does not double-decode &amp;lt;', () => {
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('decodes numeric and hex character references', () => {
    expect(decodeXmlEntities('caf&#233; &#x2014; done')).toBe('café — done');
  });
});

describe('extractDocxText', () => {
  it('joins runs within a paragraph and splits on paragraph boundaries', () => {
    const xml =
      '<w:body>' +
      '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second line</w:t></w:r></w:p>' +
      '</w:body>';
    expect(extractDocxText(xml)).toBe('Hello world\nSecond line');
  });

  it('honours xml:space="preserve" runs and tabs/breaks', () => {
    const xml =
      '<w:p><w:r><w:t xml:space="preserve">A</w:t></w:r>' +
      '<w:r><w:tab/></w:r><w:r><w:t>B</w:t></w:r>' +
      '<w:r><w:br/></w:r><w:r><w:t>C</w:t></w:r></w:p>';
    expect(extractDocxText(xml)).toBe('A\tB\nC');
  });

  it('decodes entities and ignores non-text markup', () => {
    const xml =
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' +
      '<w:r><w:t>Meier &amp; Kraus (2021)</w:t></w:r></w:p>';
    expect(extractDocxText(xml)).toBe('Meier & Kraus (2021)');
  });

  it('does not pull text out of field-code (instrText) runs', () => {
    const xml =
      '<w:p><w:r><w:instrText> ADDIN ZOTERO_ITEM </w:instrText></w:r>' +
      '<w:r><w:t>Visible cite</w:t></w:r></w:p>';
    expect(extractDocxText(xml)).toBe('Visible cite');
  });

  it('collapses runs of blank paragraphs', () => {
    const xml =
      '<w:p><w:r><w:t>One</w:t></w:r></w:p>' +
      '<w:p></w:p><w:p></w:p><w:p></w:p>' +
      '<w:p><w:r><w:t>Two</w:t></w:r></w:p>';
    expect(extractDocxText(xml)).toBe('One\n\nTwo');
  });
});

describe('extractOdtText', () => {
  it('extracts paragraphs and headings from the body', () => {
    const xml =
      '<office:document-content>' +
      '<office:automatic-styles><style:style style:name="P1"/></office:automatic-styles>' +
      '<office:body><office:text>' +
      '<text:h text:outline-level="1">Introduction</text:h>' +
      '<text:p>First <text:span>paragraph</text:span>.</text:p>' +
      '<text:p>Second.</text:p>' +
      '</office:text></office:body></office:document-content>';
    expect(extractOdtText(xml)).toBe('Introduction\nFirst paragraph.\nSecond.');
  });

  it('handles tabs, line breaks and repeated spaces', () => {
    const xml =
      '<office:body><office:text>' +
      '<text:p>A<text:tab/>B<text:line-break/>C<text:s text:c="2"/>D</text:p>' +
      '</office:text></office:body>';
    expect(extractOdtText(xml)).toBe('A\tB\nC  D');
  });

  it('does not leak automatic-style names into the text', () => {
    const xml =
      '<office:automatic-styles><style:style style:name="Bold"/></office:automatic-styles>' +
      '<office:body><office:text><text:p>Body only</text:p></office:text></office:body>';
    expect(extractOdtText(xml)).toBe('Body only');
  });

  it('decodes entities', () => {
    const xml =
      '<office:body><office:text><text:p>Meier &amp; Kraus &#8212; 2021</text:p></office:text></office:body>';
    expect(extractOdtText(xml)).toBe('Meier & Kraus — 2021');
  });
});

describe('readDocumentFile', () => {
  it('reads a .docx by its extension', async () => {
    const file = new File([docxBytes('Meier (2021)')], 'draft.docx');
    const res = await readDocumentFile(file);
    expect(res).toEqual({ text: 'Meier (2021)', format: 'docx', name: 'draft.docx' });
  });

  it('reads a plain-text file by its extension', async () => {
    const file = new File(['Plain notes (Kraus, 2019).'], 'notes.txt');
    const res = await readDocumentFile(file);
    expect(res).toEqual({ text: 'Plain notes (Kraus, 2019).', format: 'txt', name: 'notes.txt' });
  });

  it('falls back to the MIME type when the name has no extension', async () => {
    // Android content providers often hand over an extension-less display name.
    const file = new File([docxBytes('From Drive')], 'Document', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const res = await readDocumentFile(file);
    expect(res.format).toBe('docx');
    expect(res.text).toBe('From Drive');
  });

  it('reads extension-less text/plain via the MIME fallback', async () => {
    const file = new File(['just text'], 'clipboard', { type: 'text/plain' });
    const res = await readDocumentFile(file);
    expect(res).toEqual({ text: 'just text', format: 'txt', name: 'clipboard' });
  });

  it('prefers the extension over the MIME type when both are present', async () => {
    // A .docx mislabelled as text/plain must still be unzipped, not read raw.
    const file = new File([docxBytes('Real docx')], 'draft.docx', { type: 'text/plain' });
    const res = await readDocumentFile(file);
    expect(res.format).toBe('docx');
    expect(res.text).toBe('Real docx');
  });

  it('rejects legacy .doc with a save-as-.docx message', async () => {
    const file = new File(['binary'], 'old.doc');
    await expect(readDocumentFile(file)).rejects.toBeInstanceOf(DocImportError);
    await expect(readDocumentFile(file)).rejects.toThrow(/\.docx/);
  });

  it('rejects a truly unsupported file', async () => {
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    await expect(readDocumentFile(file)).rejects.toBeInstanceOf(DocImportError);
  });
});

describe('ACCEPTED_DOC_TYPES', () => {
  it('lists MIME types alongside extensions so Android pickers do not grey out files', () => {
    expect(ACCEPTED_DOC_TYPES).toContain('.docx');
    expect(ACCEPTED_DOC_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(ACCEPTED_DOC_TYPES).toContain('application/vnd.oasis.opendocument.text');
    expect(ACCEPTED_DOC_TYPES).toContain('text/plain');
  });
});
