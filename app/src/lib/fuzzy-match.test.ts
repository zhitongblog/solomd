/**
 * Unit tests for the command-palette fuzzy matcher (5.0 regression C4).
 * Ranked against the real command titles parsed out of useCommands.ts, so a
 * new command that would steal a top slot shows up here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fuzzyScore, fuzzyRank, scoreItem } from './fuzzy-match';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../composables/useCommands.ts'), 'utf8');
const commands: Array<{ id: string; title: string }> = [];
for (const m of src.matchAll(/id: '([^']+)',\s*title: '((?:[^'\\]|\\.)*)'/g)) {
  commands.push({ id: m[1], title: m[2] });
}

function rank(q: string) {
  return fuzzyRank(q, commands, (c) => ({ primary: [c.title], secondary: [c.id] })).map((c) => c.id);
}

test('the real command list was parsed', () => {
  assert.ok(commands.length > 100, `only ${commands.length} commands parsed`);
});

test('subsequence queries match (the regression report cases)', () => {
  assert.equal(rank('togl line')[0], 'view.toggleLineNumbers');
  assert.ok(rank('exprt pdf').slice(0, 2).every((id) => id.startsWith('export.pdf')), rank('exprt pdf').join());
});

test('contiguous substring queries keep working and rank first', () => {
  assert.equal(rank('toggle line numbers')[0], 'view.toggleLineNumbers');
  assert.equal(rank('line num')[0], 'view.toggleLineNumbers');
  assert.equal(rank('export to html')[0], 'export.html');
});

test('an exact title beats a prefix beats a substring beats a scattered match', () => {
  const items = ['Fold all', 'Fold', 'Unfold', 'Format line of document'];
  const out = fuzzyRank('fold', items, (s) => ({ primary: [s] }));
  assert.deepEqual(out, ['Fold', 'Fold all', 'Unfold', 'Format line of document']);
});

test('word-start matches beat mid-word matches', () => {
  const a = fuzzyScore('tl', 'Toggle Line')!;
  const b = fuzzyScore('tl', 'Battle')!;
  assert.ok(a > b, `${a} <= ${b}`);
});

test('characters out of order, or missing, do not match', () => {
  assert.equal(fuzzyScore('xyz', 'Toggle Line Numbers'), null);
  assert.equal(fuzzyScore('enil', 'line'), null);
  assert.equal(scoreItem('togl zzz', ['Toggle Line Numbers']), null);
});

test('camelCase humps in ids count as word starts', () => {
  const hump = fuzzyScore('ln', 'view.toggleLineNumbers')!;
  const flat = fuzzyScore('ln', 'view.togglelinenumbers')!;
  assert.ok(hump > flat);
});

test('Chinese labels match per character, in order', () => {
  assert.notEqual(fuzzyScore('切行号', '视图：切换行号显示'), null);
  assert.equal(fuzzyScore('号行', '视图：切换行号显示'), null);
  const out = fuzzyRank('行号', ['视图：切换行号显示', '代码块行号', '视图：切换大纲'], (s) => ({ primary: [s] }));
  assert.deepEqual(out, ['代码块行号', '视图：切换行号显示']);
});

test('literal texts (hints) match only as substrings', () => {
  assert.equal(scoreItem('tgl', ['Fold'], [], ['toggle the thing']), null);
  assert.notEqual(scoreItem('thing', ['Fold'], [], ['toggle the thing']), null);
});

test('an empty query keeps every item in order', () => {
  assert.deepEqual(fuzzyRank('  ', ['b', 'a'], (s) => ({ primary: [s] })), ['b', 'a']);
});

test('ranking a few hundred commands per keystroke stays fast', () => {
  const t0 = performance.now();
  for (const q of ['t', 'to', 'tog', 'togl', 'togl l', 'togl li', 'togl lin', 'togl line']) rank(q);
  assert.ok(performance.now() - t0 < 400, `took ${performance.now() - t0}ms`);
});
