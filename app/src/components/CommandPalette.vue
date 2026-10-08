<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useCommands, type Command } from '../composables/useCommands';
import { useI18n } from '../i18n';
import Icons from './Icons.vue';
import { useSettingsStore } from '../stores/settings';
import { shortcutLabel } from '../lib/keybindings';
import { usesCommandKey } from '../lib/platform';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const query = ref('');
const selectedIdx = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLUListElement | null>(null);
// #92 — itemRefs are populated by the template's :ref="..." callback so
// we can scrollIntoView the active item when the keyboard moves selection.
// Without this the viewport stayed pinned to the top and the user couldn't
// see what they had highlighted past the first ~8 visible rows.
const itemRefs = ref<(HTMLElement | null)[]>([]);
function setItemRef(el: Element | unknown, i: number) {
  itemRefs.value[i] = (el as HTMLElement) ?? null;
}
const allCommands = useCommands();
const { t } = useI18n();
// #180 — read the chord at render time, not when the command list was built:
// a rebind in Settings must show up here without reopening the app.
const kbSettings = useSettingsStore();
const macChords = usesCommandKey();
function chordFor(c: { id: string; shortcut?: string }): string {
  return shortcutLabel(c.id, kbSettings.keybindings, macChords) || '';
}

// #177 — localized command titles. Missing ids used to render as the literal
// key ("cmd.editor.caseUpper") because `t()` returns the key when nothing
// defines it; falling back to the command's own English title degrades a gap
// to untranslated instead of to gibberish.
function localizedTitle(c: Command): string {
  const key = `cmd.${c.id}`;
  const translated = t(key);
  return translated === key ? c.title : translated;
}

const filtered = computed<Command[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return allCommands;
  return allCommands.filter((c) => {
    // Match both the localized title and the original English one, so
    // muscle-memory queries ("outline") keep working in any language.
    const hay = `${localizedTitle(c)} ${c.title} ${c.id} ${c.hint ?? ''}`.toLowerCase();
    return q.split(/\s+/).every((tok) => hay.includes(tok));
  });
});

watch(
  () => props.open,
  async (v) => {
    if (v) {
      query.value = '';
      selectedIdx.value = 0;
      await nextTick();
      inputRef.value?.focus();
    }
  }
);

watch(filtered, () => {
  selectedIdx.value = 0;
});

// #92 — scroll the selected item into view when arrow-key navigation moves
// selection. block: 'nearest' avoids the "yank to centre" jump that a
// plain scrollIntoView() would do every keypress. We only fire after a
// nextTick so the DOM has settled when filtered just changed.
// #93 — but ONLY for keyboard moves. Hovering / wheel-scrolling changes
// selectedIdx via @mouseenter (items pass under the cursor as the list
// scrolls); scrolling those into view fought the wheel and caused the
// "weird jumps". `kbNav` gates the auto-scroll to keyboard navigation only.
let kbNav = false;
watch(selectedIdx, async () => {
  if (!kbNav) return;
  kbNav = false;
  await nextTick();
  const el = itemRefs.value[selectedIdx.value];
  if (el) el.scrollIntoView({ block: 'nearest' });
});

function onKey(e: KeyboardEvent) {
  // CJK/IME guard — Enter / arrows during composition belong to the IME
  // (commit candidate, navigate candidate list); never let them act on
  // the palette state.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    kbNav = true;
    selectedIdx.value = Math.min(selectedIdx.value + 1, filtered.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    kbNav = true;
    selectedIdx.value = Math.max(selectedIdx.value - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runIdx(selectedIdx.value);
  }
}

async function runIdx(i: number) {
  const cmd = filtered.value[i];
  if (!cmd) return;
  emit('close');
  await Promise.resolve(cmd.run());
}
</script>

<template>
  <Teleport to="body">
  <div v-if="open" class="palette__backdrop" @click.self="emit('close')">
    <div class="palette" role="dialog" :aria-label="t('toolbar.paletteTitle')">
      <div class="palette__field">
        <Icons class="palette__field-icon" name="search" :size="16" aria-hidden="true" />
        <input
          ref="inputRef"
          v-model="query"
          @keydown="onKey"
          class="palette__input"
          :placeholder="t('palette.placeholder')"
          spellcheck="false"
        />
      </div>
      <ul class="palette__list" ref="listRef" v-if="filtered.length">
        <li
          v-for="(c, i) in filtered"
          :key="c.id"
          :ref="(el) => setItemRef(el, i)"
          class="palette__item"
          :class="{ 'palette__item--active': i === selectedIdx }"
          @click="runIdx(i)"
          @mouseenter="selectedIdx = i"
        >
          <span class="palette__title">{{ localizedTitle(c) }}</span>
          <span class="palette__shortcut" v-if="chordFor(c)">{{ chordFor(c) }}</span>
        </li>
      </ul>
      <div class="palette__empty" v-else>{{ t('palette.empty') }}</div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
/* 5.0 (spec §6): 640px, radius 12, --sh-modal on --bg-pop; a 44px input row
   with a search icon and 15px text; 34px rows (radius 7), the selected one
   --fill-2; chords / paths right in --text-3; opens like a dialog (180ms fade
   + scale, keyframes in styles/menus.css). */
.palette__backdrop {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 14vh;
  z-index: var(--z-modal);
  animation: sm-fade-in var(--dur) var(--ease-out);
}
.palette {
  width: min(640px, calc(100vw - 32px));
  background: var(--bg-pop);
  color: var(--text);
  border: var(--bd-hair);
  border-radius: 12px;
  box-shadow: var(--sh-modal);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: min(480px, 64vh);
  transform-origin: top center;
  animation: sm-dialog-in var(--dur) var(--ease-out);
}
.palette__field {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  height: 44px;
  padding: 0 16px;
  border-bottom: var(--bd-hair);
  color: var(--text-3);
}
.palette__field-icon {
  flex: none;
}
.palette__input {
  flex: 1;
  min-width: 0;
  height: 100%;
  background: transparent;
  border: none;
  outline: none;
  padding: 0;
  font: 15px var(--font-ui);
  color: var(--text);
}
.palette__input::placeholder {
  color: var(--text-3);
}
.palette__list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
}
.palette__item {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 34px;
  padding: 0 10px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--text);
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
}
.palette__item--active {
  background: var(--fill-2);
}
.palette__empty {
  padding: 20px 16px;
  color: var(--text-3);
  text-align: center;
  font-size: 13px;
}
.palette__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.palette__shortcut {
  flex: none;
  color: var(--text-3);
  font-size: 12px;
  letter-spacing: 0.02em;
}
@media (prefers-reduced-motion: reduce) {
  .palette__backdrop,
  .palette {
    animation: none;
  }
}
</style>
