<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { initMermaid } from '../lib/mermaid-lazy';
import { mermaidThemeFor } from '../lib/themes';
import { openRenderedLink } from '../lib/link-open';
import { renderMarkdown, extractImageRoot } from '../lib/markdown';
import { togglePreviewTask } from '../lib/preview-task-toggle';
import { useRenderDepsVersion } from '../composables/useRenderDepsVersion';
import { plantumlSvgUrl } from '../lib/plantuml';
import { installSvgImageFallbacks, rewriteImageUrls } from '../lib/image-resolve';
import { openImageOverlay, type OverlayStrings } from '../lib/image-overlay';
import { svgToPngBlob, diagramBackground } from '../lib/mermaid-export';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import PreviewSearch from './PreviewSearch.vue';
import { attachCodeCopyButtons as attachSharedCodeCopyButtons } from '../lib/code-copy';
import { writePngToClipboard } from '../lib/image-clipboard';

const props = withDefaults(
  defineProps<{
    source: string;
    filePath?: string;
    /**
     * v4.6 — id of the tab this preview renders. Needed to write back edits
     * (editable display-math) to the right tab via the store. Omitted in
     * read-only contexts (e.g. Slideshow), which disables in-place editing.
     */
    tabId?: string;
    /**
     * v2.4: which "skin" the rendered prose should use.
     *  - `default` — the standard editor preview pane (constrained max-width
     *    inside a sidebar, used in split / preview view modes).
     *  - `reading` — full-bleed serif reading mode (no chrome around it,
     *    centered prose, larger type, book-like spacing).
     */
    skin?: 'default' | 'reading';
  }>(),
  { skin: 'default' },
);
// #350 — source line of the block at the top of the preview, so the outline
// can follow the reading position in preview mode.
const emit = defineEmits<{ (e: 'topline', line: number): void }>();
const settings = useSettingsStore();
const tabs = useTabsStore();
const { t } = useI18n();
const host = ref<HTMLDivElement | null>(null);
const searchOpen = ref(false);
const searchRef = ref<InstanceType<typeof PreviewSearch> | null>(null);

// ── Editable display math (double-click a $$…$$ formula to edit its LaTeX) ──
const mathEdit = ref<
  null | { fromLine: number; toLine: number; top: number; left: number; width: number }
>(null);
const mathDraft = ref('');
const mathTextarea = ref<HTMLTextAreaElement | null>(null);

/**
 * Locate the `$$…$$` block whose opening `$$` is at/near 1-indexed `startLine`
 * and return its 0-indexed inclusive line range plus the inner LaTeX.
 */
function findMathBlock(
  source: string,
  startLine: number,
): { from: number; to: number; latex: string } | null {
  const lines = source.split('\n');
  let openIdx = -1;
  for (let k = startLine - 1; k >= 0 && k < Math.min(lines.length, startLine + 1); k++) {
    if (k >= 0 && lines[k]?.includes('$$')) { openIdx = k; break; }
  }
  if (openIdx === -1) return null;
  const openLine = lines[openIdx];
  const openPos = openLine.indexOf('$$');
  const afterOpen = openLine.slice(openPos + 2);
  // Single-line: $$ latex $$
  const sameClose = afterOpen.indexOf('$$');
  if (sameClose !== -1) {
    return { from: openIdx, to: openIdx, latex: afterOpen.slice(0, sameClose).trim() };
  }
  // Multi-line: find the closing $$
  let closeIdx = -1;
  for (let k = openIdx + 1; k < lines.length; k++) {
    if (lines[k].includes('$$')) { closeIdx = k; break; }
  }
  if (closeIdx === -1) return null;
  const closeLine = lines[closeIdx];
  const tail = closeLine.slice(0, closeLine.indexOf('$$'));
  const latex = [afterOpen, ...lines.slice(openIdx + 1, closeIdx), tail]
    .join('\n')
    .replace(/^\s*\n|\n\s*$/g, '')
    .trim();
  return { from: openIdx, to: closeIdx, latex };
}

function onPreviewDblClick(e: MouseEvent) {
  if (!props.tabId) return;
  const block = (e.target as HTMLElement).closest('.md-math-block') as HTMLElement | null;
  if (!block) return;
  const startLine = Number(block.getAttribute('data-source-line') || 0);
  if (!startLine) return;
  const found = findMathBlock(props.source || '', startLine);
  if (!found) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = block.getBoundingClientRect();
  mathEdit.value = {
    fromLine: found.from,
    toLine: found.to,
    top: rect.bottom + 6,
    left: rect.left,
    width: Math.min(Math.max(rect.width, 300), 620),
  };
  mathDraft.value = found.latex;
  nextTick(() => {
    mathTextarea.value?.focus();
    mathTextarea.value?.select();
  });
}

function saveMathEdit() {
  if (!mathEdit.value || !props.tabId) return;
  const lines = (props.source || '').split('\n');
  const replacement = ('$$\n' + mathDraft.value.trim() + '\n$$').split('\n');
  lines.splice(mathEdit.value.fromLine, mathEdit.value.toLine - mathEdit.value.fromLine + 1, ...replacement);
  tabs.setContent(props.tabId, lines.join('\n'));
  mathEdit.value = null;
}

function cancelMathEdit() {
  mathEdit.value = null;
}

// ── Clickable task checkboxes ──
// renderMarkdown emits them `disabled` so exported HTML/PDF stay static; the
// in-app preview of a real tab re-enables them and writes the toggle back to
// the tab (the editor follows the store, as for the math edit above).
function enableTaskCheckboxes() {
  if (!host.value || !props.tabId) return;
  for (const box of Array.from(host.value.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox'))) {
    box.disabled = false;
  }
}

function onTaskCheckboxClick(e: MouseEvent) {
  const box = e.target as HTMLElement;
  if (!(box instanceof HTMLInputElement) || !box.classList.contains('task-list-item-checkbox')) return;
  if (!props.tabId || !host.value) {
    e.preventDefault();
    return;
  }
  // The click has already flipped `checked`; the state the user saw is the opposite.
  const wasChecked = !box.checked;
  const all = Array.from(host.value.querySelectorAll('input.task-list-item-checkbox'));
  const li = box.closest('li.task-list-item');
  const dataLine = Number(li?.getAttribute('data-line') || 0);
  // The editor syncs into the store on a debounce; flush first so the toggle
  // is applied to what is on screen, not to text a few keystrokes old.
  window.dispatchEvent(new Event('solomd:flush-content-sync'));
  const tab = tabs.tabs.find((x) => x.id === props.tabId);
  const next = togglePreviewTask(tab?.content ?? props.source ?? '', dataLine, all.indexOf(box), wasChecked);
  if (next === null) {
    e.preventDefault();
    return;
  }
  tabs.setContent(props.tabId, next);
}

function onMathKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); cancelMathEdit(); }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveMathEdit(); }
}

let mermaidIdSeq = 0;

const renderDepsVersion = useRenderDepsVersion();

const html = computed(() => {
  // #141 — establish a reactive dep on the hard-breaks toggle so flipping the
  // setting re-renders immediately (renderMarkdown reads the md singleton's
  // option, which isn't reactive by itself).
  void settings.markdownHardBreaks;
  // Same reactive-dep trick for the numbered-heading toggle (preprocessMarkdown
  // reads a module-level flag that isn't reactive on its own).
  void settings.markdownAutoNumberHeadings;
  // #216 — and for the smart-quotes toggle (md singleton rule state).
  void settings.smartQuotes;
  // And for KaTeX / highlight.js arriving after the first render.
  void renderDepsVersion.value;
  const source = props.source || '';
  return rewriteImageUrls(renderMarkdown(source), extractImageRoot(source), props.filePath);
});

// v4.10 issue #163 — render ```plantuml fences through the configured
// PlantUML server. Opt-in (`plantumlEnabled`); when off the fence stays a
// plain code block. Display is an <img> (no fetch → no CORS); onerror keeps
// the source visible with a hint instead of a broken image.
function processPlantuml() {
  if (!host.value) return;
  if (!settings.plantumlEnabled || !settings.plantumlServer) return;
  const blocks = host.value.querySelectorAll(
    'pre > code.language-plantuml, pre > code.language-puml',
  );
  for (const block of Array.from(blocks)) {
    const pre = block.parentElement as HTMLElement | null;
    if (!pre || pre.dataset.rendered === '1') continue;
    const code = (block.textContent || '').trim();
    const wrap = document.createElement('div');
    wrap.className = 'plantuml-block';
    const img = document.createElement('img');
    img.alt = 'PlantUML diagram';
    img.loading = 'lazy';
    img.src = plantumlSvgUrl(settings.plantumlServer, code);
    img.addEventListener('error', () => {
      const err = document.createElement('pre');
      err.className = 'plantuml-error';
      err.textContent = `PlantUML render failed (${settings.plantumlServer})\n\n${code}`;
      wrap.replaceWith(err);
    });
    wrap.appendChild(img);
    pre.replaceWith(wrap);
  }
}

async function processMermaid() {
  if (!host.value) return;
  const blocks = host.value.querySelectorAll('pre > code.language-mermaid');
  if (!blocks.length) return;   // a note without diagrams never loads mermaid
  const mermaid = await initMermaid({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: mermaidThemeFor(settings.theme),
  });
  for (const block of Array.from(blocks)) {
    const pre = block.parentElement as HTMLElement | null;
    if (!pre || pre.dataset.rendered === '1') continue;
    const code = (block.textContent || '').trim();
    const id = `mmd-${++mermaidIdSeq}`;
    try {
      const { svg } = await mermaid.render(id, code);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-block';
      // Keep the source so a theme switch can re-render this diagram.
      wrap.dataset.mermaidSource = code;
      wrap.innerHTML = svg;
      pre.replaceWith(wrap);
    } catch (e) {
      const err = document.createElement('pre');
      err.className = 'mermaid-error';
      err.textContent = `Mermaid error: ${(e as Error).message}`;
      pre.replaceWith(err);
    }
  }
}

// v4.6 F7 — render ```tldraw fences as static board thumbnails in the preview.
// The fence body is a TLStoreSnapshot; we ask the runtime adapter (dynamic
// import) to export it to a printable SVG so non-editing surfaces stay light.
// The board class survives markdown-it as `code.language-tldraw`.
async function processWhiteboards() {
  if (!host.value) return;
  const blocks = host.value.querySelectorAll('pre > code.language-tldraw');
  if (blocks.length === 0) return;
  const { boardToSvg } = await import('../lib/tldraw-runtime');
  // Parse the source fences once so each preview block can recover its stable
  // boardId/snapshot for the click-to-fullscreen affordance. markdown-it drops
  // the fence attributes (id/height), so we match preview blocks to source
  // fences positionally (same document order).
  const { findTldrawFences } = await import('../lib/tldraw-board');
  const fences = findTldrawFences(props.source || '');
  const theme = {
    colorScheme: (settings.theme === 'dark' ? 'dark' : 'light') as 'dark' | 'light',
    locale: settings.language || 'en',
  };
  const list = Array.from(blocks);
  for (let idx = 0; idx < list.length; idx++) {
    const block = list[idx];
    const pre = block.parentElement as HTMLElement | null;
    if (!pre || pre.dataset.rendered === '1') continue;
    pre.dataset.rendered = '1';
    const snapshot = (block.textContent || '').trim();
    const fence = fences[idx];
    const wrap = document.createElement('div');
    wrap.className = 'whiteboard-block';
    const makeEditable = (svg: string) => {
      wrap.innerHTML = svg;
      // Only the editor preview can write back — read-only skins (slideshow,
      // export) omit tabId, so the thumbnail stays a static image there.
      if (fence && props.tabId) {
        wrap.classList.add('whiteboard-block--clickable');
        wrap.setAttribute('role', 'button');
        wrap.setAttribute('tabindex', '0');
        wrap.title = t('whiteboard.openFull');
        const openFull = () => {
          window.dispatchEvent(
            new CustomEvent('solomd:whiteboard-open', {
              detail: { boardId: fence.boardId, tabId: props.tabId, snapshot: fence.snapshot },
            }),
          );
        };
        wrap.addEventListener('click', openFull);
        wrap.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            openFull();
          }
        });
      }
    };
    try {
      const svg = await boardToSvg(snapshot, theme);
      if (svg) {
        makeEditable(svg);
      } else {
        wrap.classList.add('whiteboard-block--empty');
        wrap.textContent = t('whiteboard.empty');
      }
      pre.replaceWith(wrap);
    } catch {
      wrap.classList.add('whiteboard-block--empty');
      wrap.textContent = t('whiteboard.loadFailed');
      pre.replaceWith(wrap);
    }
  }
}

// The theme is applied by processMermaid on each render pass. Diagrams already
// on screen were drawn for the old theme and processMermaid skips them, so put
// their source back as a fence first and let it render them again (#354).
// A note with no diagrams still never loads the renderer.
watch(() => settings.theme, () => {
  if (host.value) {
    for (const wrap of Array.from(host.value.querySelectorAll<HTMLElement>('.mermaid-block[data-mermaid-source]'))) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = wrap.dataset.mermaidSource ?? '';
      pre.appendChild(code);
      wrap.replaceWith(pre);
    }
  }
  void processMermaid();
});

function overlayStrings(): OverlayStrings {
  return {
    close: t('overlay.close'),
    zoomIn: t('overlay.zoomIn'),
    zoomOut: t('overlay.zoomOut'),
    resetZoom: t('overlay.resetZoom'),
    image: t('overlay.image'),
    diagram: t('overlay.diagram'),
  };
}

function attachImageOverlayHandlers() {
  if (!host.value) return;

  installSvgImageFallbacks(host.value);

  const images = host.value.querySelectorAll('img');
  for (const img of Array.from(images)) {
    if ((img as HTMLElement).dataset.overlayBound === '1') continue;
    (img as HTMLElement).dataset.overlayBound = '1';
    img.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      openImageOverlay({
        source: img,
        title: img.alt || img.getAttribute('src') || undefined,
        strings: overlayStrings(),
      });
    });
  }

  const blocks = host.value.querySelectorAll('.mermaid-block');
  for (const block of Array.from(blocks)) {
    if ((block as HTMLElement).dataset.overlayBound === '1') continue;
    (block as HTMLElement).dataset.overlayBound = '1';
    block.addEventListener('click', ((e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const svg = block.querySelector('svg');
      if (!svg) return;
      openImageOverlay({
        source: svg,
        strings: overlayStrings(),
        // #162 — Mermaid renders as inline SVG, so the WebView's own
        // "save image as" only offers HTML; give diagrams real PNG actions.
        actions: [
          { label: t('overlay.exportPng'), onClick: () => exportDiagramPng(svg) },
          { label: t('overlay.copyImage'), onClick: () => copyDiagramPng(svg) },
        ],
      });
    }) as EventListener);
  }
}

// #195 — fenced code blocks get a stable, one-click copy affordance. The
// implementation lives in lib/code-copy.ts so the live-edit editor and the
// Windows plain-block editor render the exact same button (v4.11.18).
function attachCodeCopyButtons() {
  if (!host.value) return;
  attachSharedCodeCopyButtons(host.value, {
    label: t('toolbar.copy'),
    onError: (err) => useToastsStore().error(`Copy failed: ${err}`),
  });
}

// ── #162: single-diagram PNG export / copy ──────────────────────────

function diagramExportName(): string {
  const base = props.filePath?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '');
  return base ? `${base}-diagram.png` : 'diagram.png';
}

async function exportDiagramPng(svg: SVGElement) {
  const toasts = useToastsStore();
  try {
    const blob = await svgToPngBlob(svg, { scale: 2, background: diagramBackground() });
    const path = await saveDialog({
      defaultPath: diagramExportName(),
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (!path) return;
    const buffer = new Uint8Array(await blob.arrayBuffer());
    await invoke('write_binary_file', { path, data: Array.from(buffer) });
    toasts.success(`Saved ${path.split(/[\\/]/).pop()}`);
  } catch (err) {
    toasts.error(`Export failed: ${err}`);
  }
}

async function copyDiagramPng(svg: SVGElement) {
  const toasts = useToastsStore();
  try {
    const blob = await svgToPngBlob(svg, { scale: 2, background: diagramBackground() });
    // Shared with the editor's "Copy image" (#362): Tauri plugin first, then
    // the browser Clipboard API.
    await writePngToClipboard(blob);
    toasts.success(t('overlay.copyImage') + ' ✓');
  } catch (err) {
    toasts.error(`Copy failed: ${err}`);
  }
}

watch(html, async () => {
  // A re-render (incl. our own math write-back) invalidates popup geometry.
  mathEdit.value = null;
  await nextTick();
  processPlantuml();
  await processMermaid();
  await processWhiteboards();
  attachImageOverlayHandlers();
  attachCodeCopyButtons();
  enableTaskCheckboxes();
});

// Toggling PlantUML (or changing the server) must re-render: the markdown
// HTML string itself is unchanged (PlantUML swaps happen post-render), so
// v-html would not reset the DOM on its own. Rebuild from html and re-run
// the processors.
watch(
  () => [settings.plantumlEnabled, settings.plantumlServer],
  async () => {
    if (!host.value) return;
    host.value.innerHTML = html.value;
    await nextTick();
    processPlantuml();
    await processMermaid();
    await processWhiteboards();
    attachImageOverlayHandlers();
    attachCodeCopyButtons();
    enableTaskCheckboxes();
  },
);

/**
 * Intercept all link clicks inside the preview pane and open them in the
 * system browser instead of navigating the Tauri webview (which would
 * replace the SoloMD UI with the target page). Shared with the Windows
 * live-edit blocks — see lib/link-open.
 */
function handleLinkClick(e: MouseEvent) {
  const anchor = (e.target as HTMLElement).closest('a');
  if (!anchor) return;
  openRenderedLink(anchor, e, props.filePath);
}

onMounted(async () => {
  await nextTick();
  processPlantuml();
  await processMermaid();
  await processWhiteboards();
  attachImageOverlayHandlers();
  attachCodeCopyButtons();
  enableTaskCheckboxes();
  host.value?.addEventListener('click', handleLinkClick);
  host.value?.addEventListener('click', onTaskCheckboxClick);
  host.value?.addEventListener('dblclick', onPreviewDblClick);
});

onBeforeUnmount(() => {
  host.value?.removeEventListener('click', handleLinkClick);
  host.value?.removeEventListener('click', onTaskCheckboxClick);
  host.value?.removeEventListener('dblclick', onPreviewDblClick);
});

function openSearch() {
  searchOpen.value = true;
  nextTick(() => searchRef.value?.focusInput());
}

/**
 * Scroll the preview pane so the element tagged with `data-source-line="N"`
 * (where N is the nearest line ≤ the requested line) is brought to the top.
 * Used by the outline when viewMode === 'preview' (the editor is unmounted
 * so its gotoLine is unavailable).
 */
function scrollToLine(line: number) {
  const article = host.value;
  if (!article) return;
  const container = article.parentElement as HTMLElement | null;
  if (!container) return;

  const nodes = Array.from(
    article.querySelectorAll<HTMLElement>('[data-source-line]'),
  );
  if (nodes.length === 0) return;

  // Find the last element whose source-line is ≤ target (binary search).
  let lo = 0;
  let hi = nodes.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const n = Number(nodes[mid].getAttribute('data-source-line') || 0);
    if (n <= line) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const target = nodes[best];
  // #350 — measure against the scroll container itself. `offsetTop` is
  // relative to the offsetParent, and .preview-host is not positioned, so it
  // also counted the pane chrome above the preview: every jump overshot by
  // that much and the heading ended up hidden above the top edge.
  const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTo({ top: Math.max(0, container.scrollTop + delta - TOP_GAP), behavior: 'smooth' });
  flashTarget(target);
  emit('topline', Number(target.getAttribute('data-source-line') || line));
}

/** Breathing room kept above a jumped-to block. */
const TOP_GAP = 8;

/** Briefly mark the block an outline jump landed on (#350). */
function flashTarget(el: HTMLElement) {
  el.classList.remove('preview-flash');
  // Force a reflow so re-triggering on the same element restarts the animation.
  void el.offsetWidth;
  el.classList.add('preview-flash');
  window.setTimeout(() => el.classList.remove('preview-flash'), 1300);
}

// #350 — in preview mode the outline highlights the heading at the top of the
// preview, not the editor cursor (which does not move while reading). Emits
// the source line of the last block whose top is at/above the viewport top
// (plus the jump gap), at most once per frame.
let toplineRaf = 0;
function onHostScroll() {
  if (toplineRaf) return;
  toplineRaf = requestAnimationFrame(() => {
    toplineRaf = 0;
    const article = host.value;
    const container = article?.parentElement as HTMLElement | null;
    if (!article || !container) return;
    const limit = container.getBoundingClientRect().top + TOP_GAP + 2;
    let line = 0;
    for (const el of Array.from(article.querySelectorAll<HTMLElement>('[data-source-line]'))) {
      if (el.getBoundingClientRect().top > limit) break;
      line = Number(el.getAttribute('data-source-line') || 0) || line;
    }
    emit('topline', line || 1);
  });
}

// #189 — copying rendered content into mail clients / rich editors dropped
// the table borders: the copied HTML referenced our stylesheet classes,
// which don't travel with the clipboard. When the selection contains a
// table, rewrite the text/html clipboard flavor with the essential styles
// inlined (neutral light palette — the paste target is typically a white
// document regardless of the app theme).
function onPreviewCopy(e: ClipboardEvent) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !e.clipboardData) return;
  const range = sel.getRangeAt(0);
  const frag = range.cloneContents();
  if (!frag.querySelector('table')) return;
  const wrap = document.createElement('div');
  wrap.appendChild(frag);
  for (const table of Array.from(wrap.querySelectorAll('table'))) {
    table.setAttribute(
      'style',
      'border-collapse:collapse;border-spacing:0;' + (table.getAttribute('style') || ''),
    );
    for (const cell of Array.from(table.querySelectorAll('th,td'))) {
      const isHeader = cell.tagName === 'TH';
      cell.setAttribute(
        'style',
        `border:1px solid #c9c9c9;padding:6px 12px;${isHeader ? 'background:#f2f2f2;font-weight:600;' : ''}` +
          (cell.getAttribute('style') || ''),
      );
    }
  }
  e.clipboardData.setData('text/html', wrap.innerHTML);
  e.clipboardData.setData('text/plain', sel.toString());
  e.preventDefault();
}

defineExpose({ scrollToLine, openSearch });
</script>

<template>
  <div class="preview-host" :class="{ 'preview-host--reading': skin === 'reading' }" @copy="onPreviewCopy" @scroll.passive="onHostScroll">
    <PreviewSearch
      v-if="searchOpen && host"
      ref="searchRef"
      :container="host"
      @close="searchOpen = false"
    />
    <article
      ref="host"
      class="preview-content"
      :class="{
        'preview-content--fit': settings.previewFitWidth,
        'preview-content--reading': skin === 'reading',
        'cb-numbered-on': settings.codeBlockLineNumbers,
        'cb-wrap-on': settings.codeBlockWrap,
      }"
      :style="{ '--preview-max-width': `${settings.previewMaxWidth || 680}px` }"
      v-html="html"
    ></article>

    <!-- v4.6 — editable display math: inline LaTeX editor opened by
         double-clicking a rendered $$…$$ formula. -->
    <template v-if="mathEdit">
      <div class="math-edit-backdrop" @mousedown="cancelMathEdit"></div>
      <div
        class="math-edit-popover"
        :style="{ top: `${mathEdit.top}px`, left: `${mathEdit.left}px`, width: `${mathEdit.width}px` }"
        @mousedown.stop
      >
        <div class="math-edit-head"><span>LaTeX</span></div>
        <textarea
          ref="mathTextarea"
          v-model="mathDraft"
          class="math-edit-area"
          spellcheck="false"
          rows="3"
          @keydown="onMathKeydown"
        ></textarea>
        <div class="math-edit-actions">
          <button class="math-edit-btn" @mousedown.prevent="cancelMathEdit">{{ t('unsaved.cancel') }}</button>
          <button class="math-edit-btn math-edit-btn--primary" @mousedown.prevent="saveMathEdit">{{ t('unsaved.save') }} <span class="math-edit-kbd">⌘↵</span></button>
        </div>
      </div>
    </template>
  </div>
</template>

<!--
  Intentionally NOT scoped: the markdown HTML is injected via v-html, so
  Vue's scoped-style attribute wouldn't make it onto those child nodes
  anyway. Manually prefixing every rule with `.preview-content` keeps
  styles contained to the preview pane while still letting user-provided
  custom CSS (injected via custom-theme.ts at the end of <head>) override
  on equal-or-higher specificity.
-->
<style>
.preview-content .preview-flash {
  animation: preview-flash 1.2s ease-out;
  border-radius: 4px;
}
@keyframes preview-flash {
  0%, 25% { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  100% { background: transparent; }
}
.preview-host {
  height: 100%;
  overflow: auto;
  background: var(--bg);
  border-left: 1px solid var(--border);
}
:where(.preview-content) {
  /* v4.10 #165 — column width is user-tunable (previewMaxWidth setting sets
     the var on the article); 760px was the old hardcoded value. */
  max-width: var(--preview-max-width, 680px);
  margin: 0 auto;
  /* 5.0 §5 — same column and top margin as the editor (content-box: the max
     width is the text measure). */
  padding: 56px 32px 30vh;
  color: var(--text);
  /* #133 — honor the editor `fontFamily` setting (set as `--content-font-family`
     in App.vue) so the rendered pane matches the editor in split view. Falls
     back to the UI font when unset. */
  font-family: var(--content-font-family, var(--font-ui));
  /* v4.3.0 PR #74 — preview-only font size; driven by settings.previewFontSize
     via the `--content-font-size` CSS custom property set in App.vue. */
  font-size: var(--content-font-size, 16px);
  line-height: 1.8;
  /* #293 — prose must never push past the column. Text pasted out of Word, a
     web page or a chat transcript often joins its words with NO-BREAK SPACE
     (U+00A0) instead of U+0020; the reporter's file had 119 of them against 23
     real spaces. A run glued together that way is one unbreakable "word" to the
     layout engine, so without this the paragraph simply overflows to the right
     and is clipped (on paper) or needs horizontal scrolling (on screen). Live
     edit looked fine throughout because CodeMirror's line-wrapping already
     carries its own overflow-wrap. `break-word` only splits runs that cannot
     fit on a line of their own, so ordinary text still breaks at its spaces. */
  overflow-wrap: break-word;
}
.preview-content--fit {
  max-width: none;
  padding: 56px 32px 30vh;
}
/* 5.0 §2 type scale — H1 30/650/1.25 −0.015em, H2 20/620, H3 17/600 at the
   16px default; in em so the font-size setting scales them. Same values as
   the live editor (lib/cm-live-render.ts) and the Windows block editor. */
:where(.preview-content) h1,
:where(.preview-content) h2,
:where(.preview-content) h3,
:where(.preview-content) h4,
:where(.preview-content) h5,
:where(.preview-content) h6 {
  font-weight: 600;
  line-height: 1.3;
  margin: 1.6em 0 0.5em;
}
:where(.preview-content) h1 {
  font-size: 1.875em;
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: -0.015em;
  margin: 1.2em 0 0.6em;
}
:where(.preview-content) h2 {
  font-size: 1.25em;
  font-weight: 620;
}
:where(.preview-content) h3 { font-size: 1.0625em; }
:where(.preview-content) > :first-child { margin-top: 0; }
:where(.preview-content) p { margin: 0.9em 0; }
:where(.preview-content) a {
  color: var(--accent-text);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent-text) 35%, transparent);
  text-underline-offset: 3px;
}
:where(.preview-content) a:hover { text-decoration-color: currentColor; }
:where(.preview-content) code {
  font-family: var(--font-mono);
  font-size: 0.875em;
  color: var(--text);
  background: var(--fill-1);
  padding: 0.12em 0.35em;
  border-radius: var(--r-xs);
}
:where(.preview-content) pre {
  font-family: var(--font-mono);
  font-size: 0.8125em;
  line-height: 1.6;
  background: var(--bg-elev);
  padding: 14px 16px;
  border-radius: var(--r-lg);
  overflow-x: auto;
}
/* #195 / v4.11.18 — the copy-button chrome now lives in styles/main.css so
 * the preview pane, the Windows plain-block live editor and the CodeMirror
 * live-edit mode all render the identical affordance. */
:where(.preview-content) pre code {
  font-family: var(--font-mono);
  font-size: inherit;
  background: transparent;
  padding: 0;
}
/* #178: opt-in soft wrap for long code lines (no horizontal scrollbar).
 * break-word keeps normal tokens intact and only splits ones wider than
 * the block (long URLs, hashes). */
.preview-content.cb-wrap-on pre {
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  overflow-x: visible;
}
/* v4.3.0 issue #65: optional line numbers for fenced code blocks. The
 * `.cb-line` wrappers are always emitted by markdown.ts; numbering is
 * activated only when `.preview-content` has `cb-numbered-on`, set by the
 * `codeBlockLineNumbers` setting. Counter increments per line; the gutter
 * uses ::before so it doesn't pollute copy/paste of the code itself. */
.preview-content.cb-numbered-on pre.cb-numbered {
  counter-reset: cb-line;
  padding-left: 0;
}
.preview-content.cb-numbered-on pre.cb-numbered code {
  display: block;
  /* #164 — the markup keeps a literal '\n' between the block-level .cb-line
   * spans (needed for the inline, non-numbered flow). Under `pre` whitespace
   * each of those newlines renders an EMPTY line box, doubling the apparent
   * line spacing. Collapse them here; each .cb-line restores `pre` for its
   * own content so indentation survives. */
  white-space: normal;
}
.preview-content.cb-numbered-on pre.cb-numbered code .cb-line {
  counter-increment: cb-line;
  display: block;
  padding-left: 3.4em;
  position: relative;
  white-space: pre;
}
/* #211 — code-block-wrap wins over line numbers: long numbered lines soft-wrap
 * (hanging under the gutter) instead of overflowing. Without this, `.cb-line`'s
 * `white-space: pre` above shadows `.cb-wrap-on pre` whenever both toggles are
 * on. Same override mirrored in Editor.vue for the live-edit blocks. */
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
  color: var(--text-faint);
  border-right: 1px solid var(--border);
  user-select: none;
  -webkit-user-select: none;
}
:where(.preview-content) blockquote {
  margin: 1em 0;
  padding: 12px 16px;
  background: var(--bg-elev);
  border-radius: var(--r-lg);
  color: var(--text-2);
}
:where(.preview-content) blockquote > :first-child { margin-top: 0; }
:where(.preview-content) blockquote > :last-child { margin-bottom: 0; }
:where(.preview-content) ul,
:where(.preview-content) ol {
  padding-left: 1.6em;
}
:where(.preview-content) li::marker { color: var(--text-3); }
:where(.preview-content) table {
  border-collapse: collapse;
  margin: 1em 0;
}
:where(.preview-content--fit) table {
  width: 100%;
}
/* #367 — a table wider than the column scrolls on its own instead of
   pushing the whole preview sideways (where the headings and prose scroll
   away with it). `display: block` + `max-content` is the GitHub recipe: a
   narrow table still sizes to its content, a wide one is capped at the column
   and gets its own horizontal scrollbar. On screen only and only in the
   preview pane — print/PDF overlays reuse `.preview-content` and must not
   clip. Fit-width mode keeps its full-width tables (the block box would stop
   them stretching); there the pane itself still scrolls. */
@media screen {
  .preview-host .preview-content:not(.preview-content--fit) table {
    display: block;
    width: max-content;
    max-width: 100%;
    overflow-x: auto;
  }
}
:where(.preview-content) th,
:where(.preview-content) td {
  border: 1px solid var(--border);
  padding: 6px 12px;
}
:where(.preview-content) hr {
  border: none;
  border-top: 1px solid var(--hairline);
  margin: 2em 0;
}
:where(.preview-content) img {
  max-width: 100%;
  border-radius: 4px;
  cursor: zoom-in;
  transition: opacity 0.15s;
}
:where(.preview-content) img:hover {
  opacity: 0.85;
}
:where(.preview-content) .mermaid-block {
  display: flex;
  justify-content: center;
  margin: 1.5em 0;
  cursor: zoom-in;
  transition: opacity 0.15s;
}
/* v4.10 #163 — PlantUML server-rendered diagrams. */
:where(.preview-content) .plantuml-block {
  display: flex;
  justify-content: center;
  margin: 1.5em 0;
}
:where(.preview-content) .plantuml-block img {
  max-width: 100%;
  height: auto;
}
:where(.preview-content) .plantuml-error {
  color: var(--text-muted);
  border-left: 3px solid var(--accent);
  white-space: pre-wrap;
}
:where(.preview-content) .mermaid-block:hover {
  opacity: 0.85;
}
:where(.preview-content) .mermaid-block svg {
  max-width: 100%;
  height: auto;
}
:where(.preview-content) .mermaid-error {
  color: var(--danger);
  background: rgba(214, 69, 69, 0.08);
  border-left: 3px solid var(--danger);
}
/* F7 — static whiteboard thumbnail in preview/reading/export. */
:where(.preview-content) .whiteboard-block {
  display: flex;
  justify-content: center;
  margin: 1.5em 0;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}
:where(.preview-content) .whiteboard-block svg {
  max-width: 100%;
  height: auto;
}
:where(.preview-content) .whiteboard-block--clickable {
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
:where(.preview-content) .whiteboard-block--clickable:hover {
  border-color: var(--accent, #ff9f40);
  box-shadow: 0 0 0 1px var(--accent, #ff9f40);
}
:where(.preview-content) .whiteboard-block--clickable:focus-visible {
  outline: 2px solid var(--accent, #ff9f40);
  outline-offset: 2px;
}
:where(.preview-content) .whiteboard-block--empty {
  color: var(--text-faint);
  font-style: italic;
}
:where(.preview-content) .katex-display {
  /* KaTeX draws tall delimiters, limits and \dfrac a few px past the formula
     box; overflow-x:auto forces overflow-y to clip, which cut their bottoms
     off. Padding gives them room inside the box (margin reduced to match). */
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.5em 0;
  margin: 0.5em 0;
}
/* Wikilinks (F1, v2.0) */
.preview-content .md-wikilink {
  color: var(--accent-text);
  background: color-mix(in srgb, var(--accent, #ff9f40) 10%, transparent);
  padding: 1px 5px;
  border-radius: 4px;
  text-decoration: none;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s;
}
.preview-content .md-wikilink:hover {
  background: color-mix(in srgb, var(--accent, #ff9f40) 22%, transparent);
  text-decoration: underline;
}
/* Preview search highlights */
.preview-content .ps-mark {
  background: rgba(255, 159, 64, 0.3);
  color: inherit;
  padding: 1px 0;
  border-radius: 2px;
}
.preview-content .ps-mark--current {
  background: var(--accent);
  color: var(--accent-fg, #fff);
}

/* ----- v2.4 Reading mode skin -----
 *
 * "Public reading mode" — full-bleed, single-doc preview without any
 * editor chrome. We override a handful of `.preview-content` rules
 * (max-width up, padding up, serif body, looser line-height) and lean
 * on `--font-reading` so the user can override via the existing custom-
 * font setting if they prefer a different serif.
 *
 * macOS ships Charter and Iowan Old Style; Windows has Cambria; Linux
 * usually has DejaVu Serif via fontconfig. The whole stack collapses to
 * a generic `serif` if none of those exist.
 */
.preview-host--reading {
  /* Ditch the editor-pane border — reading mode is full-bleed. */
  border-left: 0;
  background: var(--bg);
}
.preview-content--reading {
  /* Gitee IK9BBG — a face the user chose wins over the built-in serif stack.
     It has to be var()'s fallback argument, not a comma-separated sibling:
     an undefined `var(--x)` makes the whole declaration invalid, which would
     drop reading mode's serif for everyone who hasn't set a font. */
  --font-reading: var(
    --content-font-user,
    Charter,
    "Iowan Old Style",
    "Source Serif Pro",
    "Source Serif",
    "PT Serif",
    Cambria,
    "Liberation Serif",
    "Noto Serif",
    Georgia,
    serif
  );
  /* v4.10 #165 — reading column follows the same width setting as the
     preview pane (720px was the old hardcoded serif column). */
  max-width: var(--preview-max-width, 680px);
  margin: 0 auto;
  padding: 88px 32px 30vh;
  /* 5.0 §5 — reading view sets the text exactly as the editor and preview
     do (face, size, scale, blocks); only the page margin is roomier. A face
     the user picked still wins via --content-font-family. */
  font-family: var(--content-font-family, var(--font-ui));
  font-size: var(--content-font-size, 16px);
  line-height: 1.8;
  color: var(--text);
}
/* #117 — let the Fit-Width toggle widen reading mode too (full-bleed reading
   column instead of the fixed 720px). Needs higher specificity than the plain
   `.preview-content--reading` rule above, which appears later in source. */
.preview-content--reading.preview-content--fit {
  max-width: none;
}
/* Tighten max-width on phones; on iPad keep the comfy reading column. */
@media (max-width: 540px) {
  .preview-content--reading {
    padding: 32px 18px 64px;
  }
}

/* ── Editable display math (v4.6) ───────────────────────────────────── */
/* The formula container lives inside v-html, so scope it to .preview-content. */
:where(.preview-content) .md-math-block {
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.12s ease;
}
:where(.preview-content) .md-math-block:hover {
  background: color-mix(in srgb, var(--accent, #ff9f40) 12%, transparent);
}
/* Popover + backdrop are Preview's own nodes (not v-html). */
.math-edit-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.math-edit-popover {
  position: fixed;
  z-index: 41;
  max-width: 90vw;
  background: var(--bg, #fff);
  border: 1px solid var(--border, #ddd);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.math-edit-head {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted, #888);
  padding: 0 2px;
}
.math-edit-area {
  width: 100%;
  box-sizing: border-box;
  min-height: 64px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text, #222);
  background: var(--bg-elevated, var(--bg, #fff));
  border: 1px solid var(--border, #ddd);
  border-radius: 6px;
  padding: 8px;
  outline: none;
}
.math-edit-area:focus {
  border-color: var(--accent, #ff9f40);
}
.math-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.math-edit-btn {
  font-size: 13px;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--border, #ddd);
  background: transparent;
  color: var(--text, #222);
  cursor: pointer;
}
.math-edit-btn:hover {
  background: color-mix(in srgb, var(--text, #000) 6%, transparent);
}
.math-edit-btn--primary {
  background: var(--accent, #ff9f40);
  border-color: var(--accent, #ff9f40);
  color: #000;
}
.math-edit-btn--primary:hover {
  filter: brightness(0.96);
}
.math-edit-kbd {
  opacity: 0.6;
  font-size: 11px;
  margin-left: 2px;
}
</style>
