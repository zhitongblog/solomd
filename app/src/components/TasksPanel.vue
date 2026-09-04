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

const PRIORITY_MARK: Record<string, string> = { high: '⏫', medium: '🔼', low: '🔽' };

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
  <div class="tasks-panel">
    <header class="tasks-panel__head">
      <span class="tasks-panel__title">{{ t('tasks.heading') }}</span>
      <span v-if="openCount" class="tasks-panel__badge">{{ openCount }}</span>
      <button
        class="rs-pane-close"
        type="button"
        :title="t('rightSidebar.hidePane')"
        @click="emit('close')"
      >×</button>
    </header>

    <div class="tasks-panel__filters">
      <button
        v-for="f in (['open', 'today', 'all'] as Filter[])"
        :key="f"
        class="tasks-panel__chip"
        :class="{ 'tasks-panel__chip--on': filter === f }"
        @click="filter = f"
      >{{ t(`tasks.filter.${f}`) }}</button>
      <button
        class="tasks-panel__chip tasks-panel__chip--flag"
        :class="{ 'tasks-panel__chip--on': priorityOnly }"
        :title="t('tasks.priorityOnly')"
        @click="priorityOnly = !priorityOnly"
      >⏫</button>
    </div>

    <div v-if="!hasFolder" class="tasks-panel__empty">{{ t('tasks.openFolder') }}</div>
    <div v-else-if="groups.length === 0" class="tasks-panel__empty">{{ t('tasks.empty') }}</div>

    <div v-else class="tasks-panel__list">
      <section v-for="group in groups" :key="group.path" class="tasks-panel__group">
        <h4 class="tasks-panel__file">{{ group.fileName }}</h4>
        <ul class="tasks-panel__items">
          <li v-for="task in group.items" :key="`${task.path}:${task.line}`" class="tasks-panel__item">
            <input
              type="checkbox"
              class="tasks-panel__check"
              :checked="task.done"
              :aria-label="task.meta.title"
              @click.stop="toggle(task)"
            />
            <button
              class="tasks-panel__row"
              :class="{ 'tasks-panel__row--done': task.done }"
              @click="openTask(task)"
            >
              <span class="tasks-panel__text">{{ task.meta.title }}</span>
              <span v-if="task.meta.priority" class="tasks-panel__prio">
                {{ PRIORITY_MARK[task.meta.priority] }}
              </span>
              <span
                v-if="task.meta.due"
                class="tasks-panel__due"
                :class="{ 'tasks-panel__due--overdue': overdue(task) }"
              >{{ task.meta.due }}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.tasks-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
.tasks-panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
}
.tasks-panel__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  flex: 1;
}
.tasks-panel__badge {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.tasks-panel__filters {
  display: flex;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.tasks-panel__chip {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
  cursor: pointer;
}
.tasks-panel__chip--flag {
  padding: 2px 8px;
  margin-left: auto;
}
.tasks-panel__chip--on {
  background: var(--accent-soft, rgba(255, 159, 64, 0.12));
  border-color: var(--accent, #ff9f40);
  color: var(--accent, #ff9f40);
}
.tasks-panel__empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.tasks-panel__list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.tasks-panel__group + .tasks-panel__group {
  margin-top: 10px;
}
.tasks-panel__file {
  margin: 0 0 2px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tasks-panel__items {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tasks-panel__item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 6px;
}
.tasks-panel__item:hover {
  background: var(--bg-hover);
}
.tasks-panel__check {
  margin: 5px 0 0;
  flex-shrink: 0;
  cursor: pointer;
}
.tasks-panel__row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 0;
  padding: 4px 4px;
  text-align: left;
  cursor: pointer;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
}
.tasks-panel__row--done .tasks-panel__text {
  text-decoration: line-through;
  color: var(--text-faint);
}
.tasks-panel__text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.tasks-panel__prio {
  flex-shrink: 0;
  font-size: 11px;
}
.tasks-panel__due {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.tasks-panel__due--overdue {
  color: var(--danger, #d64545);
  font-weight: 600;
}
</style>
