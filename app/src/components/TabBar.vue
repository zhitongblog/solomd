<script setup lang="ts">
import { useTabsStore } from '../stores/tabs';
import { useFiles } from '../composables/useFiles';

const tabs = useTabsStore();
const files = useFiles();

function isDirty(id: string) {
  return tabs.isDirty(id);
}
</script>

<template>
  <div class="tabbar">
    <div class="tabs">
      <div
        v-for="t in tabs.tabs"
        :key="t.id"
        class="tab"
        :class="{ 'tab--active': t.id === tabs.activeId }"
        @click="tabs.activate(t.id)"
        :title="t.filePath || t.fileName"
      >
        <span class="tab__name">{{ t.fileName }}</span>
        <span class="tab__outline" v-if="t.showOutline && t.language === 'markdown'" title="Outline on">≡</span>
        <span class="tab__dot" v-if="isDirty(t.id)">●</span>
        <button
          class="tab__close"
          @click.stop="files.closeTabSafe(t.id)"
          aria-label="Close tab"
        >×</button>
      </div>
    </div>
    <button class="tabbar__new" @click="files.newFile" title="New tab (Ctrl+N)">+</button>
  </div>
</template>

<style scoped>
.tabbar {
  display: flex;
  align-items: stretch;
  height: var(--tabbar-h);
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  user-select: none;
  overflow: hidden;
}
.tabs {
  display: flex;
  flex: 1;
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar { display: none; }

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  padding: 0 10px 0 14px;
  border-right: 1px solid var(--border);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  position: relative;
}
.tab:hover {
  background: var(--bg-hover);
}
.tab--active {
  background: var(--bg);
  color: var(--text);
}
.tab--active::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 2px;
  background: var(--accent);
}
.tab__name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab__dot {
  color: var(--accent);
  font-size: 10px;
}
.tab__outline {
  font-size: 11px;
  color: var(--text-faint);
}
.tab__close {
  padding: 0 4px;
  font-size: 14px;
  line-height: 1;
  color: var(--text-faint);
  opacity: 0;
  transition: opacity 0.12s;
}
.tab:hover .tab__close,
.tab--active .tab__close {
  opacity: 1;
}
.tab__close:hover {
  color: var(--text);
  background: var(--bg-active);
}
.tabbar__new {
  width: 32px;
  padding: 0;
  font-size: 16px;
  color: var(--text-muted);
}
</style>
