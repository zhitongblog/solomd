/**
 * DOCX export keeps math: block `$$…$$` as centred LaTeX source and inline
 * `$…$` as source in a math font (it used to drop blocks and write inline
 * math as plain prose).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';

const { markdownToDocxBlob } = await import('./docx-export.ts');

async function documentXml(src: string): Promise<string> {
  const blob = await markdownToDocxBlob(src, 'T');
  const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return strFromU8(zip['word/document.xml']);
}

test('block math is kept, centred, in Cambria Math', async () => {
  const xml = await documentXml('Before.\n\n$$\nE = mc^2\n\\int_0^1 x\\,dx\n$$\n\nAfter.\n');
  assert.ok(xml.includes('E = mc^2'), 'first line present');
  assert.ok(xml.includes('\\int_0^1 x\\,dx'), 'second line present');
  const para = xml.split('<w:p>').find((p) => p.includes('E = mc^2')) ?? xml.slice(xml.indexOf('E = mc^2') - 600, xml.indexOf('E = mc^2'));
  assert.match(para, /<w:jc w:val="center"\/>/);
  assert.match(para, /Cambria Math/);
});

test('inline math is source text in a math font', async () => {
  const xml = await documentXml('Pythagoras: $a^2+b^2=c^2$ holds.\n');
  const at = xml.indexOf('a^2+b^2=c^2');
  assert.ok(at > 0);
  const run = xml.slice(xml.lastIndexOf('<w:r>', at), at);
  assert.match(run, /Cambria Math/);
  assert.ok(xml.includes('Pythagoras: '));
});

test('math inside a blockquote survives', async () => {
  const xml = await documentXml('> $$\n> x^2\n> $$\n');
  assert.ok(xml.includes('x^2'));
});
