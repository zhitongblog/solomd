<script setup lang="ts">
/**
 * 5.0 stats pill (docs/v5-ui-spec.md §5) — replaces the status bar.
 *
 * A quiet "1,284 字" / "1,284 words" chip in the bottom-right corner of the
 * editor area. Clicking it opens a popover with everything the status bar
 * used to show: caret position, line / word / CJK / character counts, the
 * selection count, encoding, line endings, language, today's workspace total,
 * and the status bar's other tenants — writing goals, the pomodoro timer, the
 * sync status and the inbox toggle — so nothing that lived down there is lost.
 *
 * Mounted inside `.content` (position: relative); positions itself absolutely.
 * In focus mode it stays out of sight until the pointer comes near.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usesCommandKey } from '../lib/platform';
import { shortcutLabel } from '../lib/keybindings';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore } from '../stores/settings';
import { useWritingSessionStore } from '../stores/writingSession';
import { usePomodoroStore } from '../stores/pomodoro';
import { cjkWordCount } from '../lib/chinese';
import { useInbox } from '../composables/useInbox';
import { useI18n } from '../i18n';
import Icon from './Icons.vue';
import WritingGoals from './WritingGoals.vue';
import PomodoroPill from './PomodoroPill.vue';
import SyncStatusPill from './SyncStatusPill.vue';

const props = withDefaults(
  defineProps<{ line: number; col: number; selectionText?: string }>(),
  { selectionText: '' },
);

const tabs = useTabsStore();
const settings = useSettingsStore();
const writingSession = useWritingSessionStore();
const pomodoro = usePomodoroStore();
const inbox = useInbox();
const { t } = useI18n();

// ---- Counts (same tokenizer as the old status bar, lib/chinese.ts) ----
const content = computed(() => tabs.activeTab?.content ?? '');
const stats = computed(() => cjkWordCount(content.value));
const lineCount = computed(() => (content.value ? content.value.split('\n').length : 0));
const selStats = computed(() => (props.selectionText ? cjkWordCount(props.selectionText) : null));
/** "Mostly CJK": more CJK characters than Latin words. Such a text is counted
 *  the way CJK writers count — every character a unit — and labelled 字. */
const mostlyCjk = computed(() => stats.value.cjk > 0 && stats.value.cjk >= stats.value.asciiWords);

const fmt = (n: number) => n.toLocaleString();
const pillLabel = computed(() =>
  t(mostlyCjk.value ? 'statsPill.cjk' : 'statsPill.words', { n: fmt(stats.value.total) }),
);

const lang = computed(() =>
  tabs.activeTab?.language === 'markdown' ? t('statusbar.markdown') : t('statusbar.plaintext'),
);
const enc = computed(() => tabs.activeTab?.encoding ?? 'UTF-8');
const eol = computed(() => {
  const le = tabs.activeTab?.lineEnding;
  return le ? le.toUpperCase() : '';
});
const showTodayTotal = computed(
  () =>
    settings.showWritingStats &&
    settings.showWorkspaceDailyTotal &&
    writingSession.todayDocCount > 0,
);

// ---- Inbox toggle (was the INBOX chip in the status bar) ----
const macChord = usesCommandKey();
function withChord(key: string, actionId: string): string {
  return t(key, { key: shortcutLabel(actionId, settings.keybindings, macChord) || '—' });
}
function onInboxClick() {
  // Same affordance as ⌘E — see StatusBar.vue history (v4.6 F6).
  if (settings.inboxWorkflowEnabled) void inbox.organizeAndAdvance();
  else inbox.toggleActive();
}

// ---- Popover ----
const open = ref(false);
const root = ref<HTMLElement | null>(null);
function toggle() {
  open.value = !open.value;
}
function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return;
  const el = root.value;
  if (el && e.target instanceof Node && el.contains(e.target)) return;
  // Pomodoro's right-click menu is positioned with `fixed` inside our tree,
  // so it is covered by the contains() above; anything else closes us.
  open.value = false;
}
function onKeydown(e: KeyboardEvent) {
  if (open.value && e.key === 'Escape') {
    open.value = false;
    e.stopPropagation();
  }
}

// ---- Focus mode: hidden until the pointer comes near ----
const NEAR_PX = 120;
const near = ref(false);
let raf = 0;
let lastX = 0;
let lastY = 0;
function measureNear() {
  raf = 0;
  const el = root.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const dx = Math.max(r.left - lastX, 0, lastX - r.right);
  const dy = Math.max(r.top - lastY, 0, lastY - r.bottom);
  near.value = Math.hypot(dx, dy) < NEAR_PX;
}
function onPointerMove(e: PointerEvent) {
  lastX = e.clientX;
  lastY = e.clientY;
  if (!raf) raf = requestAnimationFrame(measureNear);
}
function attachNear(on: boolean) {
  if (on) window.addEventListener('pointermove', onPointerMove, { passive: true });
  else {
    window.removeEventListener('pointermove', onPointerMove);
    near.value = false;
  }
}
watch(
  () => settings.focusMode,
  (on) => attachNear(on),
);
const hidden = computed(() => settings.focusMode && !near.value && !open.value);

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onKeydown, true);
  if (settings.focusMode) attachNear(true);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onKeydown, true);
  attachNear(false);
  if (raf) cancelAnimationFrame(raf);
});
// Close when the document changes under us (tab switch).
watch(
  () => tabs.activeId,
  () => nextTick(() => (open.value = false)),
);
</script>

<template>
  <div
    v-if="tabs.activeTab"
    ref="root"
    class="stats-pill"
    :class="{ 'stats-pill--hidden': hidden, 'stats-pill--open': open }"
    data-stats-pill
  >
    <div v-if="open" class="stats-pop" role="dialog" :aria-label="t('statsPill.title')">
      <div class="stats-pop__row">
        <span class="stats-pop__label">{{ t('statsPill.position') }}</span>
        <span class="stats-pop__value">{{ t('statusbar.ln') }} {{ props.line }}, {{ t('statusbar.col') }} {{ props.col }}</span>
      </div>
      <div class="stats-pop__row">
        <span class="stats-pop__label">{{ t('statsPill.lines') }}</span>
        <span class="stats-pop__value">{{ fmt(lineCount) }}</span>
      </div>
      <div class="stats-pop__row">
        <span class="stats-pop__label">{{ t('statsPill.wordsLabel') }}</span>
        <span class="stats-pop__value">{{ fmt(stats.total) }}</span>
      </div>
      <div v-if="stats.cjk > 0" class="stats-pop__row">
        <span class="stats-pop__label">{{ t('statsPill.cjkLabel') }}</span>
        <span class="stats-pop__value">{{ fmt(stats.cjk) }}</span>
      </div>
      <div class="stats-pop__row">
        <span class="stats-pop__label">{{ t('statsPill.charsLabel') }}</span>
        <span class="stats-pop__value">{{ fmt(stats.chars) }}</span>
      </div>
      <div v-if="selStats" class="stats-pop__row stats-pop__row--accent" :title="t('statusBar.selectionTooltip')">
        <span class="stats-pop__label">{{ t('statsPill.selection') }}</span>
        <span class="stats-pop__value">
          {{ t('statusBar.selection', { words: fmt(selStats.total), chars: fmt(selStats.chars) }) }}
        </span>
      </div>
      <div v-if="showTodayTotal" class="stats-pop__row" :title="t('writingStats.todayTooltip')">
        <span class="stats-pop__label">{{ t('statsPill.today') }}</span>
        <span class="stats-pop__value">
          {{
            t('writingStats.todayWorkspaceValue', {
              n: writingSession.todayTotal.toLocaleString(),
              docs: String(writingSession.todayDocCount),
            })
          }}
        </span>
      </div>
      <div class="stats-pop__sep" />
      <div class="stats-pop__row">
        <span class="stats-pop__label">{{ t('statusbar.encoding') }}</span>
        <span class="stats-pop__value">{{ enc }}</span>
      </div>
      <div v-if="eol" class="stats-pop__row">
        <span class="stats-pop__label">{{ t('statsPill.lineEnding') }}</span>
        <span class="stats-pop__value">{{ eol }}</span>
      </div>
      <div class="stats-pop__row">
        <span class="stats-pop__label">{{ t('statusbar.language') }}</span>
        <span class="stats-pop__value">{{ lang }}</span>
      </div>
      <!-- The status bar's other tenants. Each renders nothing when it has
           nothing to say, so the strip only appears when one of them does. -->
      <div class="stats-pop__extras">
        <WritingGoals v-if="settings.showWritingStats" />
        <PomodoroPill v-if="pomodoro.active" />
        <SyncStatusPill />
        <button
          v-if="inbox.activeIsInbox.value"
          class="stats-pop__chip"
          :title="settings.inboxWorkflowEnabled ? withChord('inbox.pillTooltipOrganize', 'inbox.toggle') : withChord('inbox.pillTooltip', 'inbox.toggle')"
          @click="onInboxClick"
        >
          <Icon name="inbox" :size="14" />
          {{ t('inbox.pill') }}
        </button>
      </div>
    </div>
    <button
      class="stats-pill__btn"
      :aria-expanded="open"
      :aria-label="t('statsPill.title')"
      @click="toggle"
    >
      <span>{{ pillLabel }}</span>
      <template v-if="pomodoro.active">
        <span class="stats-pill__sep" aria-hidden="true">·</span>
        <span class="stats-pill__pomo" :class="{ 'stats-pill__pomo--break': pomodoro.isBreak }">{{ pomodoro.countdown }}</span>
      </template>
      <span v-if="selStats" class="stats-pill__sel">
        <span class="stats-pill__sep" aria-hidden="true">·</span>
        {{ t('statsPill.selectedShort', { n: fmt(selStats.total) }) }}
      </span>
    </button>
  </div>
</template>

<style scoped>
.stats-pill {
  position: absolute;
  right: 16px;
  bottom: 12px;
  z-index: var(--z-sticky);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-family: var(--font-ui);
  transition: opacity var(--dur) var(--ease-out);
}
.stats-pill--hidden {
  opacity: 0;
}
.stats-pill__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 4px 10px;
  border: var(--hair-w) solid transparent;
  border-radius: var(--r-full);
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: var(--text-3);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.stats-pill__btn:hover,
.stats-pill--open .stats-pill__btn {
  border-color: var(--hairline);
  color: var(--text-2);
}
.stats-pill__btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.stats-pill__sep {
  opacity: 0.6;
}
.stats-pill__sel {
  display: inline-flex;
  gap: 6px;
  color: var(--accent-text);
}
.stats-pill__pomo {
  color: var(--accent-text);
}
.stats-pill__pomo--break {
  color: var(--text-2);
}

/* §6 menu style: --bg-pop, 10px radius, 4px padding, 28px rows. */
.stats-pop {
  min-width: 240px;
  margin-bottom: 6px;
  padding: 4px;
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  font-size: 13px;
  color: var(--text);
  transform-origin: bottom right;
  animation: stats-pop-in var(--dur-fast) var(--ease-out);
}
@keyframes stats-pop-in {
  from { opacity: 0; transform: scale(0.98); }
  to { opacity: 1; transform: scale(1); }
}
.stats-pop__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--r-sm);
}
.stats-pop__label {
  color: var(--text-2);
}
.stats-pop__value {
  color: var(--text);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.stats-pop__row--accent .stats-pop__value {
  color: var(--accent-text);
}
.stats-pop__sep {
  height: var(--hair-w);
  margin: 4px 6px;
  background: var(--hairline);
}
.stats-pop__extras {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  font-size: 12px;
}
.stats-pop__extras:not(:empty) {
  padding: 6px 6px 4px;
  margin-top: 4px;
  border-top: var(--bd-hair);
}
.stats-pop__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-full);
  background: var(--accent-soft);
  color: var(--accent-text);
  font: inherit;
  font-weight: 600;
  cursor: default;
}
.stats-pop__chip:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
</style>
