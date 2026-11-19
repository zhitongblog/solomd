import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_PREVIEW_MARKS,
  applySearchMarksIn,
  clearSearchMarksIn,
  findPreviewHitsInText,
} from './preview-search-hits.ts';

test('findPreviewHitsInText returns non-overlapping ranges for repeated-character queries', () => {
  // Previously `pos += 1` produced [{start: 0, end: 2}, {start: 1, end: 3}] on "---",
  // which threw DOMException IndexSizeError when wrapping Ranges in reverse order.
  assert.deepEqual(findPreviewHitsInText('---', '--'), {
    hits: [{ start: 0, end: 2 }],
    truncated: false,
  });
  assert.deepEqual(findPreviewHitsInText('----', '--'), {
    hits: [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ],
    truncated: false,
  });
  assert.deepEqual(findPreviewHitsInText('**bold**', '**'), {
    hits: [
      { start: 0, end: 2 },
      { start: 6, end: 8 },
    ],
    truncated: false,
  });
});

test('findPreviewHitsInText matches case-insensitively across ASCII and CJK', () => {
  assert.deepEqual(findPreviewHitsInText('SoloMD 搜索 solomd 搜索', 'SOLOMD 搜索'), {
    hits: [
      { start: 0, end: 9 },
      { start: 10, end: 19 },
    ],
    truncated: false,
  });
});

test('findPreviewHitsInText enforces remainingLimit and reports truncation', () => {
  const text = 'a '.repeat(MAX_PREVIEW_MARKS + 25);
  const res = findPreviewHitsInText(text, 'a', MAX_PREVIEW_MARKS);
  assert.equal(res.hits.length, MAX_PREVIEW_MARKS);
  assert.equal(res.truncated, true);
});

test('findPreviewHitsInText handles Unicode case-folding length expansion safely', () => {
  // U+0130 ('İ') lowercases to 'i\u0307' (length 2 in UTF-16).
  const text = 'İstanbul and finish';
  const res = findPreviewHitsInText(text, 'finish');
  assert.equal(res.truncated, false);
  assert.equal(res.hits.length, 1);
  assert.equal(text.slice(res.hits[0].start, res.hits[0].end), 'finish');
});

test('findPreviewHitsInText supports caseSensitive option', () => {
  assert.deepEqual(findPreviewHitsInText('Alpha alpha ALPHA', 'alpha', Infinity, true), {
    hits: [{ start: 6, end: 11 }],
    truncated: false,
  });
  assert.equal(findPreviewHitsInText('Alpha alpha ALPHA', 'alpha', Infinity, false).hits.length, 3);
});

test('applySearchMarksIn & clearSearchMarksIn wrap matches and skip active editing cells', () => {
  // Minimal DOM mock sufficient for TreeWalker + Range.surroundContents + clearSearchMarksIn
  class MockNode {
    nodeType = 1;
    parentNode: MockElement | null = null;
    ownerDocument: any = null;
    get parentElement(): MockElement | null {
      return this.parentNode;
    }
    get textContent(): string {
      return '';
    }
  }
  class MockText extends MockNode {
    override nodeType = 3;
    nodeValue: string;
    constructor(val: string, doc: any) {
      super();
      this.nodeValue = val;
      this.ownerDocument = doc;
    }
    override get textContent(): string {
      return this.nodeValue;
    }
  }
  class MockElement extends MockNode {
    tagName: string;
    className = '';
    children: MockNode[] = [];
    constructor(tag: string, doc: any, cls = '') {
      super();
      this.tagName = tag.toUpperCase();
      this.ownerDocument = doc;
      this.className = cls;
    }
    appendChild<T extends MockNode>(child: T): T {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    replaceChild(newChild: MockNode, oldChild: MockNode): MockNode {
      const idx = this.children.indexOf(oldChild);
      if (idx >= 0) {
        newChild.parentNode = this;
        oldChild.parentNode = null;
        this.children.splice(idx, 1, newChild);
      }
      return oldChild;
    }
    normalize() {
      const merged: MockNode[] = [];
      for (const ch of this.children) {
        const prev = merged[merged.length - 1];
        if (ch instanceof MockText && prev instanceof MockText) {
          prev.nodeValue += ch.nodeValue;
        } else if (!(ch instanceof MockText) || ch.nodeValue.length > 0) {
          merged.push(ch);
        }
      }
      this.children = merged;
    }
    override get textContent(): string {
      return this.children.map((c) => c.textContent).join('');
    }
    matchesSelector(sel: string): boolean {
      const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const p of parts) {
        if (p === 'mark.ps-mark' && this.tagName === 'MARK' && classes.has('ps-mark')) return true;
        if (p.startsWith('.') && classes.has(p.slice(1))) return true;
        if (this.tagName.toLowerCase() === p.toLowerCase()) return true;
      }
      return false;
    }
    closest(sel: string): MockElement | null {
      let cur: MockElement | null = this;
      while (cur) {
        if (cur.matchesSelector(sel)) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
    querySelectorAll(sel: string): MockElement[] {
      const out: MockElement[] = [];
      const walk = (el: MockElement) => {
        for (const ch of el.children) {
          if (ch instanceof MockElement) {
            if (ch.matchesSelector(sel)) out.push(ch);
            walk(ch);
          }
        }
      };
      walk(this);
      return out;
    }
  }

  const doc = {
    createTextNode: (t: string) => new MockText(t, doc),
    createElement: (tag: string) => new MockElement(tag, doc),
    createTreeWalker: (root: MockElement) => {
      const texts: MockText[] = [];
      const collect = (n: MockNode) => {
        if (n instanceof MockText) texts.push(n);
        else if (n instanceof MockElement) n.children.forEach(collect);
      };
      collect(root);
      let idx = -1;
      return {
        nextNode: () => {
          idx += 1;
          return texts[idx] ?? null;
        },
      };
    },
    createRange: () => {
      let node: MockText | null = null;
      let s = 0;
      let e = 0;
      return {
        setStart(n: MockText, off: number) {
          node = n;
          s = off;
        },
        setEnd(_n: MockText, off: number) {
          e = off;
        },
        surroundContents(wrapper: MockElement) {
          if (!node || !node.parentNode) return;
          const parent = node.parentNode;
          const full = node.nodeValue;
          const before = full.slice(0, s);
          const mid = full.slice(s, e);
          const after = full.slice(e);
          const idx = parent.children.indexOf(node);
          node.nodeValue = before;
          wrapper.parentNode = parent;
          wrapper.appendChild(new MockText(mid, doc));
          const tail = new MockText(after, doc);
          tail.parentNode = parent;
          parent.children.splice(idx + 1, 0, wrapper, tail);
        },
      };
    },
  };

  const wrap = new MockElement('div', doc);
  const td1 = wrap.appendChild(new MockElement('td', doc));
  td1.appendChild(new MockText('肺动脉流静脉血', doc));
  const tdEditing = wrap.appendChild(new MockElement('td', doc, 'cm-live-table__cell--editing'));
  tdEditing.appendChild(new MockText('编辑中的静脉血不包裹', doc));
  const srcBtn = wrap.appendChild(new MockElement('button', doc, 'cm-table-source-btn'));
  srcBtn.appendChild(new MockText('静脉血按钮', doc));

  const marks = applySearchMarksIn(wrap as unknown as HTMLElement, '静脉血');
  assert.equal(marks.length, 1, 'only non-editing cell should receive <mark class="ps-mark">');
  assert.equal(marks[0].textContent, '静脉血');
  assert.equal(tdEditing.querySelectorAll('mark.ps-mark').length, 0, 'active editing cell must not be mutated');

  clearSearchMarksIn(wrap as unknown as ParentNode);
  assert.equal(td1.querySelectorAll('mark.ps-mark').length, 0);
  assert.equal(td1.textContent, '肺动脉流静脉血');
});
