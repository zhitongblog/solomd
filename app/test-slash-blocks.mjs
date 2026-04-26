// Self-test for slash-blocks pure logic (filter + expand).
// Run: `node app/test-slash-blocks.mjs`.
//
// Bundles the .ts source via esbuild then assert()s the catalog. No
// browser dependency — covers the deterministic half of v2.5 #7.
// esbuild lives in .pnpm — import directly.
import { build } from './node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tmp = mkdtempSync(join(tmpdir(), 'v25-slash-'));
const out = join(tmp, 'slash-blocks.mjs');

await build({
  entryPoints: ['src/lib/slash-blocks.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  platform: 'neutral',
  target: 'node20',
  logLevel: 'error',
});

const mod = await import(out);
const { SLASH_BLOCKS, expandSnippet, filterBlocks } = mod;

// ---- Catalog shape -------------------------------------------------------
assert.equal(SLASH_BLOCKS.length, 20, 'catalog should have 20 entries');
const ids = new Set(SLASH_BLOCKS.map((b) => b.id));
for (const required of [
  'h1', 'h2', 'h3',
  'bullet', 'numbered', 'todo',
  'code', 'quote', 'divider', 'table',
  'math_block', 'math_inline', 'mermaid',
  'link', 'image',
  'bold', 'italic', 'strikethrough', 'inline_code',
  'frontmatter',
]) {
  assert.ok(ids.has(required), `missing block id: ${required}`);
}

// ---- expandSnippet -------------------------------------------------------
{
  const r = expandSnippet('# ${cursor}', '');
  assert.equal(r.text, '# ');
  assert.equal(r.cursorOffset, 2);
}
{
  // code block: cursor on inner blank line
  const r = expandSnippet('```\n${cursor}\n```', '');
  assert.equal(r.text, '```\n\n```');
  assert.equal(r.cursorOffset, 4); // after "```\n"
}
{
  // selection wrap with selection present
  const r = expandSnippet('**${selection}**', 'hi');
  assert.equal(r.text, '**hi**');
  assert.equal(r.cursorOffset, r.text.length); // no explicit cursor → end
}
{
  // selection wrap, no selection → cursor inside the wrappers
  const r = expandSnippet('**${selection}**', '');
  assert.equal(r.text, '****');
  assert.equal(r.cursorOffset, 2);
}
{
  // inline code wrap, no selection
  const r = expandSnippet('`${selection}`', '');
  assert.equal(r.text, '``');
  assert.equal(r.cursorOffset, 1);
}
{
  // table snippet has cursor in the first cell
  const tbl = SLASH_BLOCKS.find((b) => b.id === 'table');
  const r = expandSnippet(tbl.snippet, '');
  assert.ok(r.text.startsWith('| '), 'table starts with | ');
  assert.ok(r.text.includes('\n| --- |'), 'table has separator row');
  assert.equal(r.cursorOffset, 2); // right after "| "
}

// ---- filterBlocks --------------------------------------------------------
{
  // empty query → all in original order
  const all = filterBlocks(SLASH_BLOCKS, '');
  assert.equal(all.length, SLASH_BLOCKS.length);
  assert.equal(all[0].id, SLASH_BLOCKS[0].id);
}
{
  // 'h1' → Heading 1 first
  const r = filterBlocks(SLASH_BLOCKS, 'h1');
  assert.equal(r[0].id, 'h1');
}
{
  // 'code' → code (block) before inline_code
  const r = filterBlocks(SLASH_BLOCKS, 'code');
  assert.equal(r[0].id, 'code');
  assert.ok(r.find((b) => b.id === 'inline_code'));
}
{
  // 'tab' → table top
  const r = filterBlocks(SLASH_BLOCKS, 'tab');
  assert.equal(r[0].id, 'table');
}
{
  // 'list' → bullet OR numbered or todo (keyword match)
  const r = filterBlocks(SLASH_BLOCKS, 'list');
  const topIds = r.slice(0, 3).map((b) => b.id);
  assert.ok(topIds.includes('bullet') || topIds.includes('numbered'));
}
{
  // gibberish → empty
  const r = filterBlocks(SLASH_BLOCKS, 'zxqwzxq');
  assert.equal(r.length, 0);
}

// Cleanup not necessary — tmp dir is small.
console.log('OK · slash-blocks ·', SLASH_BLOCKS.length, 'entries · all assertions passed');
