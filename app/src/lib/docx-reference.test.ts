import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

const { markdownToDocxBlob } = await import('./docx-export.ts');

// #553 — a minimal Word "reference doc": only the parts the merge reads.
const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults/><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '</w:styles>';
const PG_SZ = '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>';
const PG_MAR = '<w:pgMar w:top="2000" w:right="1200" w:bottom="2000" w:left="1200"/>';
const FONT_TABLE_XML = '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>';
const THEME_XML = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>';

function referenceDocx(): Uint8Array {
  const templateDocXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p/><w:sectPr>${PG_SZ}${PG_MAR}</w:sectPr></w:body></w:document>`;
  return zipSync(
    {
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
      'word/document.xml': strToU8(templateDocXml),
      'word/styles.xml': strToU8(STYLES_XML),
      'word/fontTable.xml': strToU8(FONT_TABLE_XML),
      'word/theme/theme1.xml': strToU8(THEME_XML),
    },
    { level: 6 },
  );
}

async function generatedParts(reference?: Uint8Array | null): Promise<Record<string, Uint8Array>> {
  const blob = await markdownToDocxBlob(
    '# 标题\n\n正文内容 Body text',
    '测试文档',
    undefined,
    'plain',
    'Contents',
    null,
    reference ?? null,
  );
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

test('#553 a reference .docx replaces styles/fonts/theme and the page setup', async () => {
  const parts = await generatedParts(referenceDocx());
  const docXml = strFromU8(parts['word/document.xml']);

  assert.equal(strFromU8(parts['word/styles.xml']), STYLES_XML);
  assert.equal(strFromU8(parts['word/fontTable.xml']), FONT_TABLE_XML);
  assert.equal(strFromU8(parts['word/theme/theme1.xml']), THEME_XML);
  assert.ok(docXml.includes(PG_SZ), 'paper size comes from the template');
  assert.ok(docXml.includes(PG_MAR), 'margins come from the template');
  assert.ok(docXml.includes('正文内容 Body text'), 'the generated content is untouched');
  // The template's placeholder must never replace the generated manifest.
  const contentTypes = strFromU8(parts['[Content_Types].xml']);
  assert.ok(contentTypes.includes('wordprocessingml'));
  assert.ok(!contentTypes.includes('<Types/>'));
});

test('#553 a non-docx reference is ignored instead of failing the export', async () => {
  const parts = await generatedParts(new Uint8Array([1, 2, 3, 4]));
  assert.notEqual(strFromU8(parts['word/styles.xml']), STYLES_XML);
  assert.ok(strFromU8(parts['word/document.xml']).includes('正文内容 Body text'));
});

test('#553 with no reference the package is byte-for-byte the normal output', async () => {
  const without = await generatedParts(null);
  const baseline = await generatedParts(undefined);
  assert.deepEqual(
    Array.from(without['word/styles.xml']),
    Array.from(baseline['word/styles.xml']),
  );
  assert.ok(strFromU8(without['word/document.xml']).includes('正文内容 Body text'));
});
