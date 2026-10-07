<script setup lang="ts">
/**
 * Tasks sidebar panel — every `- [ ]` in the workspace, in one list.
 *
 * Notes accumulate to-dos in the file they belong to, which is the right place
 * to write them and the wrong place to find them: answering "what is open?"
 * meant opening every note. This reads the workspace index (which already
 * tracks task lines and is kept live by the file watcher), so the list is
 * current without a scan and without a second source of truth.
 *
 * Ticking a box here rewrites the checkbox in the note. Clicking the row opens
 * the note at that line — the panel is a way in, not a replacement inbox: the
 * task's context is the paragraph it sits in, and this list can't show that.
 */
import { computed, ref } from 'vue';
import { useTasks, type WorkspaceTask } from '../composables/useTasks';
import { useFiles } from '../composables/useFiles';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { useTilesStore } from '../stores/tiles';
import { useI18n } from '../i18n';
import Icons from './Icons.vue';
import PanelHeader from './panel/PanelHeader.vue';
import SegControl from './panel/SegControl.vue';
import { isOverdue, localDateKey } from '../lib/tasks';

const { tasks, toggle } = useTasks();
const files = useFiles();
const idx = useWorkspaceIndexStore();
const tiles = useTilesStore();
const { t } = useI18n();

const emit = defineEmits<{ (e: 'close'): void }>();

type Filter = 'open' | 'today' | 'all';
const filter = ref<Filter>('open');
const priorityOnly = ref(false);

/** Recomputed per render rather than cached: the panel can be open across
 *  midnight, and a stale "today" is how a task silently stops being overdue. */
const today = computed(() => localDateKey(new Date()));

const visible = computed<WorkspaceTask[]>(() => {
  let list = tasks.value;
  if (filter.value === 'open') list = list.filter((x) => !x.done);
  else if (filter.value === 'today') {
    list = list.filter(
      (x) => !x.done && x.meta.due !== null && x.meta.due <= today.value,
    );
  }
  if (priorityOnly.value) list = list.filter((x) => x.meta.priority !== null);
  return list;
});

/** Grouped by file so a row's origin is obvious without repeating the file
 *  name on every line. */
const groups = computed(() => {
  const byFile = new Map<string, { fileName: string; items: WorkspaceTask[] }>();
  for (const task of visible.value) {
    const g = byFile.get(task.path) ?? { fileName: task.fileName, items: [] };
    g.items.push(task);
    byFile.set(task.path, g);
  }
  return [...byFile.entries()].map(([path, g]) => ({ path, ...g }));
});

const openCount = computed(() => tasks.value.filter((x) => !x.done).length);
const hasFolder = computed(() => idx.folder !== null);

function overdue(task: WorkspaceTask): boolean {
  return !task.done && isOverdue(task.meta.due, today.value);
}

async function openTask(task: WorkspaceTask) {
  await files.openPath(task.path, { bypassNewWindow: true });
  // The editor needs a tick to mount the new document before a line jump can
  // land; the outline panel's jump has the same shape.
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent('solomd:outline-goto', {
        detail: { line: task.line, paneId: tiles.focusedPaneId },
      }),
    );
  }, 120);
}
</script>

<template>
  <div class="tasks-panel rp">
    <PanelHeader :title="t('tasks.heading')" :count="openCount || null" @close="emit('close')" />

    <div class="tasks-panel__filters">
      <SegControl
        v-model="filter"
        class="tasks-panel__seg"
        :options="(['open', 'today', 'all'] as Filter[]).map((f) => ({ value: f, label: t(`tasks.filter.${f}`) }))"
      />
      <button
        class="rp-icon-btn tasks-panel__flag"
        :class="{ 'is-on': priorityOnly }"
        type="button"
        :title="t('tasks.priorityOnly')"
        :aria-label="t('tasks.priorityOnly')"
        :aria-pressed="priorityOnly"
        @click="priorityOnly = !priorityOnly"
      >
        <span class="tasks-panel__bars tasks-panel__bars--high" aria-hidden="true"><i /><i /><i /></span>
      </button>
    </div>

    <div v-if="!hasFolder" class="rp-empty">{{ t('tasks.openFolder') }}</div>
    <div v-else-if="groups.length === 0" class="rp-empty">{{ t('tasks.empty') }}</div>

    <div v-else class="rp-body tasks-panel__list">
      <section v-for="group in groups" :key="group.path" class="tasks-panel__group">
        <h4 class="rp-section tasks-panel__file">
          <Icons name="file" :size="12" />
          <span class="rp-row__label">{{ group.fileName }}</span>
        </h4>
        <ul class="rp-list">
          <li
            v-for="task in group.items"
            :key="`${task.path}:${task.line}`"
            class="rp-row tasks-panel__item"
            :class="{ 'tasks-panel__item--done': task.done }"
            @click="openTask(task)"
          >
            <input
              type="checkbox"
              class="rp-check tasks-panel__check"
              :checked="task.done"
              :aria-label="task.meta.title"
              @click.stop="toggle(task)"
            />
            <span class="tasks-panel__text">{{ task.meta.title }}</span>
            <span
              v-if="task.meta.priority"
              class="tasks-panel__bars"
              :class="`tasks-panel__bars--${task.meta.priority}`"
              :title="task.meta.priority"
            ><i /><i /><i /></span>
            <span
              v-if="task.meta.due"
              class="tasks-panel__due"
              :class="{ 'tasks-panel__due--overdue': overdue(task) }"
            >{{ task.meta.due }}</span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.tasks-panel__filters {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 8px 12px;
}
.tasks-panel__seg {
  flex: 1 1 auto;
  min-width: 0;
}
.tasks-panel__flag {
  width: 28px;
  height: 28px;
}
.tasks-panel__group + .tasks-panel__group {
  margin-top: 6px;
}
.tasks-panel__file {
  margin: 0;
  min-width: 0;
  letter-spacing: 0;
  font-weight: 500;
  font-size: 12px;
}
.tasks-panel__item {
  align-items: flex-start;
  padding-top: 6px;
  padding-bottom: 6px;
  min-height: 28px;
  line-height: 1.35;
}
.tasks-panel__check {
  margin-top: 2px;
}
.tasks-panel__text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.tasks-panel__item--done .tasks-panel__text {
  text-decoration: line-through;
  color: var(--text-3);
}
.tasks-panel__due {
  flex-shrink: 0;
  margin-top: 1px;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.tasks-panel__due--overdue {
  color: var(--danger);
  font-weight: 500;
}
/* Priority: three ascending bars, filled by level (no emoji). */
.tasks-panel__bars {
  flex-shrink: 0;
  display: inline-flex;
  align-items: flex-end;
  gap: 1.5px;
  height: 11px;
  margin-top: 3px;
}
.tasks-panel__bars i {
  display: block;
  width: 2.5px;
  border-radius: 1px;
  background: var(--fill-2);
}
.tasks-panel__bars i:nth-child(1) { height: 5px; }
.tasks-panel__bars i:nth-child(2) { height: 8px; }
.tasks-panel__bars i:nth-child(3) { height: 11px; }
.tasks-panel__bars--low i:nth-child(1),
.tasks-panel__bars--medium i:nth-child(-n + 2),
.tasks-panel__bars--high i {
  background: var(--accent);
}
.tasks-panel__flag .tasks-panel__bars {
  margin-top: 0;
}
.tasks-panel__flag:not(.is-on) .tasks-panel__bars i {
  background: currentColor;
  opacity: 0.55;
}
</style>
