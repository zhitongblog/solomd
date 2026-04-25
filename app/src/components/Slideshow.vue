<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { renderMarkdown } from '../lib/markdown';
import { getCurrentWindow } from '@tauri-apps/api/window';

const STORAGE_KEY = 'solomd:slideshow:content';
const TITLE_KEY = 'solomd:slideshow:title';

const source = ref('');
const title = ref('');
const idx = ref(0);
const showHelp = ref(false);

// `\n---\n` splits horizontal slides. Fence-aware: don't split inside ``` blocks.
function splitSlides(src: string): string[] {
  if (!src) return [''];
  const lines = src.split(/\r?\n/);
  const slides: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    if (!inFence && /^---\s*$/.test(line)) {
      slides.push(buf.join('\n'));
      buf = [];
    } else {
      buf.push(line);
    }
  }
  slides.push(buf.join('\n'));
  // Drop a leading empty slide if the doc starts with `---` (front-matter is
  // already stripped from the chosen content but be defensive).
  if (slides.length > 1 && slides[0].trim() === '') slides.shift();
  return slides;
}

const slides = computed(() => splitSlides(source.value));
const total = computed(() => slides.value.length);
const currentHtml = computed(() => renderMarkdown(slides.value[idx.value] || ''));

function next() {
  if (idx.value < total.value - 1) idx.value++;
}
function prev() {
  if (idx.value > 0) idx.value--;
}
function first() { idx.value = 0; }
function last() { idx.value = total.value - 1; }

/**
 * Toggle fullscreen using Tauri's window API first, then fall back to
 * the HTML5 Fullscreen API. On Windows the Tauri setter sometimes needs a
 * user gesture to take effect; the HTML5 path works because `F` is one.
 */
async function toggleFullscreen() {
  // Try Tauri first.
  let usedTauri = false;
  try {
    const win = getCurrentWindow();
    const isFs = await win.isFullscreen();
    await win.setFullscreen(!isFs);
    usedTauri = true;
    // Verify it actually changed (Windows can silently no-op).
    await new Promise((r) => setTimeout(r, 50));
    if ((await win.isFullscreen()) === isFs) {
      usedTauri = false; // didn't change → fall through to HTML5
    }
  } catch {}
  if (usedTauri) return;
  // HTML5 fallback (works in WebView2 + WKWebView).
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (e) {
    console.warn('fullscreen toggle failed', e);
  }
}

async function exitShow() {
  try {
    const win = getCurrentWindow();
    // macOS fullscreen needs to be exited before close, otherwise the
    // close request races the fullscreen-out animation and can hang.
    if (await win.isFullscreen()) {
      await win.setFullscreen(false);
      // Wait for the OS-level fullscreen-out animation to finish.
      await new Promise((r) => setTimeout(r, 350));
    }
    await win.close();
  } catch (e) {
    console.warn('slideshow exit failed', e);
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown' || e.key === 'l') {
    e.preventDefault();
    next();
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'h') {
    e.preventDefault();
    prev();
  } else if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    next();
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    prev();
  } else if (e.key === 'Home') {
    e.preventDefault();
    first();
  } else if (e.key === 'End') {
    e.preventDefault();
    last();
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    toggleFullscreen();
  } else if (e.key === '?') {
    e.preventDefault();
    showHelp.value = !showHelp.value;
  } else if (e.key === 'Escape') {
    if (showHelp.value) {
      showHelp.value = false;
      return;
    }
    e.preventDefault();
    exitShow();
  }
}

onMounted(async () => {
  try {
    source.value = localStorage.getItem(STORAGE_KEY) || '';
    title.value = localStorage.getItem(TITLE_KEY) || 'Slideshow';
  } catch {}
  // Strip front matter for slideshow rendering — we don't want it as slide 1.
  source.value = source.value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  document.title = `${title.value} — SoloMD Slideshow`;
  window.addEventListener('keydown', onKey);
  // Try to enter fullscreen on launch via Tauri. On Windows this can
  // silently fail without a user gesture — the HUD shows "F to fullscreen"
  // so the user can press F to use the HTML5 fallback path.
  try {
    const win = getCurrentWindow();
    await new Promise((r) => setTimeout(r, 100)); // let window settle
    await win.setFullscreen(true);
  } catch {}
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="slideshow" @click="next">
    <div class="slide" @click.stop>
      <div class="slide__content" v-html="currentHtml" />
    </div>
    <div class="slide__hud" @click.stop>
      <span class="slide__pos">{{ idx + 1 }} / {{ total }}</span>
      <span class="slide__hint">F fullscreen · ? help · Esc exit</span>
    </div>
    <div v-if="showHelp" class="slide__help" @click.stop="showHelp = false">
      <div class="slide__help-card">
        <h2>Slideshow Shortcuts</h2>
        <table>
          <tbody>
          <tr><td>Next slide</td><td>→ ↓ Space PageDown l j</td></tr>
          <tr><td>Previous slide</td><td>← ↑ PageUp h k</td></tr>
          <tr><td>First / last slide</td><td>Home / End</td></tr>
          <tr><td>Toggle fullscreen</td><td>F</td></tr>
          <tr><td>Show / hide this help</td><td>?</td></tr>
          <tr><td>Exit</td><td>Esc</td></tr>
          <tr><td>Click to advance</td><td>Click anywhere</td></tr>
          </tbody>
        </table>
        <p class="slide__help-foot">Slides are split by lines containing only <code>---</code>.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.slideshow {
  position: fixed;
  inset: 0;
  background: #1a1a1a;
  color: #f0f0f0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
}
.slide {
  width: 92vw;
  max-width: 1400px;
  max-height: 90vh;
  overflow: auto;
  cursor: default;
  padding: 40px 60px;
  font-size: clamp(20px, 2.4vw, 32px);
  line-height: 1.55;
}
.slide__content :deep(h1) {
  font-size: 2.4em;
  margin: 0 0 0.6em;
  text-align: center;
  font-weight: 700;
}
.slide__content :deep(h2) {
  font-size: 1.8em;
  margin: 0 0 0.5em;
  font-weight: 600;
}
.slide__content :deep(h3) {
  font-size: 1.4em;
  margin: 0.4em 0;
}
.slide__content :deep(p),
.slide__content :deep(ul),
.slide__content :deep(ol),
.slide__content :deep(blockquote) {
  font-size: 1em;
  margin: 0.6em 0;
}
.slide__content :deep(li) { margin: 0.25em 0; }
.slide__content :deep(code) {
  background: rgba(255, 255, 255, 0.1);
  padding: 0.1em 0.35em;
  border-radius: 4px;
  font-size: 0.85em;
}
.slide__content :deep(pre) {
  background: rgba(0, 0, 0, 0.4);
  padding: 16px 20px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 0.7em;
  line-height: 1.5;
}
.slide__content :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 1em;
}
.slide__content :deep(blockquote) {
  border-left: 4px solid #ff9f40;
  padding-left: 16px;
  color: #ccc;
  font-style: italic;
}
.slide__content :deep(table) {
  border-collapse: collapse;
  margin: 1em 0;
  font-size: 0.85em;
}
.slide__content :deep(th),
.slide__content :deep(td) {
  border: 1px solid rgba(255, 255, 255, 0.2);
  padding: 8px 14px;
}
.slide__content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}
.slide__content :deep(a) { color: #ff9f40; }
.slide__content :deep(hr) { border-color: rgba(255, 255, 255, 0.2); }
.slide__hud {
  position: absolute;
  bottom: 16px;
  right: 24px;
  display: flex;
  gap: 16px;
  align-items: center;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  font-family: ui-monospace, Menlo, monospace;
  pointer-events: none;
}
.slide__pos {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.7);
}
.slide__hint {
  display: inline;
  font-size: 11px;
}
.slide__help {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}
.slide__help-card {
  background: #2a2a2a;
  padding: 32px 40px;
  border-radius: 12px;
  max-width: 520px;
  font-size: 15px;
}
.slide__help-card h2 {
  margin: 0 0 18px;
  font-size: 18px;
  color: #ff9f40;
}
.slide__help-card table {
  width: 100%;
  border-collapse: collapse;
}
.slide__help-card td {
  padding: 6px 0;
  vertical-align: top;
}
.slide__help-card td:first-child {
  color: #aaa;
  width: 50%;
}
.slide__help-card td:last-child {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 13px;
}
.slide__help-foot {
  margin: 18px 0 0;
  font-size: 12px;
  color: #888;
  border-top: 1px solid #444;
  padding-top: 14px;
}
.slide__help-foot code {
  background: rgba(255, 255, 255, 0.1);
  padding: 1px 6px;
  border-radius: 3px;
}
</style>
