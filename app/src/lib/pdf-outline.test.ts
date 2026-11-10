import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  populatePdfOutline,
  rasterRowToPageNumber,
  type JsPdfOutlineLike,
} from './pdf-export';

test('#515 rasterRowToPageNumber maps raster Y to 1-based page numbers', () => {
  assert.equal(rasterRowToPageNumber(0, 1000, null), 1);
  assert.equal(rasterRowToPageNumber(999, 1000, null), 1);
  assert.equal(rasterRowToPageNumber(1000, 1000, null), 2);
  assert.equal(rasterRowToPageNumber(2500, 1000, null), 3);

  // With explicit page breaks from buildPagedCanvas
  const breaks = [920, 1840];
  assert.equal(rasterRowToPageNumber(100, 1000, breaks), 1);
  assert.equal(rasterRowToPageNumber(919, 1000, breaks), 1);
  assert.equal(rasterRowToPageNumber(920, 1000, breaks), 2);
  assert.equal(rasterRowToPageNumber(1839, 1000, breaks), 2);
  assert.equal(rasterRowToPageNumber(1840, 1000, breaks), 3);
});

test('#515 populatePdfOutline builds hierarchical H1-H6 bookmark tree', () => {
  interface MockNode {
    id: number;
    parent: MockNode | null;
    title: string;
    pageNumber: number;
  }
  const calls: MockNode[] = [];
  const outline: JsPdfOutlineLike = {
    add(parent, title, options) {
      const node: MockNode = {
        id: calls.length + 1,
        parent: (parent as MockNode | null) ?? null,
        title,
        pageNumber: options.pageNumber,
      };
      calls.push(node);
      return node;
    },
  };

  populatePdfOutline(outline, [
    { level: 1, text: '第一章 概述', pageNumber: 1 },
    { level: 2, text: '1.1 背景', pageNumber: 1 },
    { level: 3, text: '1.1.1 细节', pageNumber: 2 },
    { level: 2, text: '1.2 目标', pageNumber: 2 },
    { level: 1, text: '第二章 架构', pageNumber: 3 },
    { level: 4, text: '2.0.0.1 跳级小节', pageNumber: 4 },
  ]);

  assert.equal(calls.length, 6);
  // H1 #1 -> root
  assert.equal(calls[0].parent, null);
  assert.equal(calls[0].title, '第一章 概述');
  assert.equal(calls[0].pageNumber, 1);
  // H2 1.1 -> child of H1 #1
  assert.equal(calls[1].parent, calls[0]);
  // H3 1.1.1 -> child of H2 1.1
  assert.equal(calls[2].parent, calls[1]);
  assert.equal(calls[2].pageNumber, 2);
  // H2 1.2 -> sibling of H2 1.1 (child of H1 #1)
  assert.equal(calls[3].parent, calls[0]);
  // H1 #2 -> root
  assert.equal(calls[4].parent, null);
  // Skipped level H4 -> child of H1 #2
  assert.equal(calls[5].parent, calls[4]);
  assert.equal(calls[5].pageNumber, 4);
});
