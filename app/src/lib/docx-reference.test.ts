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

test('#603 remaps Heading1..6 to WPS/Word custom styleIds and merges numbering without collision', async () => {
  const wpsStylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="1"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 1"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="5"><w:name w:val="heading 2"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr><w:outlineLvl w:val="1"/></w:pPr></w:style>' +
    '</w:styles>';
  const wpsNumberingXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>' +
    '</w:numbering>';
  const tplZip = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>',
    ),
    'word/styles.xml': strToU8(wpsStylesXml),
    'word/numbering.xml': strToU8(wpsNumberingXml),
  });

  const md = '# K8S环境铲除流程\n\n## 1、清除k8s环境信息\n\n### 子步骤\n\n- 列表项 A\n1. 有序项 B\n';
  const blob = await markdownToDocxBlob(md, 'K8S', undefined, 'plain', 'Contents', null, tplZip);
  const parts = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const docXml = strFromU8(parts['word/document.xml']);
  const numXml = strFromU8(parts['word/numbering.xml']);

  // H1 -> styleId "2", H2 -> styleId "5", no dangling Heading1/Heading2
  assert.ok(docXml.includes('<w:pStyle w:val="2"/>'), 'H1 mapped to template styleId 2');
  assert.ok(docXml.includes('<w:pStyle w:val="5"/>'), 'H2 mapped to template styleId 5');
  assert.ok(!docXml.includes('w:val="Heading1"'), 'no dangling Heading1');
  assert.ok(!docXml.includes('w:val="Heading2"'), 'no dangling Heading2');
  // Unmapped H3 gets fallback Normal styleId "1" + explicit outlineLvl="2"
  assert.ok(docXml.includes('<w:outlineLvl w:val="2"/>'), 'unmapped H3 preserves outlineLvl=2');
  // Template heading numId="1" preserved AND generated list numIds shifted past 12
  assert.ok(numXml.includes('<w:num w:numId="1">'), 'template heading numId=1 intact');
  const docListNumIds = [...docXml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => Number(m[1]));
  assert.ok(docListNumIds.length >= 2 && docListNumIds.every((id) => id >= 12), 'markdown list numIds shifted away from template heading numIds');
  // OOXML schema order: all abstractNum elements appear before any w:num element
  assert.ok(numXml.lastIndexOf('</w:abstractNum>') < numXml.indexOf('<w:num '), 'all abstractNum precede num');
});
