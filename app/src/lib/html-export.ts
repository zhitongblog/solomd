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
  paginated?: boolean;
  topicNav?: boolean;
}

const NAV_SIDEBAR_CSS = `
  body.has-solomd-nav {
    max-width: none !important;
    width: 100%;
    margin: 0;
    padding: 0;
    height: 100vh;
    overflow: hidden;
    display: flex;
    background: #f3f4f6;
  }
  .solomd-export-sidebar {
    width: 320px;
    min-width: 180px;
    max-width: 72vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    padding: 12px 6px 12px 12px;
    background: #f3f4f6;
    box-sizing: border-box;
    flex-shrink: 0;
    user-select: none;
  }
  .solomd-sidebar-resizer {
    width: 6px;
    height: 100vh;
    cursor: col-resize;
    flex-shrink: 0;
    background: transparent;
    border-right: 1px solid var(--rule, #d0d7de);
    transition: background-color 0.15s, border-color 0.15s;
    z-index: 5;
  }
  .solomd-sidebar-resizer:hover,
  .solomd-sidebar-resizer.is-dragging {
    background: rgba(37, 99, 235, 0.16);
    border-right-color: #2563eb;
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
  .solomd-nav-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .solomd-nav-wrap[hidden],
  .solomd-nav-pane[hidden],
  .solomd-search-pane[hidden] {
    display: none !important;
  }
  .solomd-nav-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: #f8fafc;
    border-bottom: 1px solid #e5e7eb;
    flex-shrink: 0;
  }
  .solomd-nav-tool-btn {
    appearance: none;
    padding: 3px 10px;
    font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    background: #ffffff;
    color: #334155;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .solomd-nav-tool-btn:hover {
    background: #eff6ff;
    border-color: #93c5fd;
    color: #1d4ed8;
  }
  .solomd-nav-pane {
    flex: 1;
    min-height: 0;
    overflow-x: auto;
    overflow-y: auto;
    padding: 10px 12px;
    font-size: 13.5px;
    line-height: 1.55;
  }
  .solomd-nav-pane > ul.md-toc__list {
    padding-left: 0;
    width: max-content;
    min-width: 100%;
    box-sizing: border-box;
  }
  .solomd-nav-pane ul.md-toc__list {
    margin: 0;
    padding-left: 18px;
    list-style: none;
  }
  .solomd-nav-pane li.md-toc__item {
    margin: 2px 0;
    white-space: nowrap;
  }
  .solomd-nav-pane li.md-toc__item.is-collapsed > ul.md-toc__list {
    display: none;
  }
  .solomd-toc-toggle {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-right: 4px;
    padding: 0;
    border: 1px solid #cbd5e1;
    border-radius: 3px;
    background: #f8fafc;
    color: #475569;
    font: 700 12px/1 monospace;
    cursor: pointer;
    vertical-align: middle;
  }
  .solomd-toc-toggle:hover {
    border-color: #2563eb;
    color: #2563eb;
    background: #eff6ff;
  }
  .solomd-toc-spacer {
    display: inline-block;
    width: 16px;
    height: 16px;
    margin-right: 4px;
    vertical-align: middle;
  }
  .solomd-nav-pane a.md-toc__link {
    display: inline-block;
    white-space: nowrap;
    color: var(--ink, #1f2328);
    text-decoration: none;
    border-bottom: none;
    padding: 2px 6px;
    border-radius: 4px;
    cursor: pointer;
    vertical-align: middle;
    transition: background 0.12s, color 0.12s;
  }
  .solomd-nav-pane a.md-toc__link:hover {
    background: #eff6ff;
    color: #1d4ed8;
  }
  .solomd-nav-pane a.md-toc__link.is-active {
    background: #2563EB !important;
    color: #FFFFFF !important;
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
    max-width: var(--solomd-content-max-width, 960px);
    margin: 0 auto;
  }
  .solomd-search-flash {
    outline: 2px solid #f59e0b;
    background-color: rgba(254, 240, 138, 0.65) !important;
    border-radius: 4px;
    transition: background-color 0.4s ease;
  }
  .solomd-toc-page__title {
    font-size: 1.55em;
    font-weight: 700;
    color: var(--ink, #1f2328);
    margin: 0 0 18px;
    padding-bottom: 10px;
    border-bottom: 1px solid #e5e7eb;
  }
  /* #598 — Subtle technical-documentation "< Previous / Next >" topic buttons */
  .solomd-topic-nav--top {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    padding-bottom: 10px;
    margin-bottom: 22px;
    border-bottom: 1px solid #e8ecf0;
  }
  .solomd-topic-nav--bottom {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 14px;
    margin-top: 44px;
    padding-top: 16px;
    border-top: 1px solid #e8ecf0;
  }
  .solomd-topic-btn {
    appearance: none;
    font: 500 12.5px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #475569;
    background: #f8fafc;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    padding: 4px 11px;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .solomd-topic-nav--bottom .solomd-topic-btn {
    padding: 5px 14px;
  }
  .solomd-topic-btn:hover:not(:disabled) {
    background: #eff6ff;
    border-color: #93c5fd;
    color: #1d4ed8;
  }
  .solomd-topic-btn:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }
  @media print {
    .solomd-topic-nav {
      display: none !important;
    }
  }
  @media (max-width: 768px) {
    body {
      max-width: 100% !important;
      padding: 0 20px 64px;
    }
    body.has-solomd-nav {
      flex-direction: column;
      height: auto;
      overflow: auto;
    }
    .solomd-export-sidebar {
      width: 100% !important;
      max-width: none;
      height: 320px;
      padding: 12px;
      border-right: none;
      border-bottom: 1px solid var(--rule, #d0d7de);
    }
    .solomd-sidebar-resizer {
      display: none !important;
    }
    .solomd-export-main {
      height: auto;
      padding: 24px 20px 64px;
    }
    .solomd-export-article {
      max-width: 100% !important;
    }
  }
  @media print {
    body.has-solomd-nav {
      display: block;
      height: auto;
      overflow: visible;
      background: #ffffff;
    }
    .solomd-export-sidebar,
    .solomd-sidebar-resizer {
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
    .solomd-export-article section.page {
      display: block !important;
    }
  }
`;

const NAV_SIDEBAR_SCRIPT = `<script>
(function () {
  var tabs = document.querySelectorAll('.solomd-export-tab');
  var sidebarEl = document.querySelector('.solomd-export-sidebar');
  var resizerEl = document.getElementById('solomd-sidebar-resizer');
  var navWrap = document.getElementById('solomd-nav-wrap');
  var navPane = document.getElementById('solomd-nav-pane');
  var expandBtn = document.getElementById('solomd-nav-expand-btn');
  var collapseBtn = document.getElementById('solomd-nav-collapse-btn');
  var searchPane = document.getElementById('solomd-search-pane');
  var searchInput = document.getElementById('solomd-search-input');
  var searchClear = document.getElementById('solomd-search-clear');
  var searchResults = document.getElementById('solomd-search-results');
  var searchBadge = document.getElementById('solomd-search-badge');
  var mainEl = document.getElementById('solomd-export-main');
  var articleEl = document.getElementById('solomd-export-article');
  if (!navPane || !searchPane || !mainEl || !articleEl) return;

  // 1) Resizable navigation sidebar (#574)
  if (resizerEl && sidebarEl) {
    var dragging = false;
    resizerEl.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      resizerEl.classList.add('is-dragging');
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var maxW = Math.max(260, Math.floor(window.innerWidth * 0.72));
      var nextW = Math.min(maxW, Math.max(180, e.clientX));
      sidebarEl.style.width = nextW + 'px';
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      resizerEl.classList.remove('is-dragging');
      document.body.style.cursor = '';
    });
  }

  function switchTab(tabName) {
    for (var i = 0; i < tabs.length; i++) {
      var btn = tabs[i];
      var active = btn.getAttribute('data-tab') === tabName;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (tabName === 'search') {
      if (navWrap) navWrap.hidden = true;
      else navPane.hidden = true;
      searchPane.hidden = false;
      if (searchInput) searchInput.focus();
    } else {
      searchPane.hidden = true;
      if (navWrap) navWrap.hidden = false;
      navPane.hidden = false;
    }
  }

  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () {
      switchTab(this.getAttribute('data-tab') || 'nav');
    });
  }

  // 2) Tree expand / collapse icons (+/-) & toolbar recursive expand/collapse (#574)
  function findDirectChildList(li) {
    for (var c = 0; c < li.children.length; c++) {
      if (li.children[c].tagName === 'UL') return li.children[c];
    }
    return null;
  }

  function setNodeExpanded(li, expanded) {
    if (!li) return;
    var childUl = findDirectChildList(li);
    if (!childUl) return;
    li.classList.toggle('is-collapsed', !expanded);
    var toggle = li.querySelector(':scope > .solomd-toc-toggle');
    if (toggle) {
      toggle.textContent = expanded ? '-' : '+';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
  }

  function setSubtreeExpanded(rootContainer, expanded) {
    if (!rootContainer) return;
    if (rootContainer.tagName === 'LI') {
      setNodeExpanded(rootContainer, expanded);
    }
    var descendants = rootContainer.querySelectorAll('li.md-toc__item');
    for (var d = 0; d < descendants.length; d++) {
      setNodeExpanded(descendants[d], expanded);
    }
  }

  var allItems = Array.prototype.slice.call(navPane.querySelectorAll('li.md-toc__item'));
  for (var idx = 0; idx < allItems.length; idx++) {
    var li = allItems[idx];
    if (li.querySelector(':scope > .solomd-toc-toggle, :scope > .solomd-toc-spacer')) continue;
    var hasSub = !!findDirectChildList(li);
    if (hasSub) {
      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'solomd-toc-toggle';
      toggleBtn.setAttribute('aria-expanded', 'true');
      toggleBtn.textContent = '-';
      (function (ownerLi) {
        toggleBtn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          var collapsed = ownerLi.classList.contains('is-collapsed');
          setNodeExpanded(ownerLi, collapsed);
        });
      })(li);
      li.insertBefore(toggleBtn, li.firstChild);
    } else {
      var spacer = document.createElement('span');
      spacer.className = 'solomd-toc-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      li.insertBefore(spacer, li.firstChild);
    }
  }

  var activeNavLink = null;
  var navLinks = Array.prototype.slice.call(navPane.querySelectorAll('a.md-toc__link'));
  function setActiveNavLink(link) {
    activeNavLink = link || null;
    for (var j = 0; j < navLinks.length; j++) {
      navLinks[j].classList.toggle('is-active', navLinks[j] === link);
    }
  }

  function expandAncestorsOfLink(link) {
    var p = link ? link.parentElement : null;
    while (p && p !== navPane) {
      if (p.tagName === 'LI' && p.classList.contains('md-toc__item')) {
        setNodeExpanded(p, true);
      }
      p = p.parentElement;
    }
  }

  if (expandBtn) {
    expandBtn.addEventListener('click', function () {
      var selectedLi = activeNavLink && activeNavLink.closest ? activeNavLink.closest('li.md-toc__item') : null;
      setSubtreeExpanded(selectedLi || navPane, true);
    });
  }

  if (collapseBtn) {
    collapseBtn.addEventListener('click', function () {
      var selectedLi = activeNavLink && activeNavLink.closest ? activeNavLink.closest('li.md-toc__item') : null;
      setSubtreeExpanded(selectedLi || navPane, false);
    });
  }

  // 3) Paginated <section class="page"> switching (#574, #594, #598)
  var pageSections = Array.prototype.slice.call(articleEl.querySelectorAll('section.page'));
  var topicSections = pageSections.filter(function (s) {
    return s.getAttribute('data-toc-section') !== '1';
  });
  function activatePageSection(sec) {
    if (!sec || !pageSections.length) return false;
    var changed = false;
    for (var p = 0; p < pageSections.length; p++) {
      var show = pageSections[p] === sec;
      var curHidden = pageSections[p].style.display === 'none';
      if (show && curHidden) changed = true;
      pageSections[p].style.display = show ? 'block' : 'none';
    }
    if (changed) mainEl.scrollTop = 0;
    return changed;
  }

  function activatePageForElement(el) {
    if (!el || !pageSections.length) return;
    if (el.tagName === 'SECTION' && el.classList && el.classList.contains('page')) {
      activatePageSection(el);
      return;
    }
    var sec = el.closest ? el.closest('section.page') : null;
    if (sec) activatePageSection(sec);
  }

  function syncNavToSection(sec) {
    if (!sec || !navLinks.length) return;
    if (sec.id === 'solomd-page-toc') {
      setActiveNavLink(navLinks[0]);
      return;
    }
    var firstHeading = sec.querySelector('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
    if (!firstHeading) return;
    for (var ni = 0; ni < navLinks.length; ni++) {
      var nh = navLinks[ni].getAttribute('href') || '';
      var decodedNh = nh;
      try { decodedNh = decodeURIComponent(nh); } catch (_) {}
      if (nh === '#' + firstHeading.id || decodedNh === '#' + firstHeading.id) {
        expandAncestorsOfLink(navLinks[ni]);
        setActiveNavLink(navLinks[ni]);
        if (navLinks[ni].scrollIntoView) navLinks[ni].scrollIntoView({ block: 'nearest' });
        break;
      }
    }
  }

  if (pageSections.length > 0) {
    var tocSec = document.getElementById('solomd-page-toc');
    if (tocSec) {
      activatePageSection(tocSec);
      if (navLinks.length > 0) setActiveNavLink(navLinks[0]);
    } else {
      activatePageSection(topicSections[0] || pageSections[0]);
      syncNavToSection(topicSections[0] || pageSections[0]);
    }
  }

  var flashTimer = null;
  var lastFlashed = null;
  function flashTarget(el) {
    if (!el) return;
    if (el.tagName === 'SECTION' && el.classList && el.classList.contains('page')) return;
    if (lastFlashed) lastFlashed.classList.remove('solomd-search-flash');
    if (flashTimer) clearTimeout(flashTimer);
    lastFlashed = el;
    el.classList.add('solomd-search-flash');
    flashTimer = setTimeout(function () {
      el.classList.remove('solomd-search-flash');
      if (lastFlashed === el) lastFlashed = null;
    }, 2200);
  }

  for (var k = 0; k < navLinks.length; k++) {
    navLinks[k].addEventListener('click', function (e) {
      e.preventDefault();
      setActiveNavLink(this);
      if (this.getAttribute('data-no-jump') === '1') return;
      var href = this.getAttribute('href') || '';
      if (href.charAt(0) !== '#') return;
      var rawId = href.slice(1);
      if (!rawId) return;
      var decodedId = rawId;
      try { decodedId = decodeURIComponent(rawId); } catch (_) {}
      var target = document.getElementById(decodedId) || document.getElementById(rawId);
      if (target) {
        activatePageForElement(target);
        if (!(target.tagName === 'SECTION' && target.classList && target.classList.contains('page'))) {
          target.scrollIntoView({ behavior: pageSections.length ? 'auto' : 'smooth', block: 'start' });
          flashTarget(target);
        }
      }
    });
  }

  articleEl.addEventListener('click', function (e) {
    var targetEl = e.target;
    if (!targetEl || !targetEl.closest) return;
    var topicBtn = targetEl.closest('button.solomd-topic-btn');
    if (topicBtn && !topicBtn.disabled) {
      var curSec = topicBtn.closest('section.page');
      var curIdx = topicSections.indexOf(curSec);
      var dir = topicBtn.getAttribute('data-topic-dir');
      var nextIdx = dir === 'prev' ? curIdx - 1 : curIdx + 1;
      if (curIdx >= 0 && nextIdx >= 0 && nextIdx < topicSections.length) {
        activatePageSection(topicSections[nextIdx]);
        syncNavToSection(topicSections[nextIdx]);
      }
      return;
    }
    var inPageAnchor = targetEl.closest('a[href^="#"]');
    if (inPageAnchor) {
      var href = inPageAnchor.getAttribute('href') || '';
      var rawId = href.slice(1);
      if (!rawId) return;
      var decodedId = rawId;
      try { decodedId = decodeURIComponent(rawId); } catch (_) {}
      var dest = document.getElementById(decodedId) || document.getElementById(rawId);
      if (dest) {
        e.preventDefault();
        activatePageForElement(dest);
        dest.scrollIntoView({ behavior: pageSections.length ? 'auto' : 'smooth', block: 'start' });
        flashTarget(dest);
        var destSec = dest.closest ? dest.closest('section.page') : null;
        for (var li = 0; li < navLinks.length; li++) {
          var nh = navLinks[li].getAttribute('href') || '';
          var decNh = nh;
          try { decNh = decodeURIComponent(nh); } catch (_) {}
          if (nh === '#' + dest.id || decNh === '#' + dest.id) {
            expandAncestorsOfLink(navLinks[li]);
            setActiveNavLink(navLinks[li]);
            return;
          }
        }
        if (destSec) syncNavToSection(destSec);
      }
    }
  });

  var headings = Array.prototype.slice.call(articleEl.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'));
  mainEl.addEventListener('scroll', function () {
    if (!headings.length || !navLinks.length) return;
    var mainRect = mainEl.getBoundingClientRect();
    var currentId = '';
    for (var h = 0; h < headings.length; h++) {
      if (headings[h].offsetParent === null) continue;
      if (!currentId) currentId = headings[h].id;
      var r = headings[h].getBoundingClientRect();
      if (r.top - mainRect.top <= 80) {
        currentId = headings[h].id;
      } else {
        break;
      }
    }
    if (!currentId) return;
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
      re.lastIndex = 0;
      var snippet = '';
      var lastIdx = 0;
      var hitMatch;
      while ((hitMatch = re.exec(rawSlice)) !== null) {
        if (!hitMatch[0].length) { re.lastIndex += 1; continue; }
        snippet += escapeHtml(rawSlice.slice(lastIdx, hitMatch.index));
        snippet += '<mark>' + escapeHtml(hitMatch[0]) + '</mark>';
        lastIdx = hitMatch.index + hitMatch[0].length;
      }
      snippet += escapeHtml(rawSlice.slice(lastIdx));
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
          activatePageForElement(matchObj.el);
          matchObj.el.scrollIntoView({ behavior: pageSections.length ? 'auto' : 'smooth', block: 'center' });
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
  contentWidth?: number,
) => {
  const resolvedMaxWidth =
    typeof contentWidth === 'number' && Number.isFinite(contentWidth)
      ? contentWidth <= 0
        ? 'none'
        : `${Math.round(contentWidth)}px`
      : '960px';
  return `<!doctype html>
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
    --solomd-content-max-width: ${resolvedMaxWidth};
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
    max-width: var(--solomd-content-max-width, 960px);
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
  pre code .hljs-selector-tag,
  pre code .hljs-doctag,
  pre code .hljs-literal { color: var(--syn-keyword, #a626a4); }
  pre code .hljs-string,
  pre code .hljs-regexp,
  pre code .hljs-template-tag,
  pre code .hljs-template-variable,
  pre code .hljs-addition { color: var(--syn-string, #50a14f); }
  pre code .hljs-number,
  pre code .hljs-symbol,
  pre code .hljs-bullet { color: var(--syn-number, #986801); }
  pre code .hljs-comment,
  pre code .hljs-quote,
  pre code .hljs-meta { color: var(--syn-comment, #6a737d); font-style: italic; }
  pre code .hljs-function,
  pre code .hljs-title,
  pre code .hljs-built_in { color: var(--syn-function, #4078f2); }
  pre code .hljs-type,
  pre code .hljs-class,
  pre code .hljs-params { color: var(--syn-type, #c18401); }
  pre code .hljs-property,
  pre code .hljs-attr,
  pre code .hljs-attribute,
  pre code .hljs-selector-class,
  pre code .hljs-selector-id { color: var(--syn-property, #e45649); }
  pre code .hljs-operator,
  pre code .hljs-punctuation { color: var(--syn-operator, #0184bc); }
  pre code .hljs-variable,
  pre code .hljs-name,
  pre code .hljs-tag { color: var(--syn-variable, var(--code-key, #383a42)); }
  pre code .hljs-deletion { color: #d64545; }
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
  .katex:not(.katex-display .katex):has(.mfrac) { display: inline-block; margin: 0.2em 0; }
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
    <div id="solomd-nav-wrap" class="solomd-nav-wrap" role="tabpanel">
      <div class="solomd-nav-toolbar">
        <button id="solomd-nav-expand-btn" type="button" class="solomd-nav-tool-btn">${navOptions.isZh ? '展开' : 'Expand'}</button>
        <button id="solomd-nav-collapse-btn" type="button" class="solomd-nav-tool-btn">${navOptions.isZh ? '折叠' : 'Collapse'}</button>
      </div>
      <nav id="solomd-nav-pane" class="solomd-nav-pane">${navOptions.navTreeHtml}</nav>
    </div>
    <div id="solomd-search-pane" class="solomd-search-pane" role="tabpanel" hidden>
      <div class="solomd-search-bar">
        <input id="solomd-search-input" type="text" class="solomd-search-input" placeholder="${navOptions.isZh ? '搜索关键字，回车搜索' : 'Type keyword, press Enter'}" autocomplete="off" />
        <button id="solomd-search-clear" type="button" class="solomd-search-clear">${navOptions.isZh ? '清除' : 'Clear'}</button>
      </div>
      <div id="solomd-search-results" class="solomd-search-results" data-empty-text="${navOptions.isZh ? '没有匹配结果' : 'No matching results'}"></div>
    </div>
  </div>
</aside>
<div id="solomd-sidebar-resizer" class="solomd-sidebar-resizer" role="separator" aria-orientation="vertical" title="${navOptions.isZh ? '拖拽调整导航面板宽度' : 'Drag to resize navigation panel'}"></div>
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
};

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

export function buildNestedTocHtml(headings: ExtractedHeading[]): string {
  if (headings.length === 0) return '<ul class="md-toc__list"></ul>';
  // #575 — Each folder heading keeps its own anchor `id`. If a folder node has
  // no corresponding target heading in the document (`!h.id`), omit `href` and
  // mark `data-no-jump="1"` so clicking it selects without jumping.
  const levelStack: number[] = [];
  let html = '';
  for (const h of headings) {
    while (levelStack.length > 0 && levelStack[levelStack.length - 1] >= h.level) {
      levelStack.pop();
      html += '</li></ul>';
    }
    html += '<ul class="md-toc__list">';
    levelStack.push(h.level);
    const linkOpen = h.id
      ? `<a href="#${encodeHtmlAttrId(h.id)}" class="md-toc__link">`
      : `<a class="md-toc__link md-toc__link--no-target" data-no-jump="1">`;
    html += `<li class="md-toc__item">${linkOpen}${escapeHtml(h.text)}</a>`;
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

/**
 * #574, #594, #598 — Split rendered HTML body into `<section class="page" ... style="display:none">`
 * fragments along note page-break markers (`<hr data-solomd-page-break="1">`).
 * A standalone TOC block becomes `#solomd-page-toc` (`data-toc-section="1"`),
 * and content sections optionally receive top-right & bottom-center `< Previous / Next >` buttons.
 */
export function paginateHtmlBody(
  rawBody: string,
  options?: { topicNav?: boolean; isZh?: boolean },
): string {
  const parts = rawBody
    .split(/<hr\b[^>]*\bdata-solomd-page-break=(?:"1"|'1')[^>]*\/?>/gi)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  if (parts.length === 0) return rawBody;

  const isTocOnlyChunk = (chunk: string) =>
    chunk.includes('data-solomd-toc-only="1"') ||
    (/^<nav\s+class=(["'])md-toc\1/i.test(chunk) && !/<h[1-6]\b/i.test(chunk));

  const tocChunks: string[] = [];
  const contentChunks: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i === 0 && isTocOnlyChunk(parts[i])) {
      tocChunks.push(parts[i]);
    } else {
      const cleaned =
        contentChunks.length === 0
          ? parts[i].replace(/(<\/h1>\s*)<hr\b[^>]*\/?>/i, '$1')
          : parts[i];
      contentChunks.push(cleaned);
    }
  }

  const out: string[] = [];
  for (const tc of tocChunks) {
    out.push(
      `<section class="page solomd-toc-section" id="solomd-page-toc" data-toc-section="1" style="display:none">\n${tc}\n</section>`,
    );
  }

  const wantTopicNav = Boolean(options?.topicNav) && contentChunks.length > 1;
  const prevLabel = options?.isZh ? '&lt; 上一主题' : '&lt; Previous';
  const nextLabel = options?.isZh ? '下一主题 &gt;' : 'Next &gt;';

  contentChunks.forEach((chunk, idx) => {
    let inner = chunk;
    if (wantTopicNav) {
      const prevDisabled = idx === 0 ? ' disabled' : '';
      const nextDisabled = idx === contentChunks.length - 1 ? ' disabled' : '';
      const navButtons =
        `<button type="button" class="solomd-topic-btn" data-topic-dir="prev"${prevDisabled}>${prevLabel}</button>` +
        `<button type="button" class="solomd-topic-btn" data-topic-dir="next"${nextDisabled}>${nextLabel}</button>`;
      inner =
        `<div class="solomd-topic-nav solomd-topic-nav--top" aria-label="Topic navigation">${navButtons}</div>\n` +
        `${chunk}\n` +
        `<div class="solomd-topic-nav solomd-topic-nav--bottom" aria-label="Topic navigation">${navButtons}</div>`;
    }
    out.push(`<section class="page" id="solomd-page-${idx + 1}" style="display:none">\n${inner}\n</section>`);
  });

  return out.join('\n');
}

function encodeHtmlAttrId(id: string): string {
  return escapeHtml(id);
}

/**
 * #570, #594 — Ensure every `<h1..h6>` in `rawBody` has an `id`, extract or build
 * the hierarchical bookmark tree for the left navigation pane, and when paginated
 * isolate the TOC into its own `<h1>`-free section (`#solomd-page-toc`) wired to
 * the book root node in the navigation tree.
 */
export function prepareHtmlNavSidebar(
  rawBody: string,
  fallbackTitle: string,
  keepInlineToc = false,
  paginated = false,
  isZh = false,
): { body: string; navTreeHtml: string } {
  let headingCounter = 0;
  let bookRootId = '';
  const headings: ExtractedHeading[] = [];

  const bodyWithIds = rawBody.replace(
    /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (_full, lvlStr: string, attrs: string, inner: string) => {
      headingCounter++;
      const tagLevel = Number.parseInt(lvlStr, 10);
      const customLevelMatch = /\bdata-toc-level=(["'])(\d+)\1/i.exec(attrs);
      const level = customLevelMatch ? Number.parseInt(customLevelMatch[2], 10) : tagLevel;
      const isFolder = /\bdata-toc-folder=(["'])1\1/i.test(attrs);
      const isBookRoot = /\bdata-book-root=(["'])1\1/i.test(attrs);
      const idMatch = /\bid=(["'])([^"']+)\1/i.exec(attrs);
      const id = idMatch ? idMatch[2] : `solomd-h-${headingCounter}`;
      if (isBookRoot && !bookRootId) bookRootId = id;
      const nextAttrs = idMatch ? attrs : `${attrs} id="${id}"`;
      const text = stripTagsAndComments(inner);
      if (text) {
        headings.push({ level, text, id, isFolder });
      }
      return `<h${lvlStr}${nextAttrs}>${inner}</h${lvlStr}>`;
    },
  );

  const rewriteRootHref = (treeHtml: string, targetAnchor: string): string => {
    if (!bookRootId) return treeHtml;
    const encoded = encodeURIComponent(bookRootId);
    return treeHtml
      .replace(`href="#${escapeHtml(bookRootId)}"`, `href="#${targetAnchor}"`)
      .replace(`href="#${encoded}"`, `href="#${targetAnchor}"`);
  };

  const tocMatch = /<nav\s+class=(["'])md-toc\1[^>]*>([\s\S]*?)<\/nav>/i.exec(bodyWithIds);
  if (tocMatch) {
    let navTreeHtml = tocMatch[2].trim();
    if (paginated) {
      let strippedRoot = bodyWithIds.replace(
        /<h1\b[^>]*\bdata-book-root=(["'])1\1[^>]*>[\s\S]*?<\/h1>\s*(?:<hr\b(?![^>]*data-solomd-page-break)[^>]*\/?>\s*)?/i,
        '',
      );
      if (keepInlineToc) {
        const tocTitle = isZh ? '目录' : 'Contents';
        const wrappedToc =
          `<div class="solomd-toc-page" data-solomd-toc-only="1">` +
          `<div class="solomd-toc-page__title">${tocTitle}</div>` +
          `${tocMatch[0]}` +
          `</div>`;
        const afterToc = strippedRoot.slice(strippedRoot.indexOf(tocMatch[0]) + tocMatch[0].length);
        const needsBreak = !/^\s*<hr\b[^>]*\bdata-solomd-page-break=/i.test(afterToc);
        strippedRoot = strippedRoot.replace(
          tocMatch[0],
          needsBreak ? `${wrappedToc}\n<hr data-solomd-page-break="1">` : wrappedToc,
        );
        navTreeHtml = rewriteRootHref(navTreeHtml, 'solomd-page-toc');
        return { body: strippedRoot, navTreeHtml };
      } else {
        strippedRoot = strippedRoot.replace(tocMatch[0], '');
        navTreeHtml = rewriteRootHref(navTreeHtml, 'solomd-page-1');
        return { body: strippedRoot, navTreeHtml };
      }
    }
    const cleanedBody = keepInlineToc ? bodyWithIds : bodyWithIds.replace(tocMatch[0], '');
    return { body: cleanedBody, navTreeHtml };
  }

  if (headings.length === 0 && fallbackTitle.trim()) {
    headings.push({ level: 1, text: fallbackTitle.trim(), id: 'solomd-h-root', isFolder: false });
  }
  let navTreeHtml = buildNestedTocHtml(headings);
  if (paginated) {
    const strippedRoot = bodyWithIds.replace(
      /<h1\b[^>]*\bdata-book-root=(["'])1\1[^>]*>[\s\S]*?<\/h1>\s*/i,
      '',
    );
    if (keepInlineToc) {
      const tocTitle = isZh ? '目录' : 'Contents';
      const tocBlock =
        `<div class="solomd-toc-page" data-solomd-toc-only="1">` +
        `<div class="solomd-toc-page__title">${tocTitle}</div>` +
        `<nav class="md-toc">${navTreeHtml}</nav>` +
        `</div>\n<hr data-solomd-page-break="1">\n`;
      navTreeHtml = rewriteRootHref(navTreeHtml, 'solomd-page-toc');
      return { body: `${tocBlock}${strippedRoot}`, navTreeHtml };
    }
    navTreeHtml = rewriteRootHref(navTreeHtml, 'solomd-page-1');
    return { body: strippedRoot, navTreeHtml };
  }
  return {
    body: keepInlineToc ? `<nav class="md-toc">${navTreeHtml}</nav>\n${bodyWithIds}` : bodyWithIds,
    navTreeHtml,
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
  /** #574 — split content into `<section class="page" style="display:none">` per note (only when `withNav` is true). */
  paginated?: boolean;
  /** #584 — desktop content max-width in px (`0` = unlimited full width). */
  contentWidth?: number;
  /** #572 — include a Table of Contents block at the start of the document body. */
  withTocPage?: boolean;
  /** #598 — render "< Previous / Next >" topic navigation buttons on paginated HTML sections. */
  topicNav?: boolean;
  /** Optional UI language ('zh' | 'en', defaults to auto-detecting CJK). */
  lang?: string;
}

export async function buildStandaloneHtml(input: StandaloneHtmlInput): Promise<string> {
  // An export is rendered once: never with placeholder math / plain code.
  await loadRenderDeps();
  const imageRoot = extractImageRoot(input.content);
  let effectiveContent = input.content;
  if (input.withTocPage === true) {
    const strippedFm = effectiveContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    if (!/^[ \t]*\[toc\][ \t]*$/im.test(strippedFm)) {
      effectiveContent = `[TOC]\n\n${strippedFm}`;
    }
  } else if (input.withTocPage === false && !input.withNav) {
    effectiveContent = effectiveContent.replace(/^[ \t]*\[toc\][ \t]*\r?\n+/im, '');
  }
  // Local images are embedded as `data:` URLs first: a standalone .html has
  // no way to reach the app's `asset.localhost` protocol, so rewriting the
  // src into one — which is what makes images load inside the webview — left
  // every figure broken in the exported file.
  const withImages = await inlineLocalImages(
    renderMarkdown(effectiveContent),
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
    const isZh =
      input.lang !== undefined
        ? input.lang === 'zh'
        : /[\u4e00-\u9fff]/.test(`${input.title} ${input.content.slice(0, 500)}`);
    const prepared = prepareHtmlNavSidebar(
      body,
      input.title,
      input.withTocPage === true,
      Boolean(input.paginated),
      isZh,
    );
    const useTopicNav = input.topicNav !== undefined ? input.topicNav : true;
    body = input.paginated
      ? paginateHtmlBody(prepared.body, { topicNav: useTopicNav, isZh })
      : prepared.body;
    navOptions = {
      navTreeHtml: prepared.navTreeHtml,
      isZh,
      paginated: Boolean(input.paginated),
      topicNav: Boolean(input.paginated && useTopicNav),
    };
  }
  return HTML_TEMPLATE(
    input.title,
    body,
    headCss,
    customCss,
    bodyClasses,
    navOptions,
    input.contentWidth,
  );
}
