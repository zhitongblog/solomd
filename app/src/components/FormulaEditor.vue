<script setup lang="ts">
/**
 * Formula editor — LaTeX on the left, rendered result underneath, and a
 * palette of the symbols nobody remembers the spelling of.
 *
 * This is deliberately not a WYSIWYG equation editor. Pulling in MathLive
 * would add megabytes to a 15 MB app whose pitch starts with its size, and it
 * would produce LaTeX the user then has to live with in their plain-text file.
 * The actual friction is not "I want to click my way to an integral" — it is
 * "what is the command for ≥ / a matrix / cases, and did I close every brace".
 * A palette plus a preview that updates as you type answers both, using the
 * KaTeX already in the bundle.
 *
 * Cross-references: the toolbar can insert a `\label{…}`, and any label
 * already defined in the document can be dropped in as `\eqref{…}` —
 * numbering is resolved at render time (`equations.ts`).
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import katex from 'katex';
import { useI18n } from '../i18n';

const props = defineProps<{
  latex: string;
  display: boolean;
  labels: Array<{ label: string; display: string }>;
}>();
const emit = defineEmits<{
  (e: 'apply', latex: string, display: boolean): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();

const source = ref(props.latex);
const isDisplay = ref(props.display);
const box = ref<HTMLTextAreaElement | null>(null);

watch(
  () => props.latex,
  (v) => {
    source.value = v;
  },
);

/** Rendered HTML, or the KaTeX error — an editor that goes blank on a typo is
 *  worse than one that says which brace is unbalanced. */
const rendered = computed<{ html: string; error: string }>(() => {
  const src = source.value.trim();
  if (!src) return { html: '', error: '' };
  try {
    return {
      html: katex.renderToString(src, {
        displayMode: isDisplay.value,
        throwOnError: true,
        // `\label` is ours, not KaTeX's; it is resolved before render, so tell
        // KaTeX to ignore it here rather than reporting an error the user
        // cannot act on.
        macros: { '\\label': '\\text{}' },
      }),
      error: '',
    };
  } catch (e) {
    return { html: '', error: e instanceof Error ? e.message : String(e) };
  }
});

interface PaletteGroup {
  key: string;
  items: Array<{ label: string; insert: string; caret?: number }>;
}

/** `caret` is where the cursor lands inside the inserted text — the point of a
 *  template is that you type into it immediately. */
const PALETTE: PaletteGroup[] = [
  {
    key: 'greek',
    items: [
      { label: 'α', insert: '\\alpha ' },
      { label: 'β', insert: '\\beta ' },
      { label: 'γ', insert: '\\gamma ' },
      { label: 'θ', insert: '\\theta ' },
      { label: 'λ', insert: '\\lambda ' },
      { label: 'μ', insert: '\\mu ' },
      { label: 'π', insert: '\\pi ' },
      { label: 'σ', insert: '\\sigma ' },
      { label: 'φ', insert: '\\phi ' },
      { label: 'ω', insert: '\\omega ' },
      { label: 'Δ', insert: '\\Delta ' },
      { label: 'Σ', insert: '\\Sigma ' },
    ],
  },
  {
    key: 'relations',
    items: [
      { label: '≤', insert: '\\le ' },
      { label: '≥', insert: '\\ge ' },
      { label: '≠', insert: '\\ne ' },
      { label: '≈', insert: '\\approx ' },
      { label: '≡', insert: '\\equiv ' },
      { label: '∝', insert: '\\propto ' },
      { label: '∈', insert: '\\in ' },
      { label: '⊂', insert: '\\subset ' },
      { label: '∀', insert: '\\forall ' },
      { label: '∃', insert: '\\exists ' },
    ],
  },
  {
    key: 'operators',
    items: [
      { label: '×', insert: '\\times ' },
      { label: '÷', insert: '\\div ' },
      { label: '±', insert: '\\pm ' },
      { label: '·', insert: '\\cdot ' },
      { label: '∞', insert: '\\infty ' },
      { label: '∂', insert: '\\partial ' },
      { label: '∇', insert: '\\nabla ' },
      { label: '→', insert: '\\to ' },
      { label: '⇒', insert: '\\Rightarrow ' },
      { label: '↔', insert: '\\leftrightarrow ' },
    ],
  },
  {
    key: 'structures',
    items: [
      { label: 'a/b', insert: '\\frac{}{}', caret: 6 },
      { label: '√', insert: '\\sqrt{}', caret: 6 },
      { label: 'xⁿ', insert: '^{}', caret: 2 },
      { label: 'xₙ', insert: '_{}', caret: 2 },
      { label: '∑', insert: '\\sum_{i=1}^{n} ', caret: 15 },
      { label: '∏', insert: '\\prod_{i=1}^{n} ', caret: 16 },
      { label: '∫', insert: '\\int_{a}^{b} ', caret: 13 },
      { label: 'lim', insert: '\\lim_{x \\to 0} ', caret: 15 },
      { label: '()', insert: '\\left( \\right)', caret: 7 },
      { label: 'matrix', insert: '\\begin{pmatrix}\n a & b \\\\\n c & d\n\\end{pmatrix}', caret: 17 },
      { label: 'cases', insert: '\\begin{cases}\n a & x > 0 \\\\\n b & x \\le 0\n\\end{cases}', caret: 15 },
      { label: 'aligned', insert: '\\begin{aligned}\n a &= b \\\\\n c &= d\n\\end{aligned}', caret: 17 },
    ],
  },
];

function insert(text: string, caret?: number) {
  const el = box.value;
  if (!el) {
    source.value += text;
    return;
  }
  const start = el.selectionStart ?? source.value.length;
  const end = el.selectionEnd ?? start;
  source.value = source.value.slice(0, start) + text + source.value.slice(end);
  const pos = start + (caret ?? text.length);
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(pos, pos);
  });
}

function insertLabel() {
  insert('\\label{}', 7);
}

function insertRef(label: string) {
  insert(`\\eqref{${label}}`);
}

function apply() {
  const body = source.value.trim();
  if (!body) {
    emit('close');
    return;
  }
  emit('apply', body, isDisplay.value);
  emit('close');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
    return;
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    apply();
  }
}

onMounted(() => {
  void nextTick(() => {
    box.value?.focus();
    const len = source.value.length;
    box.value?.setSelectionRange(len, len);
  });
});
</script>

<template>
  <div class="fx__backdrop" @click.self="emit('close')" @keydown="onKeydown">
    <div class="fx" role="dialog" aria-modal="true">
      <header class="fx__head">
        <span class="fx__title">{{ t('formulaEditor.heading') }}</span>
        <label class="fx__mode">
          <input type="checkbox" v-model="isDisplay" />
          {{ t('formulaEditor.displayMode') }}
        </label>
        <button class="fx__x" :title="t('formulaEditor.cancel')" @click="emit('close')">×</button>
      </header>

      <div class="fx__palette">
        <div v-for="group in PALETTE" :key="group.key" class="fx__group">
          <span class="fx__glabel">{{ t(`formulaEditor.group.${group.key}`) }}</span>
          <button
            v-for="item in group.items"
            :key="item.label"
            :title="item.insert.trim()"
            @click="insert(item.insert, item.caret)"
          >{{ item.label }}</button>
        </div>
        <div class="fx__group">
          <span class="fx__glabel">{{ t('formulaEditor.group.refs') }}</span>
          <button :title="'\\label{}'" @click="insertLabel">{{ t('formulaEditor.addLabel') }}</button>
          <button
            v-for="l in props.labels"
            :key="l.label"
            :title="`\\eqref{${l.label}}`"
            @click="insertRef(l.label)"
          >({{ l.display }}) {{ l.label }}</button>
        </div>
      </div>

      <textarea
        ref="box"
        v-model="source"
        class="fx__source"
        spellcheck="false"
        :placeholder="t('formulaEditor.placeholder')"
        rows="5"
      ></textarea>

      <div class="fx__preview">
        <div v-if="rendered.error" class="fx__error">{{ rendered.error }}</div>
        <div v-else-if="rendered.html" class="fx__render" v-html="rendered.html"></div>
        <div v-else class="fx__empty">{{ t('formulaEditor.previewEmpty') }}</div>
      </div>

      <footer class="fx__foot">
        <span class="fx__hint">{{ t('formulaEditor.hint') }}</span>
        <button class="fx__btn" @click="emit('close')">{{ t('formulaEditor.cancel') }}</button>
        <button class="fx__btn fx__btn--primary" @click="apply">{{ t('formulaEditor.apply') }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.fx__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2100;
}
.fx {
  display: flex;
  flex-direction: column;
  width: min(720px, 92vw);
  max-height: 86vh;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  overflow: hidden;
}
.fx__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.fx__title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  flex: 1;
}
.fx__mode {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
}
.fx__x {
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.fx__palette {
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  max-height: 30vh;
  overflow-y: auto;
}
.fx__group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}
.fx__glabel {
  font-size: 10px;
  color: var(--text-faint);
  width: 64px;
  flex-shrink: 0;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.fx__group button {
  min-width: 26px;
  padding: 2px 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
}
.fx__group button:hover {
  background: var(--bg-hover);
  border-color: var(--accent, #ff9f40);
}
.fx__source {
  margin: 0;
  padding: 12px 14px;
  border: 0;
  border-bottom: 1px solid var(--border);
  outline: none;
  resize: vertical;
  background: transparent;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
}
.fx__preview {
  flex: 1;
  min-height: 72px;
  padding: 14px;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}
.fx__error {
  color: var(--danger, #d64545);
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: pre-wrap;
  text-align: center;
}
.fx__empty {
  color: var(--text-faint);
  font-size: 12px;
}
.fx__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}
.fx__hint {
  flex: 1;
  font-size: 11px;
  color: var(--text-faint);
}
.fx__btn {
  padding: 5px 14px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}
.fx__btn--primary {
  background: var(--accent, #ff9f40);
  border-color: var(--accent, #ff9f40);
  color: var(--accent-fg, #1a1a1a);
  font-weight: 600;
}
</style>
