<script setup lang="ts">
import { computed, ref, watch, onMounted, nextTick } from 'vue';
import mermaid from 'mermaid';
import { convertFileSrc } from '@tauri-apps/api/core';
import { renderMarkdown } from '../lib/markdown';
import { useSettingsStore } from '../stores/settings';

const props = defineProps<{ source: string; filePath?: string }>();
const settings = useSettingsStore();
const host = ref<HTMLDivElement | null>(null);

let mermaidIdSeq = 0;

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });

/**
 * Resolve a single image src into something the webview can actually load.
 * Tauri's webview blocks raw file:// URLs, so for any local path we route
 * through `convertFileSrc()` which produces an `asset://` URL the
 * `assetProtocol` handler will serve.
 */
function resolveImageSrc(src: string): string {
  if (!src) return src;
  // Already a remote / data / blob / asset URL — leave alone.
  if (/^(https?|data|blob|asset|tauri):/i.test(src)) return src;

  // Strip a leading file:// prefix so we can re-encode it.
  let p = src.startsWith('file://') ? src.slice(7) : src;

  // Resolve relative paths against the current file's directory.
  const isAbsolute = p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
  if (!isAbsolute && props.filePath) {
    const dir = props.filePath.replace(/[\\/][^\\/]*$/, '');
    const sep = props.filePath.includes('\\') ? '\\' : '/';
    // Don't try to be clever about ./ — markdown-it already strips it on
    // the rare occasion it appears.
    p = dir + sep + p;
  }

  try {
    return convertFileSrc(p);
  } catch {
    return src;
  }
}

/** Rewrite all `<img src=…>` URLs in the rendered markdown HTML. */
function rewriteImageUrls(rawHtml: string): string {
  return rawHtml.replace(
    /(<img[^>]*\bsrc=)(["'])([^"']*)\2/gi,
    (_match, prefix: string, q: string, src: string) => {
      return `${prefix}${q}${resolveImageSrc(src)}${q}`;
    },
  );
}

const html = computed(() => rewriteImageUrls(renderMarkdown(props.source || '')));

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

watch(html, async () => {
  await nextTick();
  processMermaid();
});

onMounted(async () => {
  await nextTick();
  processMermaid();
});
</script>

<template>
  <div class="preview-host">
    <article ref="host" class="preview-content" v-html="html"></article>
  </div>
</template>

<style scoped>
.preview-host {
  height: 100%;
  overflow: auto;
  background: var(--bg);
  border-left: 1px solid var(--border);
}
.preview-content {
  max-width: 760px;
  margin: 0 auto;
  padding: 28px 36px 64px;
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 15px;
  line-height: 1.7;
}
.preview-content :deep(h1),
.preview-content :deep(h2),
.preview-content :deep(h3),
.preview-content :deep(h4) {
  font-weight: 700;
  line-height: 1.25;
  margin: 1.6em 0 0.5em;
}
.preview-content :deep(h1) {
  font-size: 2em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.3em;
}
.preview-content :deep(h2) {
  font-size: 1.5em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.25em;
}
.preview-content :deep(h3) { font-size: 1.2em; }
.preview-content :deep(p) { margin: 0.8em 0; }
.preview-content :deep(a) {
  color: var(--accent);
  text-decoration: none;
}
.preview-content :deep(a:hover) { text-decoration: underline; }
.preview-content :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--bg-hover);
  padding: 0.15em 0.4em;
  border-radius: 4px;
}
.preview-content :deep(pre) {
  background: var(--bg-hover);
  padding: 14px 16px;
  border-radius: 6px;
  overflow-x: auto;
}
.preview-content :deep(pre code) {
  background: transparent;
  padding: 0;
}
.preview-content :deep(blockquote) {
  border-left: 3px solid var(--accent);
  margin: 1em 0;
  padding: 0.2em 1em;
  color: var(--text-muted);
}
.preview-content :deep(ul),
.preview-content :deep(ol) {
  padding-left: 1.6em;
}
.preview-content :deep(table) {
  border-collapse: collapse;
  margin: 1em 0;
}
.preview-content :deep(th),
.preview-content :deep(td) {
  border: 1px solid var(--border);
  padding: 6px 12px;
}
.preview-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 2em 0;
}
.preview-content :deep(img) {
  max-width: 100%;
  border-radius: 4px;
}
.preview-content :deep(.mermaid-block) {
  display: flex;
  justify-content: center;
  margin: 1.5em 0;
}
.preview-content :deep(.mermaid-block svg) {
  max-width: 100%;
  height: auto;
}
.preview-content :deep(.mermaid-error) {
  color: var(--danger);
  background: rgba(214, 69, 69, 0.08);
  border-left: 3px solid var(--danger);
}
.preview-content :deep(.katex-display) {
  overflow-x: auto;
  overflow-y: hidden;
  margin: 1em 0;
}
</style>
