<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useCommands, type Command } from '../composables/useCommands';

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

const filtered = computed<Command[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return allCommands;
  return allCommands.filter((c) => {
    const hay = `${c.title} ${c.id} ${c.hint ?? ''}`.toLowerCase();
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
    <div class="palette" role="dialog" aria-label="Command palette">
      <input
        ref="inputRef"
        v-model="query"
        @keydown="onKey"
        class="palette__input"
        placeholder="Type a command…"
        spellcheck="false"
      />
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
          <span class="palette__title">{{ c.title }}</span>
          <span class="palette__shortcut" v-if="c.shortcut">{{ c.shortcut }}</span>
        </li>
      </ul>
      <div class="palette__empty" v-else>No matching command</div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.palette__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  z-index: var(--z-modal);
}
.palette {
  width: min(560px, 92vw);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: 60vh;
}
.palette__input {
  background: transparent;
  border: none;
  outline: none;
  padding: 14px 16px;
  font: 14px var(--font-ui);
  color: var(--text);
  border-bottom: 1px solid var(--border);
}
.palette__list {
  list-style: none;
  margin: 0;
  padding: 6px 0;
  overflow-y: auto;
}
.palette__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}
.palette__item--active {
  background: var(--accent-soft);
}
.palette__shortcut {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
}
.palette__empty {
  padding: 18px;
  color: var(--text-muted);
  text-align: center;
  font-size: 13px;
}
</style>
