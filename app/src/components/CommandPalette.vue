<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useCommands, type Command } from '../composables/useCommands';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const query = ref('');
const selectedIdx = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
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

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIdx.value = Math.min(selectedIdx.value + 1, filtered.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
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
      <ul class="palette__list" v-if="filtered.length">
        <li
          v-for="(c, i) in filtered"
          :key="c.id"
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
</template>

<style scoped>
.palette__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  z-index: 1000;
}
.palette {
  width: min(560px, 92vw);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
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
  background: var(--bg-active);
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
