<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { renderMarkdown } from '../lib/markdown';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Reveal from 'reveal.js';
import 'reveal.js/reveal.css';

const STORAGE_KEY = 'solomd:slideshow:content';
const TITLE_KEY = 'solomd:slideshow:title';

// ---------------------------------------------------------------------------
// v3.5: full reveal.js migration. The previous slideshow was a hand-rolled
// `\n---\n` splitter + v-html. That worked but couldn't handle backgrounds,
// fragments, speaker notes, transitions — every additional ask was another
// patch. Switching to reveal.js gives all of those for free; the cost is a
// ~140 KB minified runtime, which is the right trade vs maintaining a
// home-grown presentation engine forever.
//
// Markdown rendering still goes through OUR markdown-it + KaTeX + Mermaid
// + highlight.js pipeline (so all existing in-doc features keep working);
// reveal only handles layout / transitions / backgrounds / navigation.
//
// Slide separator: a line with `---` (horizontal) or `--` (vertical sub-slide).
// Reveal's native conventions, applied here as input syntax.
// ---------------------------------------------------------------------------

const containerRef = ref<HTMLDivElement | null>(null);
const slidesRef = ref<HTMLDivElement | null>(null);
const total = ref(0);
const idx = ref(0);
const showHelp = ref(false);
const title = ref('');

type RevealDeck = InstanceType<typeof Reveal>;
let deck: RevealDeck | null = null;

interface SlideMeta {
  body: string;
  /** A single CSS color, gradient, or image URL. */
  bg?: string;
  /** Distinguishes URL-style backgrounds from color/gradient. */
  bgIsImage?: boolean;
  bgSize?: string;     // e.g. 'cover' (default), 'contain', '100% 100%'
  bgPosition?: string; // e.g. 'center', 'top left'
  bgOpacity?: string;  // 0–1
}

/**
 * Parse a single slide's leading HTML comments for background directives.
 * Recognised forms:
 *
 *   <!-- bg: ./assets/cover.jpg -->
 *   <!-- bg: #ff9f40 -->
 *   <!-- bg: linear-gradient(135deg,#ff9f40,#ffd166) -->
 *   <!-- bg-size: cover -->
 *   <!-- bg-position: center -->
 *   <!-- bg-opacity: 0.6 -->
 *
 * The directive line(s) are stripped from the slide body before rendering.
 */
function extractMeta(raw: string): SlideMeta {
  const meta: SlideMeta = { body: raw };
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  // Only consume directives at the *top* of the slide. Once we see a
  // non-directive non-empty line, the rest is the slide body verbatim.
  let inHeader = true;
  for (const line of lines) {
    if (inHeader) {
      const m = /^\s*<!--\s*(bg|bg-size|bg-position|bg-opacity)\s*:\s*(.+?)\s*-->\s*$/.exec(line);
      if (m) {
        const key = m[1];
        const value = m[2];
        if (key === 'bg') {
          meta.bg = value;
          meta.bgIsImage = /^(https?:\/\/|\.{0,2}\/|file:|data:image\/)/.test(value)
            || /\.(jpe?g|png|gif|webp|avif|svg)\b/i.test(value);
        } else if (key === 'bg-size') {
          meta.bgSize = value;
        } else if (key === 'bg-position') {
          meta.bgPosition = value;
        } else if (key === 'bg-opacity') {
          meta.bgOpacity = value;
        }
        continue;
      }
      if (line.trim() === '') {
        kept.push(line);
        continue;
      }
      inHeader = false;
    }
    kept.push(line);
  }
  meta.body = kept.join('\n');
  return meta;
}

/**
 * Split the source markdown into slide blocks. Reveal-style:
 *   `\n---\n` → next horizontal slide
 *   `\n--\n`  → next vertical sub-slide (within the current horizontal stack)
 * Fence-aware: separators inside ``` blocks are content, not slide breaks.
 */
function splitSlides(src: string): string[][] {
  if (!src) return [['']];
  const lines = src.split(/\r?\n/);
  const decks: string[][] = [];
  let stack: string[][] = [[]]; // current horizontal slide's vertical stack
  let buf: string[] = [];
  let inFence = false;

  function pushBuf() {
    stack[stack.length - 1].push(buf.join('\n'));
    buf = [];
  }
  function pushHorizontal() {
    pushBuf();
    decks.push(stack[0]);
    stack = [[]];
  }

  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    if (!inFence && /^---\s*$/.test(line)) {
      pushHorizontal();
    } else if (!inFence && /^--\s*$/.test(line)) {
      pushBuf();
      stack[0].push(''); // start a new vertical slide; we'll fill it on subsequent lines
    } else {
      buf.push(line);
    }
  }
  pushBuf();
  decks.push(stack[0]);

  // Drop a leading empty horizontal slide (front-matter is also stripped
  // upstream but be defensive).
  if (decks.length > 1 && decks[0].every((s) => s.trim() === '')) {
    decks.shift();
  }
  return decks;
}

function buildSection(meta: SlideMeta): HTMLElement {
  const section = document.createElement('section');
  if (meta.bg) {
    if (meta.bgIsImage) {
      section.setAttribute('data-background-image', meta.bg);
      if (meta.bgSize) section.setAttribute('data-background-size', meta.bgSize);
      if (meta.bgPosition) section.setAttribute('data-background-position', meta.bgPosition);
      if (meta.bgOpacity) section.setAttribute('data-background-opacity', meta.bgOpacity);
    } else {
      section.setAttribute('data-background', meta.bg);
      if (meta.bgOpacity) section.setAttribute('data-background-opacity', meta.bgOpacity);
    }
  }
  section.innerHTML = renderMarkdown(meta.body);
  return section;
}

function buildDeck(src: string, host: HTMLElement) {
  // Clear any prior content (re-init path).
  while (host.firstChild) host.removeChild(host.firstChild);
  const decks = splitSlides(src);
  for (const stack of decks) {
    const horiz = stack.length > 1
      ? document.createElement('section') // wraps a vertical sub-stack
      : null;
    if (horiz) host.appendChild(horiz);
    for (const slideSrc of stack) {
      const meta = extractMeta(slideSrc);
      const slide = buildSection(meta);
      (horiz || host).appendChild(slide);
    }
  }
  total.value = host.querySelectorAll(':scope > section').length
    + host.querySelectorAll(':scope > section section').length;
  // Above counts both top-level slides and nested verticals; for the HUD
  // we want the absolute slide count which is what reveal exposes via
  // getTotalSlides(). Real HUD update happens in `slidechanged` below.
}

/**
 * Toggle fullscreen using Tauri's window API first, then fall back to
 * the HTML5 Fullscreen API. On Windows the Tauri setter sometimes needs a
 * user gesture to take effect; the HTML5 path works because `F` is one.
 */
async function toggleFullscreen() {
  let usedTauri = false;
  try {
    const win = getCurrentWindow();
    const isFs = await win.isFullscreen();
    await win.setFullscreen(!isFs);
    usedTauri = true;
    await new Promise((r) => setTimeout(r, 50));
    if ((await win.isFullscreen()) === isFs) {
      usedTauri = false;
    }
  } catch {}
  if (usedTauri) return;
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
    if (await win.isFullscreen()) {
      await win.setFullscreen(false);
      await new Promise((r) => setTimeout(r, 350));
    }
    await win.close();
  } catch (e) {
    console.warn('slideshow exit failed', e);
  }
}

function onKey(e: KeyboardEvent) {
  // Reveal handles arrow keys / space / page-up/down natively. We only
  // need our own escape-hatch shortcuts: F (fullscreen), Esc (exit),
  // ? (help overlay).
  if (e.key === 'f' || e.key === 'F') {
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
  let source = '';
  try {
    source = localStorage.getItem(STORAGE_KEY) || '';
    title.value = localStorage.getItem(TITLE_KEY) || 'Slideshow';
  } catch {}
  // Strip front matter (first --- ... --- block) — front-matter is config,
  // not slide-1 content.
  source = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  document.title = `${title.value} — SoloMD Slideshow`;

  // Build the DOM once into the .slides container, then init Reveal on
  // the wrapper. Reveal expects the structure to be present at init time.
  if (slidesRef.value) {
    buildDeck(source, slidesRef.value);
  }

  if (containerRef.value) {
    deck = new Reveal(containerRef.value, {
      embedded: false,
      hash: false,
      controls: false,           // we draw a minimal HUD ourselves
      progress: true,
      slideNumber: false,
      keyboard: true,            // Reveal handles arrow / space / pgup
      transition: 'slide',
      backgroundTransition: 'fade',
      autoSlide: 0,
      // Plugins are intentionally NOT loaded — our markdown is already
      // rendered (with KaTeX, Mermaid, highlight.js). Reveal's own
      // markdown / highlight plugins would just duplicate work.
      plugins: [],
    });
    await deck.initialize();
    deck.on('slidechanged', (event: any) => {
      idx.value = (event?.indexh ?? 0);
      total.value = deck?.getTotalSlides() ?? 0;
    });
    total.value = deck.getTotalSlides();
  }

  window.addEventListener('keydown', onKey);

  // Try to enter fullscreen on launch via Tauri.
  try {
    const win = getCurrentWindow();
    await new Promise((r) => setTimeout(r, 100));
    await win.setFullscreen(true);
  } catch {}
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  try {
    deck?.destroy();
  } catch {}
});
</script>

<template>
  <div ref="containerRef" class="solomd-slideshow reveal">
    <div ref="slidesRef" class="slides"></div>
    <div class="slide__hud" @click.stop>
      <span class="slide__pos">{{ idx + 1 }} / {{ total }}</span>
      <span class="slide__hint">F fullscreen · ? help · Esc exit</span>
    </div>
    <div v-if="showHelp" class="slide__help" @click.stop="showHelp = false">
      <div class="slide__help-card">
        <h2>Slideshow Shortcuts</h2>
        <table>
          <tr><td>Next slide</td><td>→ ↓ Space PageDown</td></tr>
          <tr><td>Previous slide</td><td>← ↑ PageUp</td></tr>
          <tr><td>First / last slide</td><td>Home / End</td></tr>
          <tr><td>Toggle fullscreen</td><td>F</td></tr>
          <tr><td>Show / hide this help</td><td>?</td></tr>
          <tr><td>Exit</td><td>Esc</td></tr>
          <tr><td>Vertical sub-slides</td><td>Use <code>--</code> separator</td></tr>
        </table>
        <p class="slide__help-foot">
          Slides split by <code>---</code> (horizontal) or <code>--</code>
          (vertical). Add a background with
          <code>&lt;!-- bg: ./image.jpg --&gt;</code> at the top of any slide.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.solomd-slideshow {
  position: fixed;
  inset: 0;
  background: #1a1a1a;
  color: #f0f0f0;
  overflow: hidden;
}
/*
 * Reveal injects its own classes (.reveal, .slides). We override visuals
 * to match the previous SoloMD slideshow look-and-feel — dark canvas,
 * larger headings, accent-orange links — instead of pulling in any of
 * reveal's bundled themes (which would double the CSS payload).
 */
.solomd-slideshow :deep(.slides) {
  text-align: left !important;
}
.solomd-slideshow :deep(.slides section) {
  font-size: clamp(20px, 2.4vw, 32px);
  line-height: 1.55;
  padding: 40px 60px;
  text-align: left;
}
.solomd-slideshow :deep(h1) {
  font-size: 2.4em;
  margin: 0 0 0.6em;
  text-align: center;
  font-weight: 700;
  text-transform: none;
}
.solomd-slideshow :deep(h2) {
  font-size: 1.8em;
  margin: 0 0 0.5em;
  font-weight: 600;
  text-transform: none;
}
.solomd-slideshow :deep(h3) {
  font-size: 1.4em;
  margin: 0.4em 0;
  text-transform: none;
}
.solomd-slideshow :deep(p),
.solomd-slideshow :deep(ul),
.solomd-slideshow :deep(ol),
.solomd-slideshow :deep(blockquote) {
  font-size: 1em;
  margin: 0.6em 0;
}
.solomd-slideshow :deep(li) { margin: 0.25em 0; }
.solomd-slideshow :deep(code) {
  background: rgba(255, 255, 255, 0.1);
  padding: 0.1em 0.35em;
  border-radius: 4px;
  font-size: 0.85em;
}
.solomd-slideshow :deep(pre) {
  background: rgba(0, 0, 0, 0.4);
  padding: 16px 20px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 0.7em;
  line-height: 1.5;
}
.solomd-slideshow :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 1em;
  display: block;
}
.solomd-slideshow :deep(blockquote) {
  border-left: 4px solid #ff9f40;
  padding-left: 16px;
  color: #ccc;
  font-style: italic;
}
.solomd-slideshow :deep(table) {
  border-collapse: collapse;
  margin: 1em 0;
  font-size: 0.85em;
}
.solomd-slideshow :deep(th),
.solomd-slideshow :deep(td) {
  border: 1px solid rgba(255, 255, 255, 0.2);
  padding: 8px 14px;
}
.solomd-slideshow :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}
.solomd-slideshow :deep(a) { color: #ff9f40; }
.solomd-slideshow :deep(hr) { border-color: rgba(255, 255, 255, 0.2); }
.slide__hud {
  position: fixed;
  bottom: 16px;
  right: 24px;
  display: flex;
  gap: 16px;
  align-items: center;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  font-family: ui-monospace, Menlo, monospace;
  pointer-events: none;
  z-index: 100;
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
  z-index: 200;
}
.slide__help-card {
  background: #2a2a2a;
  padding: 32px 40px;
  border-radius: 12px;
  max-width: 560px;
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
  line-height: 1.55;
}
.slide__help-foot code {
  background: rgba(255, 255, 255, 0.1);
  padding: 1px 6px;
  border-radius: 3px;
}
</style>
