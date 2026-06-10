/**
 * Unit tests for F3 typed-relationships pure logic.
 *
 * The repo has no vitest/tsx dependency, so this uses Node's built-in
 * `node:test` + `node:assert` and Node 23+ native TypeScript type-stripping.
 * Run from the worktree root with:
 *
 *   node --test --experimental-strip-types \
 *     app/src/lib/relationships.test.ts
 *
 * (a self-test wrapper that resolves the extension-less `./wikilinks` import
 * lives in `app/src/lib/relationships.selftest.mjs`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESERVED_RELATIONSHIP_KEYS,
  extractRelationships,
  isReservedKey,
  parseWikilinkTarget,
  humanizeKey,
  resolveInverseLabel,
  orderInverseLabels,
  setRelationshipInBlock,
} from './relationships.ts';

test('extractRelationships: scalar wikilink-bearing key', () => {
  const rel = extractRelationships({ belongs_to: '[[b]]' });
  assert.deepEqual(rel, { belongs_to: ['[[b]]'] });
});

test('extractRelationships: array of refs', () => {
  const rel = extractRelationships({ cites: ['[[a]]', '[[b]]'] });
  assert.deepEqual(rel, { cites: ['[[a]]', '[[b]]'] });
});

test('extractRelationships: arbitrary custom key auto-detected', () => {
  const rel = extractRelationships({ author: '[[jane]]' });
  assert.deepEqual(rel, { author: ['[[jane]]'] });
});

test('extractRelationships: reserved keys excluded even with a wikilink', () => {
  const rel = extractRelationships({
    title: '[[not a rel]]',
    tags: ['[[x]]'],
    _internal: '[[y]]',
    related_to: '[[z]]',
  });
  assert.deepEqual(rel, { related_to: ['[[z]]'] });
});

test('extractRelationships: non-wikilink values ignored', () => {
  const rel = extractRelationships({ status: 'draft', count: 3, belongs_to: '[[b]]' });
  assert.deepEqual(rel, { belongs_to: ['[[b]]'] });
});

test('extractRelationships: alias/heading collapse to canonical target', () => {
  const rel = extractRelationships({ ref: '[[Paper A|the paper]]', see: '[[Doc#Heading]]' });
  assert.deepEqual(rel, { ref: ['[[Paper A]]'], see: ['[[Doc]]'] });
});

test('extractRelationships: null/empty frontmatter', () => {
  assert.deepEqual(extractRelationships(null), {});
  assert.deepEqual(extractRelationships(undefined), {});
  assert.deepEqual(extractRelationships({}), {});
});

test('isReservedKey: _prefixed and known structural keys', () => {
  assert.equal(isReservedKey('_foo'), true);
  assert.equal(isReservedKey('Title'), true);
  assert.equal(isReservedKey('CSSClass'), true);
  assert.equal(isReservedKey('belongs_to'), false);
  assert.equal(isReservedKey('cites'), false);
});

test('parseWikilinkTarget', () => {
  assert.equal(parseWikilinkTarget('[[b]]'), 'b');
  assert.equal(parseWikilinkTarget('[[a|alias]]'), 'a');
  assert.equal(parseWikilinkTarget('[[a#h]]'), 'a');
  assert.equal(parseWikilinkTarget('plain'), 'plain');
});

test('humanizeKey', () => {
  assert.equal(humanizeKey('belongs_to'), 'Belongs to');
  assert.equal(humanizeKey('relatedTo'), 'Related to');
  assert.equal(humanizeKey('cites'), 'Cites');
  assert.equal(humanizeKey('has-part'), 'Has part');
});

test('resolveInverseLabel: convenience map + fallback', () => {
  assert.equal(resolveInverseLabel('belongs_to'), 'Children');
  assert.equal(resolveInverseLabel('Belongs to'), 'Children');
  assert.equal(resolveInverseLabel('belongsTo'), 'Children');
  assert.equal(resolveInverseLabel('related_to'), 'Referenced by');
  assert.equal(resolveInverseLabel('cites'), '← Cites');
  assert.equal(resolveInverseLabel('author'), '← Author');
});

test('orderInverseLabels: pins Children/Referenced by first', () => {
  const ordered = orderInverseLabels(['← Cites', 'Referenced by', '← Author', 'Children']);
  assert.deepEqual(ordered, ['Children', 'Referenced by', '← Author', '← Cites']);
});

test('setRelationshipInBlock: add to empty block (single → scalar)', () => {
  const out = setRelationshipInBlock('title: A', 'belongs_to', ['[[b]]']);
  assert.equal(out, 'title: A\nbelongs_to: "[[b]]"');
});

test('setRelationshipInBlock: multiple refs → YAML list', () => {
  const out = setRelationshipInBlock('title: A', 'cites', ['[[a]]', '[[b]]']);
  assert.equal(out, 'title: A\ncites:\n  - "[[a]]"\n  - "[[b]]"');
});

test('setRelationshipInBlock: replace existing scalar with list', () => {
  const out = setRelationshipInBlock('belongs_to: "[[b]]"\ntitle: A', 'belongs_to', ['[[b]]', '[[c]]']);
  assert.equal(out, 'belongs_to:\n  - "[[b]]"\n  - "[[c]]"\ntitle: A');
});

test('setRelationshipInBlock: replace existing list, consuming indented items', () => {
  const block = 'cites:\n  - "[[a]]"\n  - "[[b]]"\ntitle: A';
  const out = setRelationshipInBlock(block, 'cites', ['[[a]]']);
  assert.equal(out, 'cites: "[[a]]"\ntitle: A');
});

test('setRelationshipInBlock: deleting last ref removes the key', () => {
  const out = setRelationshipInBlock('belongs_to: "[[b]]"\ntitle: A', 'belongs_to', []);
  assert.equal(out, 'title: A');
});

test('setRelationshipInBlock: deleting a list key removes all its lines', () => {
  const block = 'cites:\n  - "[[a]]"\n  - "[[b]]"\ntitle: A';
  const out = setRelationshipInBlock(block, 'cites', []);
  assert.equal(out, 'title: A');
});

// --- Inverse-resolution simulation (mirrors the TS WeakMap index in
//     useRelationships and the Rust workspace_index_referenced_by command). ---

interface FakeEntry {
  path: string;
  stem: string;
  title?: string;
  aliases?: string[];
  frontmatter: Record<string, unknown> | null;
}

function buildReferencedBy(entries: FakeEntry[]) {
  // entry-lookup: stem / title / alias (case-insensitive), first match wins.
  const byKey = new Map<string, FakeEntry>();
  const reg = (k: string | undefined, e: FakeEntry) => {
    if (!k) return;
    const lc = k.toLowerCase();
    if (!byKey.has(lc)) byKey.set(lc, e);
  };
  for (const e of entries) {
    reg(e.stem, e);
    reg(e.title, e);
    for (const a of e.aliases ?? []) reg(a, e);
  }
  const referencedBy = new Map<string, { from: FakeEntry; viaKey: string }[]>();
  for (const e of entries) {
    const rels = extractRelationships(e.frontmatter);
    for (const [viaKey, refs] of Object.entries(rels)) {
      for (const ref of refs) {
        const target = byKey.get(parseWikilinkTarget(ref).toLowerCase());
        if (!target || target.path === e.path) continue; // self-exclusion
        const list = referencedBy.get(target.path) ?? [];
        list.push({ from: e, viaKey });
        referencedBy.set(target.path, list);
      }
    }
  }
  return referencedBy;
}

test('inverse resolution: belongs_to → Children inverse on the target', () => {
  const entries: FakeEntry[] = [
    { path: '/a.md', stem: 'a', frontmatter: { belongs_to: '[[b]]', cites: '[[c]]' } },
    { path: '/b.md', stem: 'b', frontmatter: null },
    { path: '/c.md', stem: 'c', frontmatter: null },
  ];
  const idx = buildReferencedBy(entries);
  const bInv = idx.get('/b.md') ?? [];
  assert.equal(bInv.length, 1);
  assert.equal(bInv[0].from.path, '/a.md');
  assert.equal(bInv[0].viaKey, 'belongs_to');
  assert.equal(resolveInverseLabel(bInv[0].viaKey), 'Children');

  const cInv = idx.get('/c.md') ?? [];
  assert.equal(cInv.length, 1);
  assert.equal(resolveInverseLabel(cInv[0].viaKey), '← Cites');
});

test('inverse resolution: title/alias matching + self-exclusion', () => {
  const entries: FakeEntry[] = [
    { path: '/a.md', stem: 'a', frontmatter: { related_to: '[[The Topic]]', self: '[[a]]' } },
    { path: '/t.md', stem: 't', title: 'The Topic', aliases: ['Topic'], frontmatter: null },
  ];
  const idx = buildReferencedBy(entries);
  const tInv = idx.get('/t.md') ?? [];
  assert.equal(tInv.length, 1);
  assert.equal(tInv[0].from.path, '/a.md');
  // self ref ([[a]] from a.md) must be excluded.
  assert.equal((idx.get('/a.md') ?? []).length, 0);
});

test('reserved-key set is non-empty (parity anchor with Rust)', () => {
  // The Rust RESERVED_RELATIONSHIP_KEYS must contain the same entries; this
  // anchors the TS side so a drift shows up as a failing snapshot in review.
  assert.ok(RESERVED_RELATIONSHIP_KEYS.includes('title'));
  assert.ok(RESERVED_RELATIONSHIP_KEYS.includes('tags'));
  assert.ok(RESERVED_RELATIONSHIP_KEYS.includes('aliases'));
  assert.equal(RESERVED_RELATIONSHIP_KEYS.length, 18);
});
