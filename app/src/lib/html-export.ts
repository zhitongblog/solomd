/**
 * The standalone HTML export: template + pipeline, outside the composable so
 * the dev harness (`/html-harness.html`) runs exactly what the app writes.
 *
 * The file must open anywhere, offline: local images are embedded as `data:`
 * URLs, mermaid/PlantUML fences become inline SVG (#332), and KaTeX's styles
 * and fonts are written in only when the note has math (#313). Nothing in the
 * page points at a CDN.
 */
import { renderMarkdown, extractImageRoot } from './markdown';
import { inlineLocalImages, rewriteLinkUrls, rewriteImageUrls, type BinaryReader } from './image-resolve';
import { inlineDiagramsInHtml } from './diagram-export';
import { hasKatex, standaloneKatexCss } from './katex-standalone';
import { loadRenderDeps } from './render-deps';
import { buildExportCustomCss, getActiveCustomCss } from './custom-theme';

export interface HtmlNavOptions {
  navTreeHtml: string;
  isZh: boolean;
}

const NAV_SIDEBAR_CSS = `
  body.has-solomd-nav {
    max-width: none;
    margin: 0;
    padding: 0;
    height: 100vh;
    overflow: hidden;
    display: flex;
    background: #f3f4f6;
  }
  .solomd-export-sidebar {
    width: 320px;
    min-width: 240px;
    max-width: 520px;
    height: 100vh;
    display: flex;
    flex-direction: column;
    padding: 12px 10px 12px 12px;
    background: #f3f4f6;
    border-right: 1px solid var(--rule, #d0d7de);
    box-sizing: border-box;
    flex-shrink: 0;
    user-select: none;
  }
  .solomd-export-tabs {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    padding-left: 2px;
    margin-bottom: -1px;
    z-index: 2;
  }
  .solomd-export-tab {
    appearance: none;
    border: 1px solid #b8c0c8;
    border-bottom: 1px solid #b8c0c8;
    background: #e5e7eb;
    color: var(--ink, #1f2328);
    font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    padding: 6px 14px;
    border-radius: 4px 4px 0 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background 0.15s;
  }
  .solomd-export-tab:hover {
    background: #eef0f3;
  }
  .solomd-export-tab.is-active {
    background: #ffffff;
    border-bottom-color: #ffffff;
    font-weight: 600;
  }
  .solomd-search-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: #dc2626;
    color: #ffffff;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
  }
  .solomd-search-badge[hidden] {
    display: none !important;
  }
  .solomd-export-panel {
    flex: 1;
    min-height: 0;
    background: #ffffff;
    border: 1px solid #b8c0c8;
    border-radius: 0 4px 4px 4px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .solomd-nav-pane {
    flex: 1;
    overflow: auto;
    padding: 12px 14px;
    font-size: 14px;
    line-height: 1.6;
  }
  .solomd-nav-pane[hidden],
  .solomd-search-pane[hidden] {
    display: none !important;
  }
  .solomd-nav-pane ul.md-toc__list {
    margin: 0;
    padding-left: 18px;
    list-style-type: disc;
  }
  .solomd-nav-pane ul.md-toc__list ul.md-toc__list {
    padding-left: 20px;
    list-style-type: circle;
  }
  .solomd-nav-pane ul.md-toc__list ul.md-toc__list ul.md-toc__list {
    list-style-type: square;
  }
  .solomd-nav-pane li.md-toc__item {
    margin: 4px 0;
  }
  .solomd-nav-pane a.md-toc__link {
    color: var(--link, #0b5cad);
    text-decoration: none;
    border-bottom: 1px solid var(--link-soft, #c9dcf0);
    padding: 1px 4px;
    border-radius: 3px;
    transition: background 0.15s, color 0.15s;
  }
  .solomd-nav-pane a.md-toc__link:hover {
    background: #eff6ff;
    border-bottom-color: var(--link, #0b5cad);
  }
  .solomd-nav-pane a.md-toc__link.is-active {
    background: #dbeafe;
    color: #1d4ed8;
    font-weight: 600;
  }
  .solomd-search-pane {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 10px;
    gap: 8px;
  }
  .solomd-search-bar {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .solomd-search-input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    font-size: 13px;
    border: 1px solid #b8c0c8;
    border-radius: 3px;
    outline: none;
    color: var(--ink, #1f2328);
    background: #ffffff;
  }
  .solomd-search-input:focus {
    border-color: var(--link, #0b5cad);
    box-shadow: 0 0 0 2px rgba(11, 92, 173, 0.15);
  }
  .solomd-search-clear {
    padding: 6px 12px;
    font-size: 13px;
    border: 1px solid #b8c0c8;
    border-radius: 3px;
    background: #f3f4f6;
    color: var(--ink, #1f2328);
    cursor: pointer;
    white-space: nowrap;
  }
  .solomd-search-clear:hover {
    background: #e5e7eb;
  }
  .solomd-search-results {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border: 1px solid #d0d7de;
    background: #ffffff;
    font-size: 13px;
  }
  .solomd-search-item {
    padding: 6px 10px;
    border-bottom: 1px solid #f0f2f4;
    cursor: pointer;
    user-select: none;
  }
  .solomd-search-item:hover {
    background: #f3f4f6;
  }
  .solomd-search-item.is-active {
    background: #2563eb;
    color: #ffffff;
  }
  .solomd-search-item__title {
    font-weight: 600;
    font-size: 13px;
    color: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .solomd-search-item__snippet {
    font-size: 12px;
    color: var(--ink-muted, #59636e);
    margin-top: 2px;
    line-height: 1.45;
    word-break: break-all;
  }
  .solomd-search-item.is-active .solomd-search-item__snippet {
    color: rgba(255, 255, 255, 0.9);
  }
  .solomd-search-item mark {
    background: #fef08a;
    color: #854d0e;
    padding: 0 2px;
    border-radius: 2px;
  }
  .solomd-search-empty {
    padding: 16px 10px;
    text-align: center;
    color: var(--ink-muted, #59636e);
    font-size: 12px;
  }
  .solomd-export-main {
    flex: 1;
    min-width: 0;
    height: 100vh;
    overflow: auto;
    background: var(--paper, #ffffff);
    padding: 40px 56px 96px;
    box-sizing: border-box;
  }
  .solomd-export-article {
    max-width: 820px;
    margin: 0 auto;
  }
  .solomd-search-flash {
    outline: 2px solid #f59e0b;
    background-color: rgba(254, 240, 138, 0.65) !important;
    border-radius: 4px;
    transition: background-color 0.4s ease;
  }
  @media (max-width: 768px) {
    body.has-solomd-nav {
      flex-direction: column;
      height: auto;
      overflow: auto;
    }
    .solomd-export-sidebar {
      width: 100%;
      max-width: none;
      height: 320px;
      border-right: none;
      border-bottom: 1px solid var(--rule, #d0d7de);
    }
    .solomd-export-main {
      height: auto;
      padding: 24px 20px 64px;
    }
  }
  @media print {
    body.has-solomd-nav {
      display: block;
      height: auto;
      overflow: visible;
      background: #ffffff;
    }
    .solomd-export-sidebar {
      display: none !important;
    }
    .solomd-export-main {
      height: auto;
      overflow: visible;
      padding: 0;
    }
    .solomd-export-article {
      max-width: none;
    }
  }
`;

const NAV_SIDEBAR_SCRIPT = `<script>
(function () {
  var tabs = document.querySelectorAll('.solomd-export-tab');
  var navPane = document.getElementById('solomd-nav-pane');
  var searchPane = document.getElementById('solomd-search-pane');
  var searchInput = document.getElementById('solomd-search-input');
  var searchClear = document.getElementById('solomd-search-clear');
  var searchResults = document.getElementById('solomd-search-results');
  var searchBadge = document.getElementById('solomd-search-badge');
  var mainEl = document.getElementById('solomd-export-main');
  var articleEl = document.getElementById('solomd-export-article');
  if (!navPane || !searchPane || !mainEl || !articleEl) return;

  function switchTab(tabName) {
    for (var i = 0; i < tabs.length; i++) {
      var btn = tabs[i];
      var active = btn.getAttribute('data-tab') === tabName;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (tabName === 'search') {
      navPane.hidden = true;
      searchPane.hidden = false;
      if (searchInput) searchInput.focus();
    } else {
      searchPane.hidden = true;
      navPane.hidden = false;
    }
  }

  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () {
      switchTab(this.getAttribute('data-tab') || 'nav');
    });
  }

  var flashTimer = null;
  var lastFlashed = null;
  function flashTarget(el) {
    if (!el) return;
    if (lastFlashed) lastFlashed.classList.remove('solomd-search-flash');
    if (flashTimer) clearTimeout(flashTimer);
    lastFlashed = el;
    el.classList.add('solomd-search-flash');
    flashTimer = setTimeout(function () {
      el.classList.remove('solomd-search-flash');
      if (lastFlashed === el) lastFlashed = null;
    }, 2200);
  }

  var navLinks = Array.prototype.slice.call(navPane.querySelectorAll('a.md-toc__link'));
  function setActiveNavLink(link) {
    for (var j = 0; j < navLinks.length; j++) {
      navLinks[j].classList.toggle('is-active', navLinks[j] === link);
    }
  }

  for (var k = 0; k < navLinks.length; k++) {
    navLinks[k].addEventListener('click', function (e) {
      var href = this.getAttribute('href') || '';
      if (href.charAt(0) !== '#') return;
      var rawId = href.slice(1);
      var decodedId = rawId;
      try { decodedId = decodeURIComponent(rawId); } catch (_) {}
      var target = document.getElementById(decodedId) || document.getElementById(rawId);
      if (target) {
        e.preventDefault();
        setActiveNavLink(this);
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        flashTarget(target);
      }
    });
  }

  var headings = Array.prototype.slice.call(articleEl.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'));
  mainEl.addEventListener('scroll', function () {
    if (!headings.length || !navLinks.length) return;
    var mainRect = mainEl.getBoundingClientRect();
    var currentId = headings[0].id;
    for (var h = 0; h < headings.length; h++) {
      var r = headings[h].getBoundingClientRect();
      if (r.top - mainRect.top <= 80) {
        currentId = headings[h].id;
      } else {
        break;
      }
    }
    for (var m = 0; m < navLinks.length; m++) {
      var href = navLinks[m].getAttribute('href') || '';
      var linkId = href.charAt(0) === '#' ? href.slice(1) : '';
      try { linkId = decodeURIComponent(linkId); } catch (_) {}
      if (linkId === currentId) {
        setActiveNavLink(navLinks[m]);
        break;
      }
    }
  }, { passive: true });

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c;
    });
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^$\x7b\x7d()|[\\]\\\\]/g, '\\\\$&');
  }

  var searchBlocks = Array.prototype.slice.call(
    articleEl.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, pre, dt, dd')
  ).filter(function (el) {
    return !el.closest('.md-toc');
  });

  function nearestHeadingTitle(el) {
    if (/^H[1-6]$/.test(el.tagName)) {
      return (el.textContent || '').trim();
    }
    var cur = el;
    while (cur && cur !== articleEl) {
      var prev = cur.previousElementSibling;
      while (prev) {
        if (/^H[1-6]$/.test(prev.tagName)) {
          return (prev.textContent || '').trim();
        }
        prev = prev.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    return document.title || '';
  }

  function runSearch() {
    if (!searchInput || !searchResults) return;
    var kw = (searchInput.value || '').trim();
    if (!kw) {
      searchResults.innerHTML = '';
      if (searchBadge) {
        searchBadge.textContent = '0';
        searchBadge.hidden = true;
      }
      return;
    }
    var lowerKw = kw.toLowerCase();
    var re = new RegExp(escapeRegex(kw), 'gi');
    var matches = [];
    for (var idx = 0; idx < searchBlocks.length; idx++) {
      var blk = searchBlocks[idx];
      if (blk.querySelector && blk.querySelector('p, li, td, th, pre, blockquote')) continue;
      var text = (blk.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!text) continue;
      var pos = text.toLowerCase().indexOf(lowerKw);
      if (pos < 0) continue;
      var start = Math.max(0, pos - 24);
      var end = Math.min(text.length, pos + kw.length + 44);
      var rawSlice = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
      var snippet = escapeHtml(rawSlice).replace(re, function (m) {
        return '<mark>' + m + '</mark>';
      });
      var secTitle = nearestHeadingTitle(blk) || text.slice(0, 32);
      matches.push({
        el: blk,
        title: secTitle,
        snippet: snippet
      });
    }

    if (searchBadge) {
      if (matches.length > 0) {
        searchBadge.textContent = String(matches.length);
        searchBadge.hidden = false;
      } else {
        searchBadge.textContent = '0';
        searchBadge.hidden = true;
      }
    }

    if (matches.length === 0) {
      var emptyMsg = searchResults.getAttribute('data-empty-text') || '没有匹配结果';
      searchResults.innerHTML = '<div class="solomd-search-empty">' + escapeHtml(emptyMsg) + '</div>';
      return;
    }

    var html = '';
    for (var r = 0; r < matches.length; r++) {
      html += '<div class="solomd-search-item" data-match-index="' + r + '">' +
        '<div class="solomd-search-item__title">' + escapeHtml(matches[r].title) + '</div>' +
        '<div class="solomd-search-item__snippet">' + matches[r].snippet + '</div>' +
        '</div>';
    }
    searchResults.innerHTML = html;

    var items = searchResults.querySelectorAll('.solomd-search-item');
    for (var c = 0; c < items.length; c++) {
      items[c].addEventListener('click', function () {
        for (var x = 0; x < items.length; x++) {
          items[x].classList.toggle('is-active', items[x] === this);
        }
        var mIdx = parseInt(this.getAttribute('data-match-index') || '0', 10);
        var matchObj = matches[mIdx];
        if (matchObj && matchObj.el) {
          matchObj.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          flashTarget(matchObj.el);
        }
      });
    }
  }

  var debounceTimer = null;
  if (searchInput) {
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (debounceTimer) clearTimeout(debounceTimer);
        runSearch();
      }
    });
    searchInput.addEventListener('input', function () {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runSearch, 120);
    });
  }

  if (searchClear) {
    searchClear.addEventListener('click', function () {
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      if (searchResults) searchResults.innerHTML = '';
      if (searchBadge) {
        searchBadge.textContent = '0';
        searchBadge.hidden = true;
      }
      if (lastFlashed) {
        lastFlashed.classList.remove('solomd-search-flash');
        lastFlashed = null;
      }
    });
  }
})();
</script>`;

export const HTML_TEMPLATE = (
  title: string,
  body: string,
  headCss = '',
  customCss = '',
  bodyClasses = '',
  navOptions?: HtmlNavOptions,
) => `<!doctype html>
<html lang="${navOptions?.isZh ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${headCss ? `<style>${headCss}</style>\n` : ''}<style>
  /* White paper (#332 follow-up): the warm off-white page, beige code blocks
     and orange table headers read as "yellow" on screen and looked
     unprofessional in a file people hand to others. Backgrounds are neutral,
     and so are the accents: the orange h1 rule and quote bar still read as
     unserious on paper (second #332 follow-up), so rules and bars are dark
     gray and links a sober blue. Deliberately no dark-mode variant: the file
     is a document, and mermaid diagrams are rendered for a light page. */
  :root {
    --accent-rule: var(--md-h1, var(--accent, #3d444d));
    --link: var(--accent-text, var(--md-link, #0b5cad));
    --link-soft: #c9dcf0;
    --ink: var(--text, #1f2328);
    --ink-muted: var(--text-muted, #59636e);
    --rule: var(--border, #e4e6e9);
    --paper: var(--bg, #ffffff);
    --code-bg: var(--fill-1, var(--md-code-bg, #f6f8fa));
    --code-key: var(--syn-keyword, #cf222e);
    --row-alt: #f9fafb;
    --thead-bg: #f3f4f6;
    --quote-bg: #f9fafb;
  }
  html, body { background: var(--paper); }
  body {
    max-width: 760px;
    margin: 56px auto;
    padding: 0 56px 96px;
    font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto,
      "Helvetica Neue", Arial,
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
      "Noto Sans CJK SC", "WenQuanYi Micro Hei",
      system-ui, sans-serif;
    color: var(--ink);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    /* #293 — words joined by NO-BREAK SPACE (Word / web / chat pastes) form a
       single unbreakable run; without this the exported page overflows its
       760px column exactly the way the preview used to. */
    overflow-wrap: break-word;
  }
  h1, h2, h3, h4, h5, h6 {
    line-height: 1.25;
    font-weight: 700;
    color: var(--ink);
    margin: 2em 0 0.6em;
  }
  h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
  h1 {
    font-size: 2.15em;
    color: var(--md-h1, var(--ink));
    border-bottom: 2px solid var(--accent-rule);
    padding-bottom: .35em;
    letter-spacing: -0.01em;
  }
  h2 {
    font-size: 1.55em;
    color: var(--md-h2, var(--ink));
    border-bottom: 1px solid var(--rule);
    padding-bottom: .25em;
  }
  h3 { font-size: 1.25em; color: var(--md-h3, var(--ink)); }
  h4 { font-size: 1.05em; color: var(--md-h4, var(--ink)); }
  h5, h6 { font-size: 1em; color: var(--md-h5, var(--ink-muted)); }
  p { margin: .9em 0; }
  a {
    color: var(--link);
    text-decoration: none;
    border-bottom: 1px solid var(--link-soft);
  }
  a:hover { border-bottom-color: var(--link); }
  strong { color: var(--md-strong, var(--ink)); }
  em { color: var(--md-em, var(--ink)); }
  code {
    font-family: "JetBrains Mono", "SF Mono", "Menlo", "Consolas",
      "Liberation Mono", monospace;
    font-size: .9em;
    background: var(--code-bg);
    padding: .15em .45em;
    border-radius: 4px;
    color: var(--md-code, var(--ink));
  }
  pre {
    background: var(--code-bg);
    padding: 16px 20px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 1.2em 0;
    line-height: 1.55;
    border: 1px solid var(--rule);
  }
  pre code {
    background: transparent;
    padding: 0;
    color: var(--md-code, var(--ink));
    font-size: .88em;
  }
  pre code .hljs-keyword,
  pre code .hljs-built_in,
  pre code .hljs-tag { color: var(--code-key); }
  blockquote {
    border-left: 4px solid var(--accent-rule);
    background: var(--quote-bg);
    margin: 1.4em 0;
    padding: .5em 1.2em;
    color: var(--md-quote, var(--ink-muted));
    font-style: italic;
    border-radius: 0 4px 4px 0;
  }
  blockquote p { margin: .4em 0; }
  ul, ol { padding-left: 1.8em; margin: .9em 0; }
  li { margin: .3em 0; }
  li > p { margin: .3em 0; }
  table {
    border-collapse: collapse;
    margin: 1.4em 0;
    width: 100%;
    font-size: .95em;
  }
  th, td {
    border: 1px solid var(--rule);
    padding: 8px 14px;
    text-align: left;
    /* #370 — a long unbreakable run breaks inside its cell instead of pushing
       the table past the page (and off the paper when printed). */
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  th::after, td::after {
    content: '\\00a0';
    display: inline-block;
    width: 0;
    overflow: hidden;
    visibility: hidden;
  }
  /* #271 — short cells stay on one line (see markdown.ts table_short_cells). */
  .cell-nowrap { white-space: nowrap; }
  thead th {
    background: var(--thead-bg);
    color: var(--ink);
    font-weight: 700;
    border-bottom: 2px solid var(--rule);
  }
  tbody tr:nth-child(even) { background: var(--row-alt); }
  hr {
    border: none;
    border-top: 1px solid var(--md-hr, var(--rule));
    margin: 2.4em 0;
  }
  img {
    max-width: 100%;
    border-radius: 6px;
    margin: 1.2em 0;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .08);
  }
  .katex-display { overflow-x: auto; overflow-y: hidden; padding: 0.5em 0; margin: 0.7em 0; }
  .mermaid-block, .plantuml-block { display: flex; justify-content: center; margin: 1.5em 0; }
  .mermaid-block svg, .plantuml-block svg { max-width: 100%; height: auto; }
  .plantuml-block img { box-shadow: none; border-radius: 0; margin: 0; }
  pre.mermaid-error { color: #b42318; white-space: pre-wrap; }
  /* #454 — code block soft-wrap & line numbers in standalone HTML export */
  .preview-content.cb-wrap-on pre {
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: break-word;
    overflow-x: visible;
  }
  .preview-content.cb-numbered-on pre.cb-numbered {
    counter-reset: cb-line;
    padding-left: 0;
  }
  .preview-content.cb-numbered-on pre.cb-numbered code {
    display: block;
    white-space: normal;
  }
  .preview-content.cb-numbered-on pre.cb-numbered code .cb-line {
    counter-increment: cb-line;
    display: block;
    padding-left: 3.4em;
    position: relative;
    white-space: pre;
  }
  .preview-content.cb-wrap-on.cb-numbered-on pre.cb-numbered code .cb-line {
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: break-word;
  }
  .preview-content.cb-numbered-on pre.cb-numbered code .cb-line::before {
    content: counter(cb-line);
    position: absolute;
    left: 0;
    width: 2.6em;
    padding-right: 0.6em;
    text-align: right;
    color: var(--ink-muted, #59636e);
    border-right: 1px solid var(--rule, #e4e6e9);
    user-select: none;
    -webkit-user-select: none;
  }${navOptions ? NAV_SIDEBAR_CSS : ''}
</style>${customCss ? `\n<style id="solomd-custom-theme">\n${customCss}\n</style>` : ''}
</head>
<body class="${['preview-content', bodyClasses, navOptions ? 'has-solomd-nav' : ''].filter(Boolean).join(' ')}">
${
  navOptions
    ? `<aside class="solomd-export-sidebar" aria-label="${navOptions.isZh ? '文档导航与全局搜索' : 'Document Navigation & Search'}">
  <div class="solomd-export-tabs" role="tablist">
    <button type="button" class="solomd-export-tab is-active" data-tab="nav" role="tab" aria-selected="true">${navOptions.isZh ? '导航栏' : 'Navigation'}</button>
    <button type="button" class="solomd-export-tab" data-tab="search" role="tab" aria-selected="false">
      <span>${navOptions.isZh ? '全局搜索' : 'Search'}</span>
      <span id="solomd-search-badge" class="solomd-search-badge" hidden>0</span>
    </button>
  </div>
  <div class="solomd-export-panel">
    <nav id="solomd-nav-pane" class="solomd-nav-pane" role="tabpanel">${navOptions.navTreeHtml}</nav>
    <div id="solomd-search-pane" class="solomd-search-pane" role="tabpanel" hidden>
      <div class="solomd-search-bar">
        <input id="solomd-search-input" type="text" class="solomd-search-input" placeholder="${navOptions.isZh ? '搜索关键字，回车搜索' : 'Type keyword, press Enter'}" autocomplete="off" />
        <button id="solomd-search-clear" type="button" class="solomd-search-clear">${navOptions.isZh ? '清除' : 'Clear'}</button>
      </div>
      <div id="solomd-search-results" class="solomd-search-results" data-empty-text="${navOptions.isZh ? '没有匹配结果' : 'No matching results'}"></div>
    </div>
  </div>
</aside>
<main id="solomd-export-main" class="solomd-export-main">
  <article id="solomd-export-article" class="solomd-export-article">
${body}
  </article>
</main>
${NAV_SIDEBAR_SCRIPT}`
    : body
}
</body>
</html>`;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
  );
}

function stripTagsAndComments(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

interface ExtractedHeading {
  level: number;
  text: string;
  id: string;
  isFolder: boolean;
}

function buildNestedTocHtml(headings: ExtractedHeading[]): string {
  if (headings.length === 0) return '<ul class="md-toc__list"></ul>';
  // Point folder nodes directly at the first note heading beneath them (#562)
  for (let k = headings.length - 2; k >= 0; k--) {
    if (headings[k].isFolder && headings[k + 1].level > headings[k].level) {
      headings[k].id = headings[k + 1].id;
    }
  }
  const levelStack: number[] = [];
  let html = '';
  for (const h of headings) {
    while (levelStack.length > 0 && levelStack[levelStack.length - 1] >= h.level) {
      levelStack.pop();
      html += '</li></ul>';
    }
    if (levelStack.length === 0) {
      html += '<ul class="md-toc__list">';
    } else {
      html += '<ul class="md-toc__list">';
    }
    levelStack.push(h.level);
    html += `<li class="md-toc__item"><a href="#${encodeHtmlAttrId(h.id)}" class="md-toc__link">${escapeHtml(h.text)}</a>`;
  }
  while (levelStack.length > 0) {
    levelStack.pop();
    html += '</li></ul>';
  }
  // Merge adjacent sibling `</ul><ul class="md-toc__list">` at the same level
  let prev = '';
  while (prev !== html) {
    prev = html;
    html = html.replace(/<\/ul><ul class="md-toc__list">/g, '');
  }
  return html;
}

function encodeHtmlAttrId(id: string): string {
  return escapeHtml(id);
}

/**
 * #570 — Ensure every `<h1..h6>` in `rawBody` has an `id`, extract or build
 * the hierarchical bookmark tree for the left navigation pane, and remove
 * the duplicate top-of-page `<nav class="md-toc">` when the sidebar owns it.
 */
export function prepareHtmlNavSidebar(
  rawBody: string,
  fallbackTitle: string,
): { body: string; navTreeHtml: string } {
  let headingCounter = 0;
  const headings: ExtractedHeading[] = [];

  const bodyWithIds = rawBody.replace(
    /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (_full, lvlStr: string, attrs: string, inner: string) => {
      headingCounter++;
      const tagLevel = Number.parseInt(lvlStr, 10);
      const customLevelMatch = /\bdata-toc-level=(["'])(\d+)\1/i.exec(attrs);
      const level = customLevelMatch ? Number.parseInt(customLevelMatch[2], 10) : tagLevel;
      const isFolder = /\bdata-toc-folder=(["'])1\1/i.test(attrs);
      const idMatch = /\bid=(["'])([^"']+)\1/i.exec(attrs);
      const id = idMatch ? idMatch[2] : `solomd-h-${headingCounter}`;
      const nextAttrs = idMatch ? attrs : `${attrs} id="${id}"`;
      const text = stripTagsAndComments(inner);
      if (text) {
        headings.push({ level, text, id, isFolder });
      }
      return `<h${lvlStr}${nextAttrs}>${inner}</h${lvlStr}>`;
    },
  );

  const tocMatch = /<nav\s+class=(["'])md-toc\1[^>]*>([\s\S]*?)<\/nav>/i.exec(bodyWithIds);
  if (tocMatch) {
    const navTreeHtml = tocMatch[2].trim();
    const cleanedBody = bodyWithIds.replace(tocMatch[0], '');
    return { body: cleanedBody, navTreeHtml };
  }

  if (headings.length === 0 && fallbackTitle.trim()) {
    headings.push({ level: 1, text: fallbackTitle.trim(), id: 'solomd-h-root', isFolder: false });
  }
  return {
    body: bodyWithIds,
    navTreeHtml: buildNestedTocHtml(headings),
  };
}


export interface StandaloneHtmlInput {
  content: string;
  title: string;
  filePath?: string;
  /** PlantUML server — only when the user has PlantUML turned on. */
  plantumlServer?: string | null;
  /** Byte reader for local images (tests/harness); defaults to the Tauri one. */
  readBytes?: BinaryReader;
  /** #439 — optional custom CSS override; defaults to active `<style id="solomd-custom-theme">`. */
  customCss?: string;
  /** #454 — render line numbers inside fenced code blocks when enabled. */
  codeBlockLineNumbers?: boolean;
  /** #454 — soft-wrap long lines inside fenced code blocks when enabled. */
  codeBlockWrap?: boolean;
  /** #570 — include left navigation (bookmark tree) & global search multi-tab sidebar. */
  withNav?: boolean;
  /** Optional UI language ('zh' | 'en', defaults to auto-detecting CJK). */
  lang?: string;
}

export async function buildStandaloneHtml(input: StandaloneHtmlInput): Promise<string> {
  // An export is rendered once: never with placeholder math / plain code.
  await loadRenderDeps();
  const imageRoot = extractImageRoot(input.content);
  // Local images are embedded as `data:` URLs first: a standalone .html has
  // no way to reach the app's `asset.localhost` protocol, so rewriting the
  // src into one — which is what makes images load inside the webview — left
  // every figure broken in the exported file.
  const withImages = await inlineLocalImages(
    renderMarkdown(input.content),
    imageRoot,
    input.filePath,
    input.readBytes,
  );
  // #332 — diagrams become inline SVG, so the page shows them offline
  // instead of the fence source.
  const withDiagrams = await inlineDiagramsInHtml(withImages, {
    plantumlServer: input.plantumlServer,
  });
  // v4.3.0 issue #77 — local-file `href` / `src` URLs become absolute
  // `file://` paths so the export doesn't bake in `http://tauri.localhost/...`.
  let body = rewriteLinkUrls(
    rewriteImageUrls(withDiagrams, imageRoot, input.filePath),
    imageRoot,
    input.filePath,
  );
  // #313 / #332 — KaTeX's stylesheet and fonts go into the file, and only
  // when there is math. This was a render-blocking jsDelivr <link>.
  const headCss = hasKatex(body) ? await standaloneKatexCss() : '';
  const rawCustomCss = input.customCss !== undefined ? input.customCss : getActiveCustomCss();
  const customCss = buildExportCustomCss(rawCustomCss, 'body.preview-content');
  const bodyClasses = [
    input.codeBlockLineNumbers ? 'cb-numbered-on' : '',
    input.codeBlockWrap ? 'cb-wrap-on' : '',
  ]
    .filter(Boolean)
    .join(' ');
  let navOptions: HtmlNavOptions | undefined;
  if (input.withNav) {
    const prepared = prepareHtmlNavSidebar(body, input.title);
    body = prepared.body;
    const isZh =
      input.lang !== undefined
        ? input.lang === 'zh'
        : /[\u4e00-\u9fff]/.test(`${input.title} ${input.content.slice(0, 500)}`);
    navOptions = {
      navTreeHtml: prepared.navTreeHtml,
      isZh,
    };
  }
  return HTML_TEMPLATE(input.title, body, headCss, customCss, bodyClasses, navOptions);
}
