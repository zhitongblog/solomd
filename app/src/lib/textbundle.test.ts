import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTextPackArchive,
  extractTextPackArchive,
  rewriteMarkdownForTextBundle,
} from './textbundle.ts';

test('#505: rewriteMarkdownForTextBundle rewrites local images to assets/ and leaves remote URLs untouched', () => {
  const md = [
    '# Sample Note',
    '![Diagram](_assets/arch.png)',
    '![Remote](https://example.com/logo.png)',
    '<img src="./photos/arch.png" width="320" />',
  ].join('\n');

  const { rewrittenMarkdown, assets } = rewriteMarkdownForTextBundle(md);
  assert.deepEqual(assets, [
    { rawPath: '_assets/arch.png', bundleFileName: 'arch.png' },
    { rawPath: './photos/arch.png', bundleFileName: 'arch-2.png' },
  ]);
  assert.ok(rewrittenMarkdown.includes('![Diagram](assets/arch.png)'));
  assert.ok(rewrittenMarkdown.includes('![Remote](https://example.com/logo.png)'));
  assert.ok(rewrittenMarkdown.includes('<img src="assets/arch-2.png" width="320" />'));
});

test('#505: createTextPackArchive and extractTextPackArchive round-trip Markdown + binary assets', () => {
  const originalMd = '# Hello TextPack\n\n![Pic](_assets/demo.png)\n';
  const { rewrittenMarkdown } = rewriteMarkdownForTextBundle(originalMd);
  const fakePng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const packBytes = createTextPackArchive(rewrittenMarkdown, {
    'demo.png': fakePng,
  });
  assert.ok(packBytes.byteLength > 0);

  const unpacked = extractTextPackArchive(packBytes, '_assets');
  assert.equal(unpacked.info.version, 2);
  assert.equal(unpacked.info.type, 'net.daringfireball.markdown');
  assert.equal(unpacked.markdown, originalMd);
  assert.equal(unpacked.assets.length, 1);
  assert.equal(unpacked.assets[0].name, 'demo.png');
  assert.deepEqual(Array.from(unpacked.assets[0].bytes), Array.from(fakePng));
});
