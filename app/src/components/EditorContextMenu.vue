<script setup lang="ts">
/**
 * Right-click menu for the editor (#210): Cut / Copy / Paste / Select All.
 *
 * #376 — on a misspelled word the menu leads with up to five spelling
 * suggestions (or a disabled "No suggestions" line), as the WebView2 menu it
 * replaced did. The host looks the word up and passes `spell`.
 *
 * The editor used to rely on the webview's own context menu. On Windows that
 * menu came up without Cut/Copy for a selection the user had just made (drag
 * or Ctrl+A), in both Edit and Live Edit, so mouse users could select text but
 * not act on it. Owning the menu makes it the same on every webview and every
 * editor path (CodeMirror, the Windows textarea, the Windows live blocks).
 *
 * Items use `mousedown.prevent` so a click never moves focus or the selection
 * out of the editor before the action runs — the host (Editor.vue) performs
 * the action on the selection that was there when the menu opened.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from '../i18n';
import { usesCommandKey } from '../lib/platform';

export type EditorMenuAction = 'copyImage' | 'cut' | 'copy' | 'paste' | 'selectAll';

/** A misspelled word under the pointer (#376). `canAdd`: offer "Add to
 *  dictionary" — only where our own checker draws the underline. */
export interface EditorMenuSpell {
  word: string;
  suggestions: string[];
  canAdd: boolean;
  /** LanguageTool: the explanation shown above the suggestions. */
  message?: string;
  /** LanguageTool: offer "Ignore" and "Disable rule". */
  canIgnore?: boolean;
  /** LanguageTool: a match covering several words gets one "Add" per word. */
  addWords?: string[];
}

export interface EditorMenuImageDims {
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
}

// `hasImage`: the right-click landed on a rendered image (#362) — offer
// "Copy image" on top of the text items.
const props = defineProps<{
  x: number;
  y: number;
  hasSelection: boolean;
  hasImage?: boolean;
  imageDims?: EditorMenuImageDims | null;
  spell?: EditorMenuSpell | null;
}>();
const emit = defineEmits<{
  (e: 'action', id: EditorMenuAction): void;
  (e: 'resize-image', size: string): void;
  (e: 'replace', word: string): void;
  (e: 'add-word', word: string): void;
  (e: 'lt-ignore'): void;
  (e: 'lt-disable-rule'): void;
  (e: 'close'): void;
}>();

const IMAGE_SIZE_PRESETS = ['25%', '50%', '75%', '100%'] as const;

const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const pos = ref({ left: props.x, top: props.y });
const mod = usesCommandKey() ? '⌘' : 'Ctrl+';

// #499 / #264 — Exact pixel width & height inputs with aspect-ratio lock.
const pxWidth = ref<string>(props.imageDims?.width ? String(props.imageDims.width) : '');
const pxHeight = ref<string>(props.imageDims?.height ? String(props.imageDims.height) : '');
const lockAspect = ref(true);

const aspectRatio = computed(() => {
  const nw = props.imageDims?.naturalWidth || props.imageDims?.width || 0;
  const nh = props.imageDims?.naturalHeight || props.imageDims?.height || 0;
  return nw > 0 && nh > 0 ? nw / nh : 0;
});

function onPxWidthInput(e: Event) {
  const val = (e.target as HTMLInputElement).value.trim();
  pxWidth.value = val;
  if (lockAspect.value && aspectRatio.value > 0) {
    const n = Number.parseInt(val, 10);
    if (Number.isFinite(n) && n > 0) {
      pxHeight.value = String(Math.max(1, Math.round(n / aspectRatio.value)));
    }
  }
}

function onPxHeightInput(e: Event) {
  const val = (e.target as HTMLInputElement).value.trim();
  pxHeight.value = val;
  if (lockAspect.value && aspectRatio.value > 0) {
    const n = Number.parseInt(val, 10);
    if (Number.isFinite(n) && n > 0) {
      pxWidth.value = String(Math.max(1, Math.round(n * aspectRatio.value)));
    }
  }
}

function applyExactPxSize() {
  const w = Number.parseInt(pxWidth.value, 10);
  const h = Number.parseInt(pxHeight.value, 10);
  const hasW = Number.isFinite(w) && w > 0;
  const hasH = Number.isFinite(h) && h > 0;
  if (!hasW && !hasH) return;
  if (hasW && hasH) {
    emit('resize-image', `${w}x${h}`);
  } else if (hasW) {
    emit('resize-image', `${w}`);
  } else {
    emit('resize-image', `x${h}`);
  }
}

type Item = { id: EditorMenuAction; label: string; key: string; disabled: boolean; sep?: boolean };
const items = computed<Item[]>(() => [
  ...(props.hasImage
    ? [{ id: 'copyImage' as const, label: t('overlay.copyImage'), key: '', disabled: false }]
    : []),
  { id: 'cut' as const, label: t('menubar.cut'), key: `${mod}X`, disabled: !props.hasSelection, sep: !!props.hasImage || !!props.spell },
  { id: 'copy' as const, label: t('menubar.copy'), key: `${mod}C`, disabled: !props.hasSelection },
  { id: 'paste' as const, label: t('menubar.paste'), key: `${mod}V`, disabled: false },
  { id: 'selectAll' as const, label: t('menubar.selectAll'), key: `${mod}A`, disabled: false, sep: true },
]);

function run(id: EditorMenuAction, disabled: boolean) {
  if (disabled) return;
  emit('action', id);
}

function onDocDown(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) emit('close');
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    emit('close');
  }
}
function onClose() {
  emit('close');
}

onMounted(async () => {
  // Keep the whole menu on screen: flip left/up when it would overflow.
  await nextTick();
  const el = root.value;
  if (el) {
    const r = el.getBoundingClientRect();
    const pad = 4;
    let left = props.x;
    let top = props.y;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, props.x - r.width);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, props.y - r.height);
    pos.value = { left, top };
  }
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onClose);
  window.addEventListener('resize', onClose);
  document.addEventListener('scroll', onClose, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', onClose);
  window.removeEventListener('resize', onClose);
  document.removeEventListener('scroll', onClose, true);
});
</script>

<template>
  <div
    ref="root"
    class="editor-ctx"
    role="menu"
    :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
    @contextmenu.prevent
  >
    <template v-if="props.spell">
      <div v-if="props.spell.message" class="editor-ctx__message">{{ props.spell.message }}</div>
      <button
        v-for="s in props.spell.suggestions"
        :key="'sugg-' + s"
        type="button"
        role="menuitem"
        class="editor-ctx__item editor-ctx__item--suggestion"
        data-action="suggestion"
        @mousedown.prevent
        @click="emit('replace', s)"
      >
        <span class="editor-ctx__label">{{ s === '' ? t('languagetool.remove') : s }}</span>
      </button>
      <button
        v-if="props.spell.suggestions.length === 0"
        type="button"
        role="menuitem"
        class="editor-ctx__item"
        data-action="noSuggestions"
        disabled
        aria-disabled="true"
        @mousedown.prevent
      >
        <span class="editor-ctx__label">{{ t('spellcheck.noSuggestions') }}</span>
      </button>
      <template v-if="props.spell.canAdd && props.spell.addWords && props.spell.addWords.length > 1">
        <button
          v-for="w in props.spell.addWords"
          :key="'add-' + w"
          type="button"
          role="menuitem"
          class="editor-ctx__item"
          data-action="addToDict"
          @mousedown.prevent
          @click="emit('add-word', w)"
        >
          <span class="editor-ctx__label">{{ t('languagetool.addWord', { word: w }) }}</span>
        </button>
      </template>
      <button
        v-else-if="props.spell.canAdd"
        type="button"
        role="menuitem"
        class="editor-ctx__item"
        data-action="addToDict"
        @mousedown.prevent
        @click="emit('add-word', props.spell.word)"
      >
        <span class="editor-ctx__label">{{ t('spellcheck.addToDict') }}</span>
      </button>
      <template v-if="props.spell.canIgnore">
        <button
          type="button"
          role="menuitem"
          class="editor-ctx__item"
          data-action="ltIgnore"
          @mousedown.prevent
          @click="emit('lt-ignore')"
        >
          <span class="editor-ctx__label">{{ t('languagetool.ignore') }}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="editor-ctx__item"
          data-action="ltDisableRule"
          @mousedown.prevent
          @click="emit('lt-disable-rule')"
        >
          <span class="editor-ctx__label">{{ t('languagetool.disableRule') }}</span>
        </button>
      </template>
    </template>
    <template v-for="item in items" :key="item.id">
      <div v-if="item.sep" class="editor-ctx__sep" />
      <button
        type="button"
        role="menuitem"
        class="editor-ctx__item"
        :data-action="item.id"
        :disabled="item.disabled"
        :aria-disabled="item.disabled"
        @mousedown.prevent
        @click="run(item.id, item.disabled)"
      >
        <span class="editor-ctx__label">{{ item.label }}</span>
        <span class="editor-ctx__key">{{ item.key }}</span>
      </button>
      <div
        v-if="item.id === 'copyImage'"
        class="editor-ctx__image-sizes"
        role="group"
        :aria-label="t('overlay.imageSize')"
      >
        <div class="editor-ctx__size-row">
          <span class="editor-ctx__size-label">{{ t('overlay.imageSize') }}</span>
          <div class="editor-ctx__size-pills">
            <button
              v-for="sz in IMAGE_SIZE_PRESETS"
              :key="sz"
              type="button"
              class="editor-ctx__size-btn"
              :data-size="sz"
              @mousedown.prevent
              @click="emit('resize-image', sz)"
            >{{ sz }}</button>
          </div>
        </div>
        <div class="editor-ctx__px-row" @mousedown.stop>
          <input
            type="number"
            min="1"
            max="9999"
            class="editor-ctx__px-input"
            placeholder="W"
            aria-label="Width (px)"
            :value="pxWidth"
            @input="onPxWidthInput"
            @keydown.enter.prevent="applyExactPxSize"
          />
          <button
            type="button"
            class="editor-ctx__lock-btn"
            :class="{ 'editor-ctx__lock-btn--active': lockAspect }"
            :title="lockAspect ? 'Lock aspect ratio' : 'Unlock aspect ratio'"
            @mousedown.prevent
            @click="lockAspect = !lockAspect"
          >{{ lockAspect ? '🔒' : '🔓' }}</button>
          <input
            type="number"
            min="1"
            max="9999"
            class="editor-ctx__px-input"
            placeholder="H"
            aria-label="Height (px)"
            :value="pxHeight"
            @input="onPxHeightInput"
            @keydown.enter.prevent="applyExactPxSize"
          />
          <span class="editor-ctx__px-unit">px</span>
          <button
            type="button"
            class="editor-ctx__size-btn editor-ctx__px-apply"
            data-action="apply-px-size"
            @mousedown.prevent
            @click="applyExactPxSize"
          >✓</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.editor-ctx {
  position: fixed;
  z-index: 1000;
  min-width: 180px;
  padding: 4px;
  background: var(--bg-elev, var(--bg));
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-size: 13px;
  user-select: none;
}
.editor-ctx__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  width: 100%;
  padding: 5px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: default;
}
.editor-ctx__item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.editor-ctx__item--suggestion {
  font-weight: 600;
}
.editor-ctx__message {
  max-width: 300px;
  padding: 4px 10px 6px;
  color: var(--text-muted, var(--text));
  font-size: 12px;
  line-height: 1.4;
  user-select: text;
}
.editor-ctx__item:disabled {
  color: var(--text-faint);
}
.editor-ctx__key {
  color: var(--text-faint);
  font-size: 12px;
}
.editor-ctx__sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}
.editor-ctx__image-sizes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 10px 6px;
}
.editor-ctx__size-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.editor-ctx__px-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.editor-ctx__px-input {
  width: 58px;
  padding: 2px 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.editor-ctx__px-input:focus {
  outline: none;
  border-color: var(--accent);
}
.editor-ctx__lock-btn {
  padding: 1px 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  font-size: 11px;
  cursor: pointer;
  opacity: 0.65;
}
.editor-ctx__lock-btn--active {
  opacity: 1;
  border-color: var(--border);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.editor-ctx__px-unit {
  color: var(--text-faint);
  font-size: 11px;
}
.editor-ctx__px-apply {
  margin-left: auto;
  padding: 2px 7px;
  font-weight: 600;
}
.editor-ctx__size-label {
  color: var(--text-muted, var(--text));
  font-size: 12px;
  white-space: nowrap;
}
.editor-ctx__size-pills {
  display: flex;
  align-items: center;
  gap: 4px;
}
.editor-ctx__size-btn {
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
}
.editor-ctx__size-btn:hover {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border-color: var(--accent);
}
</style>
