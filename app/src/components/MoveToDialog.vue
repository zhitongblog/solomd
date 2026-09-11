<script setup lang="ts">
/**
 * "Move to…" — the keyboard (and touch) half of #290 / #267.
 *
 * Drag-and-drop covers the mouse, but HTML5 drag events never fire on a
 * touchscreen and a drag is not reachable from the keyboard at all, so the
 * same operation is also a context-menu command that opens this picker:
 * type to filter, ↑/↓ to choose, Enter to move.
 *
 * The folder list comes from `fs_list_dirs` rather than from the tree,
 * because the tree only knows about folders that happen to be expanded —
 * and the whole point is filing a note somewhere you haven't visited today.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { DsModal, DsInput } from '../ui';
import { useI18n } from '../i18n';

const { t } = useI18n();

const props = defineProps<{
  open: boolean;
  /** Name of the node being moved — shown in the title. */
  nodeName: string;
  /** Vault-relative folder paths ('' is the vault root, added here). */
  dirs: string[];
  /** Vault-relative folder the node currently lives in — offered but marked. */
  currentDir: string;
  /** Vault-relative path of the node itself, when it is a folder: it and its
   *  own subtree can't be its destination. */
  selfDir: string | null;
}>();

const emit = defineEmits<{
  (e: 'confirm', relDir: string): void;
  (e: 'cancel'): void;
}>();

const query = ref('');
const active = ref(0);
const inputRef = ref<InstanceType<typeof DsInput> | null>(null);
const listRef = ref<HTMLElement | null>(null);

const candidates = computed(() => {
  const all = ['', ...props.dirs];
  return all.filter((d) => {
    if (d === props.currentDir) return false;
    if (props.selfDir !== null) {
      if (d === props.selfDir) return false;
      if (d.startsWith(props.selfDir + '/')) return false;
    }
    return true;
  });
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return candidates.value;
  // Every query character in order, anywhere — the same forgiving match the
  // command palette uses, so "aw" finds "archive/work".
  return candidates.value.filter((d) => {
    const hay = (d || '/').toLowerCase();
    let i = 0;
    for (const ch of q) {
      i = hay.indexOf(ch, i);
      if (i === -1) return false;
      i += 1;
    }
    return true;
  });
});

watch(
  () => props.open,
  (o) => {
    if (!o) return;
    query.value = '';
    active.value = 0;
    nextTick(() => {
      (inputRef.value?.$el?.querySelector?.('input') as HTMLInputElement | undefined)?.focus();
    });
  },
);

watch(filtered, () => {
  active.value = 0;
});

function label(d: string): string {
  return d === '' ? t('explorer.vaultRoot') || 'Vault root' : d;
}

function move(delta: number) {
  const n = filtered.value.length;
  if (!n) return;
  active.value = (active.value + delta + n) % n;
  nextTick(() => {
    listRef.value
      ?.querySelector('.mtd__row--active')
      ?.scrollIntoView({ block: 'nearest' });
  });
}

function confirmActive() {
  const d = filtered.value[active.value];
  if (d === undefined) return;
  emit('confirm', d);
}

function onKeydown(e: KeyboardEvent) {
  // The IME guard the rest of the app uses: mid-composition Enter belongs to
  // the candidate window, not to us.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    confirmActive();
  }
}
</script>

<template>
  <DsModal
    :model-value="open"
    :title="t('explorer.moveToTitle', { name: nodeName }) || `Move “${nodeName}” to…`"
    width="460px"
    @update:model-value="emit('cancel')"
  >
    <div class="mtd">
      <DsInput
        ref="inputRef"
        v-model="query"
        :placeholder="t('explorer.moveToFilter') || 'Filter folders…'"
        spellcheck="false"
        @keydown="onKeydown"
      />
      <div ref="listRef" class="mtd__list">
        <button
          v-for="(d, i) in filtered"
          :key="d || '__root__'"
          class="mtd__row"
          :class="{ 'mtd__row--active': i === active }"
          :title="d || '/'"
          @mousemove="active = i"
          @click="emit('confirm', d)"
        >
          <span class="mtd__icon" aria-hidden="true">{{ d === '' ? '🗂' : '📁' }}</span>
          <span class="mtd__path">{{ label(d) }}</span>
        </button>
        <p v-if="filtered.length === 0" class="mtd__empty">
          {{ t('explorer.moveToNone') || 'No folder matches.' }}
        </p>
      </div>
    </div>
  </DsModal>
</template>

<style scoped>
.mtd {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mtd__list {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px;
}
.mtd__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.mtd__row--active {
  background: var(--accent-soft, var(--bg-elev));
}
.mtd__icon {
  flex: none;
  font-size: 13px;
}
.mtd__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mtd__empty {
  margin: 0;
  padding: 12px 8px;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
