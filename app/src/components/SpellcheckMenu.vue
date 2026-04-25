<script setup lang="ts">
/**
 * Pop-over menu shown when the user right-clicks a misspelled word.
 *
 * Layout:
 *   ┌────────────────────────────┐
 *   │  Suggestions               │  ← header (i18n: spellcheck.suggestions)
 *   ├────────────────────────────┤
 *   │  fix1                      │  ← clickable, emits select(fix1)
 *   │  fix2                      │
 *   │  …                         │
 *   ├────────────────────────────┤
 *   │  Add to dictionary         │  ← emits add-to-dict
 *   │  Ignore once               │  ← emits ignore
 *   └────────────────────────────┘
 *
 * The host (Editor.vue) is responsible for positioning: it passes pixel
 * coordinates `x`/`y` (top-left anchor); we render fixed-position so the
 * menu floats above the editor regardless of scroll.
 *
 * The menu closes on Escape, on outside click, or when any action is
 * dispatched (parent should also call `emit('close')` after handling).
 *
 * i18n keys used (parent must add these to `i18n/en.ts` + `i18n/zh.ts`):
 *   - `spellcheck.suggestions`   — "Suggestions" / "拼写建议"
 *   - `spellcheck.addToDict`     — "Add to dictionary" / "添加到词典"
 *   - `spellcheck.ignoreOnce`    — "Ignore once" / "本次忽略"
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from '../i18n';

interface Props {
  word: string;
  suggestions: string[];
  x: number;
  y: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'select', word: string): void;
  (e: 'add-to-dict'): void;
  (e: 'ignore'): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();
const root = ref<HTMLElement | null>(null);

function onSelect(s: string) {
  emit('select', s);
  emit('close');
}

function onAdd() {
  emit('add-to-dict');
  emit('close');
}

function onIgnore() {
  emit('ignore');
  emit('close');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

function onDocClick(e: MouseEvent) {
  const el = root.value;
  if (!el) return;
  if (!el.contains(e.target as Node)) {
    emit('close');
  }
}

onMounted(() => {
  // `mousedown` rather than `click` so the host's own contextmenu listener
  // doesn't accidentally re-open the menu on the same gesture.
  document.addEventListener('mousedown', onDocClick, true);
  document.addEventListener('keydown', onKeydown);
  // Move keyboard focus into the popover so Escape works without an extra
  // click first.
  root.value?.focus();
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick, true);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div
    ref="root"
    class="spellcheck-menu"
    role="menu"
    tabindex="-1"
    :style="{ left: `${props.x}px`, top: `${props.y}px` }"
    @contextmenu.prevent
  >
    <div class="spellcheck-menu__header">
      {{ t('spellcheck.suggestions') }}
      <span class="spellcheck-menu__word">{{ props.word }}</span>
    </div>

    <div v-if="props.suggestions.length === 0" class="spellcheck-menu__empty">
      —
    </div>
    <button
      v-for="s in props.suggestions"
      :key="s"
      type="button"
      class="spellcheck-menu__item"
      role="menuitem"
      @click="onSelect(s)"
    >
      {{ s }}
    </button>

    <div class="spellcheck-menu__divider" />

    <button
      type="button"
      class="spellcheck-menu__item"
      role="menuitem"
      @click="onAdd"
    >
      {{ t('spellcheck.addToDict') }}
    </button>
    <button
      type="button"
      class="spellcheck-menu__item"
      role="menuitem"
      @click="onIgnore"
    >
      {{ t('spellcheck.ignoreOnce') }}
    </button>
  </div>
</template>

<style scoped>
.spellcheck-menu {
  position: fixed;
  z-index: 3000;
  min-width: 180px;
  max-width: 280px;
  background: var(--bg-elev, #fff);
  color: var(--text, #222);
  border: 1px solid var(--border, #ccc);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 4px 0;
  font-size: 13px;
  outline: none;
  user-select: none;
}
.spellcheck-menu__header {
  padding: 6px 12px 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted, #888);
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.spellcheck-menu__word {
  font-style: italic;
  color: var(--text-muted, #888);
  text-transform: none;
  letter-spacing: 0;
  font-size: 11px;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spellcheck-menu__empty {
  padding: 4px 12px;
  color: var(--text-muted, #888);
  font-style: italic;
}
.spellcheck-menu__item {
  appearance: none;
  background: transparent;
  border: none;
  width: 100%;
  text-align: left;
  padding: 6px 12px;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.spellcheck-menu__item:hover,
.spellcheck-menu__item:focus-visible {
  background: var(--accent, #ff9f40);
  color: var(--accent-fg, #fff);
  outline: none;
}
.spellcheck-menu__divider {
  height: 1px;
  background: var(--border, #ccc);
  margin: 4px 0;
}
</style>
