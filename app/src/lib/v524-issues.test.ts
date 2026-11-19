import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPinia, setActivePinia } from 'pinia';
import { buildMergedBookMarkdown } from './merged-book.ts';
import { renderMarkdown } from './markdown.ts';
import { buildStandaloneHtml, paginateHtmlBody } from './html-export.ts';
import { decoratePrintToc } from './print-pages.ts';
import { decoratePdfToc } from './pdf-export.ts';
import { bindDomTableCellEditor } from './cm-live-blocks.ts';
import { safAllFilesAccessStatus, safRequestAllFilesAccess } from './saf-fs.ts';
import { useSettingsStore } from '../stores/settings.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '../..');

function makeLiteDom() {
  class LiteEl {
    tagName: string;
    className = '';
    id = '';
    textContent = '';
    innerHTML = '';
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    children: LiteEl[] = [];
    parentNode: LiteEl | null = null;
    ownerDocument: any = null;
    isConnected = true;

    constructor(tag: string, ownerDoc: any) {
      this.tagName = tag.toUpperCase();
      this.ownerDocument = ownerDoc;
    }

    get firstChild(): LiteEl | null {
      return this.children[0] ?? null;
    }

    get firstElementChild(): LiteEl | null {
      return this.children.find((c) => c.tagName !== '#TEXT') ?? null;
    }

    get nextSibling(): LiteEl | null {
      if (!this.parentNode) return null;
      const idx = this.parentNode.children.indexOf(this);
      return idx >= 0 && idx + 1 < this.parentNode.children.length
        ? this.parentNode.children[idx + 1]
        : null;
    }

    get nextElementSibling(): LiteEl | null {
      if (!this.parentNode) return null;
      const idx = this.parentNode.children.indexOf(this);
      if (idx < 0) return null;
      for (let i = idx + 1; i < this.parentNode.children.length; i++) {
        if (this.parentNode.children[i].tagName !== '#TEXT') return this.parentNode.children[i];
      }
      return null;
    }

    get previousElementSibling(): LiteEl | null {
      if (!this.parentNode) return null;
      const idx = this.parentNode.children.indexOf(this);
      for (let i = idx - 1; i >= 0; i--) {
        if (this.parentNode.children[i].tagName !== '#TEXT') return this.parentNode.children[i];
      }
      return null;
    }

    classList = {
      add: (...tokens: string[]) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const t of tokens) set.add(t);
        this.className = Array.from(set).join(' ');
      },
      remove: (...tokens: string[]) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const t of tokens) set.delete(t);
        this.className = Array.from(set).join(' ');
      },
      contains: (t: string) => this.className.split(/\s+/).filter(Boolean).includes(t),
      toggle: (t: string, force?: boolean) => {
        const has = this.classList.contains(t);
        const next = force ?? !has;
        if (next) this.classList.add(t);
        else this.classList.remove(t);
        return next;
      },
    };

    setAttribute(k: string, v: string) {
      this.attributes.set(k, v);
      if (k === 'class') this.className = v;
      if (k === 'id') this.id = v;
    }
    getAttribute(k: string): string | null {
      if (k === 'class') return this.className || null;
      if (k === 'id') return this.id || null;
      return this.attributes.get(k) ?? null;
    }
    removeAttribute(k: string) {
      this.attributes.delete(k);
    }

    append(...nodes: LiteEl[]) {
      for (const n of nodes) this.appendChild(n);
    }

    appendChild(n: LiteEl) {
      if (n.parentNode) {
        const idx = n.parentNode.children.indexOf(n);
        if (idx >= 0) n.parentNode.children.splice(idx, 1);
      }
      n.parentNode = this;
      this.children.push(n);
      return n;
    }

    prepend(n: LiteEl) {
      if (n.parentNode) {
        const idx = n.parentNode.children.indexOf(n);
        if (idx >= 0) n.parentNode.children.splice(idx, 1);
      }
      n.parentNode = this;
      this.children.unshift(n);
    }

    insertBefore(n: LiteEl, ref: LiteEl | null) {
      if (!ref) return this.appendChild(n);
      if (n.parentNode) {
        const oldIdx = n.parentNode.children.indexOf(n);
        if (oldIdx >= 0) n.parentNode.children.splice(oldIdx, 1);
      }
      n.parentNode = this;
      const idx = this.children.indexOf(ref);
      if (idx >= 0) this.children.splice(idx, 0, n);
      else this.children.push(n);
      return n;
    }

    contains(target: any): boolean {
      if (target === this) return true;
      return this.children.some((c) => c.contains(target));
    }

    matchesSelector(sel: string): boolean {
      const parts = sel.split(',').map((s) => s.trim());
      return parts.some((p) => {
        if (p === 'nav.md-toc') return this.tagName === 'NAV' && this.classList.contains('md-toc');
        if (p === 'a.md-toc__link') return this.tagName === 'A' && this.classList.contains('md-toc__link');
        if (p === '.md-toc__title') return this.classList.contains('md-toc__title');
        if (/^h[1-6]$/i.test(p)) return this.tagName === p.toUpperCase();
        return false;
      });
    }

    querySelectorAll(sel: string): LiteEl[] {
      const out: LiteEl[] = [];
      const walk = (el: LiteEl) => {
        for (const c of el.children) {
          if (c.matchesSelector(sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }

    querySelector(sel: string): LiteEl | null {
      return this.querySelectorAll(sel)[0] ?? null;
    }
  }

  const doc = {
    createElement: (tag: string) => new LiteEl(tag, doc),
  };
  return { doc, LiteEl };
}

test('#615: standalone merged HTML export with withTocPage=false omits TOC <section> and opens directly on first content page', async () => {
  const merged = buildMergedBookMarkdown('生物复习手册', [
    {
      relDir: '第一单元',
      baseName: '01-心脏结构',
      content: '# 心脏四腔\n\n左心室连接主动脉。\n\n## 瓣膜作用\n\n防止血液倒流。',
    },
    {
      relDir: '第一单元',
      baseName: '02-血液循环',
      content: '# 体循环与肺循环\n\n肺动脉流静脉血，肺静脉流动脉血。',
    },
  ]);

  // Consumed <!-- solomd-page-break --> must not leave an empty <div data-source-line> wrapper
  const rendered = renderMarkdown(merged);
  assert.ok(
    !/<div\b[^>]*\bdata-source-line=(?:"\d+"|'\d+')[^>]*>\s*<\/div>/i.test(rendered),
    'renderMarkdown should not emit empty data-source-line wrapper divs before page-break <hr>',
  );

  const htmlNoToc = await buildStandaloneHtml({
    content: merged,
    title: '生物复习手册',
    withNav: true,
    paginated: true,
    topicNav: true,
    withTocPage: false,
    lang: 'zh',
  });

  assert.ok(!htmlNoToc.includes('id="solomd-page-toc"'), 'must not emit #solomd-page-toc when withTocPage=false');
  assert.ok(!htmlNoToc.includes('data-toc-section="1"'), 'must not emit data-toc-section when withTocPage=false');

  const sectionMatches = Array.from(
    htmlNoToc.matchAll(/<section class="page([^"]*)" id="([^"]+)"/g),
  );
  assert.equal(sectionMatches.length, 2, 'should emit exactly 2 content <section> elements for 2 notes');
  assert.equal(sectionMatches[0][2], 'solomd-page-1');
  assert.equal(sectionMatches[1][2], 'solomd-page-2');

  // Verify #solomd-page-1 holds the real first note heading rather than an empty placeholder
  const page1Slice = htmlNoToc.slice(
    htmlNoToc.indexOf('id="solomd-page-1"'),
    htmlNoToc.indexOf('id="solomd-page-2"'),
  );
  assert.ok(page1Slice.includes('心脏四腔'), '#solomd-page-1 must contain the first note content');

  // Also verify paginateHtmlBody drops accidental empty source-line wrapper chunks defensively
  const defensive = paginateHtmlBody(
    '<div data-source-line="5"></div>\n<hr data-solomd-page-break="1">\n<h2 id="ch1">第一章</h2><p>正文</p>',
    { topicNav: true, isZh: true },
  );
  const defSections = defensive.match(/<section class="page/g) ?? [];
  assert.equal(defSections.length, 1, 'empty wrapper chunk before page break must be filtered out');

  // Verify withTocPage=true still emits #solomd-page-toc as expected
  const htmlWithToc = await buildStandaloneHtml({
    content: merged,
    title: '生物复习手册',
    withNav: true,
    paginated: true,
    topicNav: true,
    withTocPage: true,
    lang: 'zh',
  });
  assert.ok(htmlWithToc.includes('id="solomd-page-toc"'), 'withTocPage=true must still emit #solomd-page-toc');
});

test('#614: decoratePrintToc and decoratePdfToc mark TOC after .pdf-book-cover or preamble as md-toc--lead so TOC never shares page with body', () => {
  const { doc } = makeLiteDom();
  const prevDoc = (globalThis as any).document;
  (globalThis as any).document = doc;
  try {
    // 1. Merged folder PDF: <div class="pdf-book-cover"> followed by <nav class="md-toc">
    const mergedRoot = doc.createElement('div');
    const cover = doc.createElement('div');
    cover.className = 'pdf-book-cover';
    const nav1 = doc.createElement('nav');
    nav1.className = 'md-toc';
    const link1 = doc.createElement('a');
    link1.className = 'md-toc__link';
    link1.setAttribute('href', '#ch1');
    nav1.appendChild(link1);
    const bodyH1 = doc.createElement('h1');
    bodyH1.id = 'ch1';
    mergedRoot.append(cover, nav1, bodyH1);

    decoratePrintToc(mergedRoot as any, '目录');
    assert.ok(
      nav1.classList.contains('md-toc--lead'),
      'decoratePrintToc must add md-toc--lead when preceded by .pdf-book-cover',
    );
    assert.ok(nav1.querySelector('.md-toc__title'), 'TOC title should be prepended');

    // 2. Batch folder PDF note with H1 + metadata blockquote before [TOC]
    const noteRoot = doc.createElement('div');
    const docH1 = doc.createElement('h1');
    const metaQuote = doc.createElement('blockquote');
    const nav2 = doc.createElement('nav');
    nav2.className = 'md-toc';
    const secH2 = doc.createElement('h2');
    noteRoot.append(docH1, metaQuote, nav2, secH2);

    decoratePdfToc(noteRoot as any, '目录');
    assert.ok(
      nav2.classList.contains('md-toc--lead'),
      'decoratePdfToc must add md-toc--lead when preceded by H1 + metadata preamble',
    );
    assert.ok(
      nav2.nextElementSibling?.classList.contains('html2pdf__page-break'),
      'decoratePdfToc must insert page-break element after leading TOC',
    );

    // 3. Mid-document TOC placed AFTER an H2 section is NOT marked md-toc--lead
    const midRoot = doc.createElement('div');
    const h1 = doc.createElement('h1');
    const h2 = doc.createElement('h2');
    const navMid = doc.createElement('nav');
    navMid.className = 'md-toc';
    midRoot.append(h1, h2, navMid);
    decoratePrintToc(midRoot as any, '目录');
    assert.ok(!navMid.classList.contains('md-toc--lead'), 'mid-document TOC after H2 must not be md-toc--lead');
  } finally {
    (globalThis as any).document = prevDoc;
  }

  const mainCss = fs.readFileSync(path.join(APP_ROOT, 'src/styles/main.css'), 'utf8');
  assert.ok(
    mainCss.includes('body.solomd-printing .solomd-print-content .pdf-book-cover + .md-toc'),
    'main.css @media print must force page break after .pdf-book-cover + .md-toc',
  );
});

test('#613: tables stretch to width: 100% across Live Edit, Windows Plain Live Editor, Preview, HTML export, and PDF export', () => {
  const cmLive = fs.readFileSync(path.join(APP_ROOT, 'src/lib/cm-live-blocks.ts'), 'utf8');
  const editorVue = fs.readFileSync(path.join(APP_ROOT, 'src/components/Editor.vue'), 'utf8');
  const previewVue = fs.readFileSync(path.join(APP_ROOT, 'src/components/Preview.vue'), 'utf8');

  const liveTableBlock = cmLive.slice(
    cmLive.indexOf("'.cm-live-block--table table'"),
    cmLive.indexOf("'.cm-live-block--table th"),
  );
  assert.ok(liveTableBlock.includes("width: '100%'"), 'cm-live-block--table table must have width: 100%');

  const htmlTableBlock = cmLive.slice(
    cmLive.indexOf("'.cm-live-block--html table'"),
    cmLive.indexOf("'.cm-live-block--html th"),
  );
  assert.ok(htmlTableBlock.includes("width: '100%'"), 'cm-live-block--html table must have width: 100%');

  const plainTableBlock = editorVue.slice(
    editorVue.indexOf('.plain-block__render :deep(table)'),
    editorVue.indexOf('.plain-block__render :deep(th)'),
  );
  assert.ok(plainTableBlock.includes('width: 100%;'), 'plain-block__render table must have width: 100%');

  const previewTableBlock = previewVue.slice(
    previewVue.indexOf(':where(.preview-content) table'),
    previewVue.indexOf(':where(.preview-content) th,'),
  );
  assert.ok(previewTableBlock.includes('width: 100%;'), 'Preview table must have width: 100%');
});

test('#612: lineHeight and paragraphSpacing settings clamp, persist, reset, and exist in all 15 locales', () => {
  setActivePinia(createPinia());
  const settings = useSettingsStore();

  assert.equal(settings.lineHeight, 1.8);
  assert.equal(settings.paragraphSpacing, 0.9);

  settings.setLineHeight(2.25);
  assert.equal(settings.lineHeight, 2.25);
  settings.setLineHeight(9.9);
  assert.equal(settings.lineHeight, 2.6);
  settings.setLineHeight(0.4);
  assert.equal(settings.lineHeight, 1.2);
  settings.resetLineHeight();
  assert.equal(settings.lineHeight, 1.8);

  settings.setParagraphSpacing(1.35);
  assert.equal(settings.paragraphSpacing, 1.35);
  settings.setParagraphSpacing(5);
  assert.equal(settings.paragraphSpacing, 2.0);
  settings.setParagraphSpacing(-1);
  assert.equal(settings.paragraphSpacing, 0);
  settings.resetParagraphSpacing();
  assert.equal(settings.paragraphSpacing, 0.9);

  const i18nDir = path.join(APP_ROOT, 'src/i18n');
  const localeFiles = fs
    .readdirSync(i18nDir)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts');
  assert.ok(localeFiles.length >= 15, 'expected at least 15 locale files');
  for (const file of localeFiles) {
    const src = fs.readFileSync(path.join(i18nDir, file), 'utf8');
    assert.ok(/lineHeight:\s*'[^']+'/.test(src), `${file} missing settings.lineHeight`);
    assert.ok(/paragraphSpacing:\s*'[^']+'/.test(src), `${file} missing settings.paragraphSpacing`);
  }
});

test('#616: live table cell editor sets tabindex=-1 for WKWebView focus, scopes Cmd/Ctrl+A to active cell, and stops bubble keydown propagation', () => {
  const listeners = new Map<string, Array<{ fn: (ev: any) => void; capture: boolean }>>();
  let selectedContentsNode: any = null;

  const mkCell = (row: number, col: number, text: string) => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const cell: any = {
      dataset: { row: String(row), col: String(col) },
      cellIndex: col,
      textContent: text,
      innerHTML: text,
      isConnected: true,
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
      },
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      getAttribute: (k: string) => attrs.get(k) ?? null,
      removeAttribute: (k: string) => attrs.delete(k),
      focus: () => {},
      contains: (n: any) => n === cell,
      querySelectorAll: () => [],
    };
    return cell;
  };

  const c0 = mkCell(-1, 0, '动脉血');
  const c1 = mkCell(-1, 1, '静脉血');
  const tr = { parentElement: null as any, cells: [c0, c1] };
  const tHead = { rows: [tr] };
  tr.parentElement = tHead;
  const table = { tHead, rows: [tr] };
  const wrap: any = {
    dataset: {},
    isConnected: true,
    querySelector: (sel: string) => (sel === 'table' ? table : null),
    addEventListener: (type: string, fn: (ev: any) => void, opts?: any) => {
      const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
      const arr = listeners.get(type) ?? [];
      arr.push({ fn, capture });
      listeners.set(type, arr);
    },
    contains: () => true,
  };

  const prevDoc = (globalThis as any).document;
  const prevWin = (globalThis as any).window;
  (globalThis as any).document = {
    createRange: () => ({
      selectNodeContents: (n: any) => {
        selectedContentsNode = n;
      },
      collapse: () => {},
    }),
  };
  (globalThis as any).window = {
    getSelection: () => ({
      rangeCount: 0,
      removeAllRanges: () => {},
      addRange: () => {},
    }),
    dispatchEvent: () => true,
  };

  try {
    const handle = bindDomTableCellEditor(wrap, {
      source: '| 动脉血 | 静脉血 |\n| --- | --- |\n| 鲜红 | 暗红 |',
      from: 0,
      to: 32,
      isReadOnly: () => false,
      commitMarkdown: () => {},
      exitTable: () => {},
    });
    assert.ok(handle);

    const state = handle.begin({ clientX: 10, clientY: 10, button: 0 } as any, c0);
    assert.equal(state, 'started');
    assert.equal(c0.getAttribute('tabindex'), '-1', 'active cell must carry tabindex=-1 for WKWebView focus');

    const keyListeners = listeners.get('keydown') ?? [];
    const captureListeners = keyListeners.filter((l) => l.capture);
    const bubbleListeners = keyListeners.filter((l) => !l.capture);
    assert.ok(captureListeners.length >= 1 && bubbleListeners.length >= 1);

    // Cmd+A selects only active cell contents and stops propagation
    let cmdAPrevented = false;
    let cmdAStopped = false;
    selectedContentsNode = null;
    const cmdAEv = {
      key: 'a',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: () => {
        cmdAPrevented = true;
      },
      stopPropagation: () => {
        cmdAStopped = true;
      },
    };
    for (const l of captureListeners) l.fn(cmdAEv);
    assert.equal(selectedContentsNode, c0, 'Cmd+A must select active cell contents');
    assert.ok(cmdAPrevented && cmdAStopped, 'Cmd+A must preventDefault and stopPropagation');

    // Shift+ArrowRight (text selection inside cell) is NOT prevented in capture, AND stops bubbling
    let shiftRightPrevented = false;
    let shiftRightStoppedInBubble = false;
    const shiftRightEv = {
      key: 'ArrowRight',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      preventDefault: () => {
        shiftRightPrevented = true;
      },
      stopPropagation: () => {
        shiftRightStoppedInBubble = true;
      },
    };
    for (const l of captureListeners) l.fn(shiftRightEv);
    assert.equal(shiftRightPrevented, false, 'Shift+ArrowRight must NOT be prevented so native selection works');
    for (const l of bubbleListeners) l.fn(shiftRightEv);
    assert.equal(shiftRightStoppedInBubble, true, 'bubble keydown must stopPropagation out of table widget');
  } finally {
    (globalThis as any).document = prevDoc;
    (globalThis as any).window = prevWin;
  }
});

test('#611: Android sideload build injects MANAGE_EXTERNAL_STORAGE only for non-bundle APKs and MainActivity provides full primary: file fallbacks', async () => {
  const status = await safAllFilesAccessStatus();
  assert.equal(status.supported, false);
  assert.equal(status.granted, true);
  await safRequestAllFilesAccess(); // safe no-op off-Android

  const gradleKts = fs.readFileSync(
    path.resolve(APP_ROOT, 'src-tauri/gen/android/app/build.gradle.kts'),
    'utf8',
  );
  assert.ok(
    gradleKts.includes('if (!isBundleTask)') &&
      gradleKts.includes('android.permission.MANAGE_EXTERNAL_STORAGE'),
    'build.gradle.kts must inject MANAGE_EXTERNAL_STORAGE only when !isBundleTask',
  );

  const baseManifest = fs.readFileSync(
    path.resolve(APP_ROOT, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  assert.ok(
    !/<uses-permission[^>]*MANAGE_EXTERNAL_STORAGE/.test(baseManifest),
    'base AndroidManifest.xml (used for Google Play AAB) must NOT declare MANAGE_EXTERNAL_STORAGE',
  );

  const mainActivity = fs.readFileSync(
    path.resolve(APP_ROOT, 'src-tauri/gen/android/app/src/main/java/app/solomd/MainActivity.kt'),
    'utf8',
  );
  assert.ok(mainActivity.includes('fun allFilesAccessStatus(): String'));
  assert.ok(mainActivity.includes('fun requestAllFilesAccess(): String'));
  assert.ok(mainActivity.includes('private fun primaryFileForDocId(docId: String)'));
  assert.ok(mainActivity.includes('solomd:android-storage-resume'));
});
