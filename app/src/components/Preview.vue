<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import mermaid from 'mermaid';
import { convertFileSrc } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { renderMarkdown, extractImageRoot } from '../lib/markdown';
import { openImageOverlay, type OverlayStrings } from '../lib/image-overlay';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../stores/settings';

const props = defineProps<{ source: string; filePath?: string }>();
const settings = useSettingsStore();
const { t } = useI18n();
const host = ref<HTMLDivElement | null>(null);

let mermaidIdSeq = 0;

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });

/**
 * Resolve a single image src into something the webview can actually load.
 * Tauri's webview blocks raw file:// URLs, so for any local path we route
 * through `convertFileSrc()` which produces an `asset://` URL the
 * `assetProtocol` handler will serve.
 */
function resolveImageSrc(src: string, imageRoot: string | null): string {
  if (!src) return src;
  // Already a remote / data / blob / asset URL — leave alone.
  if (/^(https?|data|blob|asset|tauri):/i.test(src)) return src;

  // Strip a leading file:// prefix so we can re-encode it.
  let p = src.startsWith('file://') ? src.slice(7) : src;

  // Resolve relative paths. Prefer front-matter `imageRoot` over the file's
  // own parent directory (matches Typora's `typora-root-url` behavior).
  const isAbsolute = p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
  if (!isAbsolute) {
    let base: string | null = null;
    if (imageRoot) {
      const rootAbsolute = imageRoot.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(imageRoot);
      if (rootAbsolute) {
        base = imageRoot;
      } else if (props.filePath) {
        const dir = props.filePath.replace(/[\\/][^\\/]*$/, '');
        const sep = props.filePath.includes('\\') ? '\\' : '/';
        base = dir + sep + imageRoot;
      }
    }
    if (!base && props.filePath) {
      base = props.filePath.replace(/[\\/][^\\/]*$/, '');
    }
    if (base) {
      const sep = base.includes('\\') ? '\\' : '/';
      p = base + sep + p;
    }
  }

  try {
    return convertFileSrc(p);
  } catch {
    return src;
  }
}

/** Rewrite all `<img src=…>` URLs in the rendered markdown HTML. */
function rewriteImageUrls(rawHtml: string, imageRoot: string | null): string {
  return rawHtml.replace(
    /(<img[^>]*\bsrc=)(["'])([^"']*)\2/gi,
    (_match, prefix: string, q: string, src: string) => {
      return `${prefix}${q}${resolveImageSrc(src, imageRoot)}${q}`;
    },
  );
}

const html = computed(() => {
  const source = props.source || '';
  return rewriteImageUrls(renderMarkdown(source), extractImageRoot(source));
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
  const href = anchor.getAttribute('href');
  if (!href) return;
  // Allow in-page anchor jumps (#heading)
  if (href.startsWith('#')) return;
  e.preventDefault();
  e.stopPropagation();
  openUrl(href).catch(() => {
    // Silently fail if opener can't handle the URL
  });
}

onMounted(async () => {
  await nextTick();
  await processMermaid();
  attachImageOverlayHandlers();
  host.value?.addEventListener('click', handleLinkClick);
});

onBeforeUnmount(() => {
  host.value?.removeEventListener('click', handleLinkClick);
});

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

defineExpose({ scrollToLine });
</script>

<template>
  <div class="preview-host">
    <article ref="host" class="preview-content" :class="{ 'preview-content--fit': settings.previewFitWidth }" v-html="html"></article>
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
  font-size: 15px;
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
</style>
