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
}

// `hasImage`: the right-click landed on a rendered image (#362) — offer
// "Copy image" on top of the text items.
const props = defineProps<{
  x: number;
  y: number;
  hasSelection: boolean;
  hasImage?: boolean;
  spell?: EditorMenuSpell | null;
}>();
const emit = defineEmits<{
  (e: 'action', id: EditorMenuAction): void;
  (e: 'replace', word: string): void;
  (e: 'add-word', word: string): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const pos = ref({ left: props.x, top: props.y });
const mod = usesCommandKey() ? '⌘' : 'Ctrl+';

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
        <span class="editor-ctx__label">{{ s }}</span>
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
      <button
        v-if="props.spell.canAdd"
        type="button"
        role="menuitem"
        class="editor-ctx__item"
        data-action="addToDict"
        @mousedown.prevent
        @click="emit('add-word', props.spell.word)"
      >
        <span class="editor-ctx__label">{{ t('spellcheck.addToDict') }}</span>
      </button>
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
</style>
