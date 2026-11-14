import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildHtml2PdfOptions,
  encodePdfOutlineString,
  populatePdfLinks,
  populatePdfOutline,
  rasterRowToPageLocation,
  rasterRowToPageNumber,
  type JsPdfLinkLike,
  type JsPdfLinkTargetOptions,
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

test('#563 populatePdfOutline patches makeString with UTF-16BE hex string so 0x0D bytes (名 U+540D, 不 U+4E0D) are never corrupted to 0x0A (吊, 上)', () => {
  const outline: JsPdfOutlineLike = {
    add(_parent, title) {
      return { title };
    },
    makeString(val: string) {
      return `(${val})`;
    },
  };

  populatePdfOutline(outline, [{ level: 1, text: '01 书籍名与名不虚传', pageNumber: 1 }]);

  // Pure ASCII stays a literal string via the original makeString
  assert.equal(outline.makeString!('Chapter 1: Intro'), '(Chapter 1: Intro)');

  // CJK characters containing 0x0D low byte (名=540D, 不=4E0D) are encoded as <FEFF...>
  const hex = outline.makeString!('名不虚传');
  assert.equal(hex, '<FEFF540D4E0D865A4F20>');
  assert.equal(encodePdfOutlineString('01 书籍名'), '<FEFF0030003100204E667C4D540D>');
});

test('#567 buildHtml2PdfOptions disables html2pdf hyperlinks plugin so #anchor links never become http://tauri.localhost/#... external URLs', () => {
  const opts = buildHtml2PdfOptions('MyBook');
  assert.equal(opts.enableLinks, false);
});

test('#566 & #567 populatePdfLinks maps internal TOC/#anchor links to native PDF page destinations and keeps external links', () => {
  const breaks = [900, 1800];
  assert.deepEqual(rasterRowToPageLocation(200, 1000, breaks), {
    pageNumber: 1,
    offsetInPagePx: 200,
  });
  assert.deepEqual(rasterRowToPageLocation(950, 1000, breaks), {
    pageNumber: 2,
    offsetInPagePx: 50,
  });
  assert.deepEqual(rasterRowToPageLocation(1900, 1000, breaks), {
    pageNumber: 3,
    offsetInPagePx: 100,
  });

  const recorded: Array<{
    page: number;
    x: number;
    y: number;
    w: number;
    h: number;
    options: JsPdfLinkTargetOptions;
  }> = [];
  let activePage = 1;
  const pdf: JsPdfLinkLike = {
    setPage(p: number) {
      activePage = p;
    },
    link(x, y, w, h, options) {
      recorded.push({ page: activePage, x, y, w, h, options });
    },
    internal: {
      getNumberOfPages: () => 3,
    },
  };

  populatePdfLinks(
    pdf,
    [
      // TOC entry on Page 1 jumping to Chapter 1 on Page 2 (y = 950 -> offset 50px on page 2)
      {
        kind: 'internal',
        rectRaster: { x: 100, y: 200, width: 600, height: 30 },
        targetRasterY: 950,
      },
      // TOC entry on Page 1 jumping to Chapter 2 on Page 3 (y = 1900 -> offset 100px on page 3)
      {
        kind: 'internal',
        rectRaster: { x: 100, y: 250, width: 600, height: 30 },
        targetRasterY: 1900,
      },
      // External HTTPS link on Page 2 (y = 1100 -> offset 200px on page 2)
      {
        kind: 'external',
        rectRaster: { x: 150, y: 1100, width: 200, height: 24 },
        url: 'https://solomd.app/docs',
      },
    ],
    {
      canvasWidth: 1900,
      pageHeightPx: 1000,
      innerWidthMm: 190,
      marginTopMm: 10,
      marginLeftMm: 10,
    },
    breaks,
  );

  assert.equal(recorded.length, 3);
  // 1st TOC link: on page 1, jumps to pageNumber 2 (no external url!)
  assert.equal(recorded[0].page, 1);
  assert.equal(recorded[0].options.url, undefined);
  assert.equal(recorded[0].options.pageNumber, 2);
  assert.equal(recorded[0].x, 20); // 10mm + 100 * 0.1mm
  assert.equal(recorded[0].y, 30); // 10mm + 200 * 0.1mm
  assert.equal(recorded[0].options.top, 13); // 10mm + 50 * 0.1mm - 2mm

  // 2nd TOC link: on page 1, jumps to pageNumber 3
  assert.equal(recorded[1].page, 1);
  assert.equal(recorded[1].options.pageNumber, 3);
  assert.equal(recorded[1].options.top, 18); // 10mm + 100 * 0.1mm - 2mm

  // 3rd link: external URL on page 2
  assert.equal(recorded[2].page, 2);
  assert.equal(recorded[2].options.url, 'https://solomd.app/docs');
  assert.equal(recorded[2].y, 30); // 10mm + (1100 - 900) * 0.1mm
});
