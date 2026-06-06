<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import mermaid from 'mermaid';
import { openUrl } from '@tauri-apps/plugin-opener';
import { renderMarkdown, extractImageRoot } from '../lib/markdown';
import { rewriteImageUrls } from '../lib/image-resolve';
import { openImageOverlay, type OverlayStrings } from '../lib/image-overlay';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useFiles } from '../composables/useFiles';
import PreviewSearch from './PreviewSearch.vue';

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
const settings = useSettingsStore();
const tabs = useTabsStore();
const files = useFiles();
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

function onMathKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); cancelMathEdit(); }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveMathEdit(); }
}

let mermaidIdSeq = 0;

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });

const html = computed(() => {
  const source = props.source || '';
  return rewriteImageUrls(renderMarkdown(source), extractImageRoot(source), props.filePath);
});

async function processMermaid() {
  if (!host.value) return;
  const blocks = host.value.querySelectorAll('pre > code.language-mermaid');
  for (const block of Array.from(blocks)) {
    const pre = block.parentElement as HTMLElement | null;
    if (!pre || pre.dataset.rendered === '1') continue;
    const code = (block.textContent || '').trim();
    const id = `mmd-${++mermaidIdSeq}`;
    try {
      const { svg } = await mermaid.render(id, code);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-block';
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

watch(
  () => settings.theme,
  (t) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: t === 'dark' ? 'dark' : 'default' });
  }
);

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
      });
    }) as EventListener);
  }
}

watch(html, async () => {
  // A re-render (incl. our own math write-back) invalidates popup geometry.
  mathEdit.value = null;
  await nextTick();
  await processMermaid();
  attachImageOverlayHandlers();
});

/**
 * Intercept all link clicks inside the preview pane and open them in the
 * system browser instead of navigating the Tauri webview (which would
 * replace the SoloMD UI with the target page).
 */
function handleLinkClick(e: MouseEvent) {
  const anchor = (e.target as HTMLElement).closest('a');
  if (!anchor) return;
  // Wikilink (F1, v2.0): intercept and dispatch resolution to App.vue.
  if (anchor.classList.contains('md-wikilink')) {
    const target = anchor.getAttribute('data-wikilink-target') || '';
    if (target) {
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('solomd:wiki-open', { detail: { target } }));
    }
    return;
  }
  const href = anchor.getAttribute('href');
  if (!href) return;
  // Allow in-page anchor jumps (#heading)
  if (href.startsWith('#')) return;
  e.preventDefault();
  e.stopPropagation();
  // External URL: open in system browser
  if (/^(https?|mailto|tel):/i.test(href)) {
    openUrl(href).catch((err) => {
      console.warn('[Preview] openUrl failed:', href, err);
    });
    return;
  }
  // Relative path: resolve against current file's directory and open in app
  if (props.filePath) {
    const sep = props.filePath.lastIndexOf('/');
    const dir = sep >= 0 ? props.filePath.substring(0, sep + 1) : '';
    // Normalise: strip leading ./
    const cleaned = href.replace(/^\.\//, '');
    const resolved = dir + cleaned;
    files.openPath(resolved, { bypassNewWindow: true }).catch((err) => {
      console.warn('[Preview] openPath failed:', resolved, err);
    });
  }
}

onMounted(async () => {
  await nextTick();
  await processMermaid();
  attachImageOverlayHandlers();
  host.value?.addEventListener('click', handleLinkClick);
  host.value?.addEventListener('dblclick', onPreviewDblClick);
});

onBeforeUnmount(() => {
  host.value?.removeEventListener('click', handleLinkClick);
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
  const offset = target.offsetTop - 8;
  container.scrollTo({ top: offset, behavior: 'smooth' });
}

defineExpose({ scrollToLine, openSearch });
</script>

<template>
  <div class="preview-host" :class="{ 'preview-host--reading': skin === 'reading' }">
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
        'preview-content--fit': settings.previewFitWidth && skin !== 'reading',
        'preview-content--reading': skin === 'reading',
        'cb-numbered-on': settings.codeBlockLineNumbers,
      }"
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
.preview-host {
  height: 100%;
  overflow: auto;
  background: var(--bg);
  border-left: 1px solid var(--border);
}
:where(.preview-content) {
  max-width: 760px;
  margin: 0 auto;
  padding: 28px 36px 64px;
  color: var(--text);
  font-family: var(--font-ui);
  /* v4.3.0 PR #74 — preview-only font size; driven by settings.previewFontSize
     via the `--content-font-size` CSS custom property set in App.vue. */
  font-size: var(--content-font-size, 15px);
  line-height: 1.7;
}
.preview-content--fit {
  max-width: none;
  padding: 28px 16px 64px;
}
:where(.preview-content) h1,
:where(.preview-content) h2,
:where(.preview-content) h3,
:where(.preview-content) h4 {
  font-weight: 700;
  line-height: 1.25;
  margin: 1.6em 0 0.5em;
}
:where(.preview-content) h1 {
  font-size: 2em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.3em;
}
:where(.preview-content) h2 {
  font-size: 1.5em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.25em;
}
:where(.preview-content) h3 { font-size: 1.2em; }
:where(.preview-content) p { margin: 0.8em 0; }
:where(.preview-content) a {
  color: var(--accent);
  text-decoration: none;
}
:where(.preview-content) a:hover { text-decoration: underline; }
:where(.preview-content) code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--bg-hover);
  padding: 0.15em 0.4em;
  border-radius: 4px;
}
:where(.preview-content) pre {
  font-family: var(--font-mono);
  background: var(--bg-hover);
  padding: 14px 16px;
  border-radius: 6px;
  overflow-x: auto;
}
:where(.preview-content) pre code {
  font-family: var(--font-mono);
  background: transparent;
  padding: 0;
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
}
.preview-content.cb-numbered-on pre.cb-numbered code .cb-line {
  counter-increment: cb-line;
  display: block;
  padding-left: 3.4em;
  position: relative;
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
  border-left: 3px solid var(--accent);
  margin: 1em 0;
  padding: 0.2em 1em;
  color: var(--text-muted);
}
:where(.preview-content) ul,
:where(.preview-content) ol {
  padding-left: 1.6em;
}
:where(.preview-content) table {
  border-collapse: collapse;
  margin: 1em 0;
}
:where(.preview-content--fit) table {
  width: 100%;
}
:where(.preview-content) th,
:where(.preview-content) td {
  border: 1px solid var(--border);
  padding: 6px 12px;
}
:where(.preview-content) hr {
  border: none;
  border-top: 1px solid var(--border);
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
:where(.preview-content) .katex-display {
  overflow-x: auto;
  overflow-y: hidden;
  margin: 1em 0;
}
/* Wikilinks (F1, v2.0) */
.preview-content .md-wikilink {
  color: var(--accent, #ff9f40);
  background: color-mix(in srgb, var(--accent, #ff9f40) 10%, transparent);
  padding: 1px 5px;
  border-radius: 4px;
  text-decoration: none;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s;
}
.preview-content .md-wikilink::before {
  content: '🔗';
  font-size: 0.75em;
  margin-right: 3px;
  opacity: 0.6;
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
  --font-reading:
    Charter,
    "Iowan Old Style",
    "Source Serif Pro",
    "Source Serif",
    "PT Serif",
    Cambria,
    "Liberation Serif",
    "Noto Serif",
    Georgia,
    serif;
  max-width: 720px;
  margin: 0 auto;
  padding: 64px 32px 96px;
  font-family: var(--font-reading);
  font-size: 18px;
  line-height: 1.8;
  color: var(--text);
}
:where(.preview-content--reading) h1,
:where(.preview-content--reading) h2,
:where(.preview-content--reading) h3,
:where(.preview-content--reading) h4 {
  font-family: var(--font-reading);
  letter-spacing: -0.005em;
}
:where(.preview-content--reading) h1 {
  font-size: 2.2em;
  margin-top: 0;
  border-bottom: 0;
  padding-bottom: 0;
}
:where(.preview-content--reading) h2 {
  font-size: 1.55em;
  border-bottom: 0;
  padding-bottom: 0;
  margin: 2em 0 0.5em;
}
:where(.preview-content--reading) p {
  margin: 1em 0;
}
:where(.preview-content--reading) blockquote {
  border-left: 3px solid var(--border);
  color: var(--text-muted);
  font-style: italic;
}
/* Tighten max-width on phones; on iPad keep the comfy reading column. */
@media (max-width: 540px) {
  .preview-content--reading {
    padding: 32px 18px 64px;
    font-size: 17px;
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
