/**
 * tldraw-markdown.test.ts — round-trip unit tests for the Markdown-backed
 * whiteboard fence (F7), mirroring Tolaria's tldrawMarkdown.test.ts.
 *
 * Pure-string: no tldraw / Vue / CodeMirror imported, so this suite runs
 * without the heavy dep.
 *
 * Runs on `node:test` like every other suite here. It was written against
 * vitest, which this repo does not depend on — so for its whole life the file
 * threw ERR_MODULE_NOT_FOUND before reaching a single assertion, while looking
 * like 26 of them were passing. The three matchers it uses are shimmed below
 * rather than rewritten inline, so the assertions stay byte-for-byte the ones
 * that were reviewed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.strictEqual(actual, expected),
    toBeLessThan: (limit: number) => assert.ok(
      (actual as number) < limit,
      `expected ${actual} to be less than ${limit}`,
    ),
    toBeGreaterThanOrEqual: (limit: number) => assert.ok(
      (actual as number) >= limit,
      `expected ${actual} to be >= ${limit}`,
    ),
    toContain: (needle: string) => assert.ok(
      String(actual).includes(needle),
      `expected value to contain ${JSON.stringify(needle)}`,
    ),
    toBeNull: () => assert.strictEqual(actual, null),
    toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
  };
}
import {
  serializeTldrawFence,
  parseTldrawFence,
  findTldrawFences,
  fenceLengthForSnapshot,
  parseSnapshotJson,
  emptyBoardFence,
  readFenceAttribute,
} from './tldraw-markdown';
import { replaceBoardSnapshot } from './tldraw-board';

describe('serialize ↔ parse', () => {
  it('round-trips id / height / width / snapshot', () => {
    const snapshot = JSON.stringify({ schema: 1, store: { a: 1 } }, null, 2);
    const fence = serializeTldrawFence({ boardId: 'abc-123', height: '600', width: '', snapshot });
    expect(fence.startsWith('```tldraw ')).toBe(true);
    expect(fence).toContain('id="abc-123"');
    expect(fence).toContain('height="600"');
    expect(fence).toContain('width=""');
    const [found] = findTldrawFences(fence);
    expect(found.boardId).toBe('abc-123');
    expect(found.height).toBe('600');
    expect(found.snapshot).toBe(snapshot);
  });

  it('grows the fence past backtick runs in the body', () => {
    const snapshot = '{\n  "code": "a ``` b ```` c"\n}';
    expect(fenceLengthForSnapshot(snapshot)).toBeGreaterThanOrEqual(5);
    const fence = serializeTldrawFence({ boardId: 'x', height: '520', width: '', snapshot });
    const [found] = findTldrawFences(fence);
    expect(found.snapshot).toBe(snapshot);
  });

  it('&quot;-escapes attribute values and decodes them back', () => {
    const fence = serializeTldrawFence({ boardId: 'a"b', height: '520', width: '', snapshot: '{}' });
    expect(fence).toContain('id="a&quot;b"');
    expect(findTldrawFences(fence)[0].boardId).toBe('a"b');
    expect(readFenceAttribute({ info: 'id="a&quot;b"', name: 'id' })).toBe('a"b');
  });
});

describe('bad-JSON fallback', () => {
  it('treats empty / {} / garbage as a fresh empty board (no throw)', () => {
    expect(parseSnapshotJson('')).toBeNull();
    expect(parseSnapshotJson('{}')).toBeNull();
    expect(parseSnapshotJson('{not json')).toBeNull();
    expect(parseSnapshotJson('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('document scanning', () => {
  it('finds multiple boards interleaved with prose, in order', () => {
    const doc = [
      '# Notes',
      emptyBoardFence('board-1'),
      'prose',
      serializeTldrawFence({ boardId: 'board-2', height: '300', width: '800', snapshot: '{"x":2}' }),
    ].join('\n');
    const found = findTldrawFences(doc);
    expect(found.map((f) => f.boardId)).toEqual(['board-1', 'board-2']);
    expect(found[1].width).toBe('800');
    expect(found[0].from).toBeLessThan(found[1].from);
  });

  it('returns null for a non-tldraw fence', () => {
    expect(parseTldrawFence('mermaid', 'flowchart TD')).toBeNull();
  });
});

describe('replaceBoardSnapshot writeback', () => {
  const doc = [
    'intro',
    serializeTldrawFence({ boardId: 'keep', height: '520', width: '', snapshot: '{"old":1}' }),
    serializeTldrawFence({ boardId: 'edit-me', height: '400', width: '', snapshot: '{"old":2}' }),
    'outro',
  ].join('\n');

  it('splices only the target board, preserving everything else', () => {
    const next = replaceBoardSnapshot(doc, 'edit-me', '{\n  "new": 3\n}');
    const found = findTldrawFences(next);
    expect(found[0].snapshot).toBe('{"old":1}');
    expect(found[1].snapshot).toBe('{\n  "new": 3\n}');
    expect(found[1].height).toBe('400');
    expect(next).toContain('intro');
    expect(next).toContain('outro');
  });

  it('is a no-op for an unknown id when several boards exist (stale-block guard)', () => {
    expect(replaceBoardSnapshot(doc, 'nope', '{"z":9}')).toBe(doc);
  });
});
