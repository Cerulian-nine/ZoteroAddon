import { describe, it, expect } from 'vitest';
import {
  decodeXmlEntities,
  extractDocxText,
  extractOdtText,
} from '../src/lib/docimport';

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
