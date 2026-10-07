<script setup lang="ts">
/**
 * v2.5 — Word goals + writing stats pill (Ulysses-inspired).
 *
 * Mounts inside <StatusBar>. Reads YAML front-matter (`goal:`, `goal_unit:`,
 * `goal_set_at:`) from the active tab and renders:
 *
 *   - a slim progress pill: "247 / 1500 words · 16%"
 *   - a tinted background bar = current/goal width
 *   - a green pulse + checkmark on the first hit of 100%
 *   - a popover (click to toggle) showing session delta + streak + reset btn
 *
 * Inert when no `goal:` key is present in the active doc, so non-writers
 * never see it.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore } from '../stores/settings';
import { useWritingSessionStore, computeStreakDays } from '../stores/writingSession';
import { useWritingGoals } from '../composables/useWritingGoals';
import { useI18n } from '../i18n';
import Icons from './Icons.vue';
import '../styles/panels.css';

const { t } = useI18n();
const tabs = useTabsStore();
const settings = useSettingsStore();
const session = useWritingSessionStore();
const wg = useWritingGoals();

// Identify the active doc by file path when available; fall back to tab id
// (untitled drafts). This is the key the session store uses.
const activePathKey = computed(() => wg.activeTabPath.value);

const popoverOpen = ref(false);
const justCompleted = ref(false);
let prevReached = wg.reachedGoal.value;
let pulseTimer: ReturnType<typeof setTimeout> | null = null;
let rolloverTimer: ReturnType<typeof setInterval> | null = null;
let observedTabId = '';

// Observation: every time the active doc's count changes, push it to the
// session store so deltas stay live. Skip when there's no goal.
watch(
  () => [wg.current.value, activePathKey.value, wg.goal.value?.goal ?? 0] as const,
  ([count, path, goalAmt]) => {
    if (!path || !goalAmt) return;
    session.observe(path, count);
  },
  { immediate: true },
);

// Fire pulse animation on the 0→1 reached-goal transition. Don't repeat
// while the doc keeps growing past 100 %.
watch(
  () => wg.reachedGoal.value,
  (val) => {
    if (val && !prevReached) {
      justCompleted.value = true;
      if (pulseTimer) clearTimeout(pulseTimer);
      // 1.6 s matches the CSS keyframes duration.
      pulseTimer = setTimeout(() => {
        justCompleted.value = false;
      }, 1600);
    }
    prevReached = val;
  },
);

// Reset session when the active tab id changes (covers tab switch + close+
// reopen). We also clean up the leftover entry for the old path so a
// reopened doc starts fresh — same key, fresh anchor.
watch(
  () => tabs.activeId,
  (newId) => {
    if (observedTabId && observedTabId !== newId) {
      // Don't actually purge — we want the running daily-total to keep its
      // contribution. Tab switches are not closes. The tab close hook
      // (in App.vue / tabs store) is the right place to call closePath();
      // this watch only updates the observed-id pointer.
    }
    observedTabId = newId;
  },
);

// Day-rollover poll. Once every 30 s is plenty — the test wants
// per-document accuracy, not millisecond timing.
onMounted(() => {
  rolloverTimer = setInterval(() => {
    session.rolloverIfNewDay();
  }, 30_000);
});
onBeforeUnmount(() => {
  if (pulseTimer) clearTimeout(pulseTimer);
  if (rolloverTimer) clearInterval(rolloverTimer);
});

// Format helpers ------------------------------------------------------------

const unitLabel = computed(() => {
  if (!wg.goal.value) return '';
  switch (wg.goal.value.unit) {
    case 'cjk':
      return t('writingStats.unitCjk');
    case 'chars':
      return t('writingStats.unitChars');
    case 'words':
    default:
      return t('writingStats.unitWords');
  }
});

const percentText = computed(() => {
  if (!wg.goal.value) return '';
  const p = Math.floor(wg.progress.value * 100);
  return `${p}%`;
});

const pillText = computed(() => {
  if (!wg.goal.value) return '';
  return `${wg.current.value} / ${wg.goal.value.goal} ${unitLabel.value} · ${percentText.value}`;
});

const sessionEntry = computed(() => session.sessionForPath(activePathKey.value));

const sessionDelta = computed(() => {
  const e = sessionEntry.value;
  if (!e) return 0;
  return Math.max(0, wg.current.value - e.openCount);
});

const sinceSavedDelta = computed(() => {
  if (!wg.goal.value) return 0;
  return Math.max(0, wg.current.value - wg.savedCount.value);
});

const deltaSource = computed<'open' | 'save'>(() => {
  // If we have a `lastSavedAt`, the "since save" is the more recent anchor.
  return sessionEntry.value?.lastSavedAt ? 'save' : 'open';
});

const streakDays = computed(() =>
  computeStreakDays(wg.goal.value?.setAt ?? null),
);

const showWorkspaceTotal = computed(
  () => settings.showWorkspaceDailyTotal && session.todayDocCount > 0,
);

function togglePopover() {
  popoverOpen.value = !popoverOpen.value;
}

function closePopover() {
  popoverOpen.value = false;
}

function onResetSession() {
  if (!activePathKey.value) return;
  session.resetSession(activePathKey.value, wg.current.value);
  closePopover();
}

// Click-outside dismissal.
const root = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent) {
  if (!popoverOpen.value) return;
  const el = root.value;
  if (el && e.target instanceof Node && !el.contains(e.target)) {
    closePopover();
  }
}
onMounted(() => document.addEventListener('mousedown', onDocClick, true));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick, true));
</script>

<template>
  <div
    v-if="settings.showWritingStats && wg.goal.value"
    ref="root"
    class="writing-goals"
  >
    <button
      class="writing-goals__pill"
      :class="{
        'writing-goals__pill--complete': wg.reachedGoal.value,
        'writing-goals__pill--pulse': justCompleted,
      }"
      :title="t('writingStats.pillTooltip')"
      :style="{ '--wg-progress': `${Math.round(wg.progress.value * 100)}%` }"
      @click="togglePopover"
    >
      <span class="writing-goals__bar"></span>
      <span class="writing-goals__label">
        {{ pillText }}
        <Icons v-if="wg.reachedGoal.value" class="writing-goals__check" name="check-circle" :size="12" />
      </span>
    </button>

    <div v-if="popoverOpen" class="writing-goals__popover" role="dialog">
      <header class="writing-goals__popover-header">
        {{ t('writingStats.popoverTitle') }}
      </header>

      <div class="writing-goals__row">
        <span class="writing-goals__row-label">
          {{
            deltaSource === 'save'
              ? t('writingStats.deltaSinceSave')
              : t('writingStats.deltaSinceOpen')
          }}
        </span>
        <span class="writing-goals__row-value">
          +{{ deltaSource === 'save' ? sinceSavedDelta : sessionDelta }}
          {{ unitLabel }}
        </span>
      </div>

      <div class="writing-goals__row">
        <span class="writing-goals__row-label">{{ t('writingStats.streak') }}</span>
        <span class="writing-goals__row-value">
          {{ t('writingStats.streakValue', { n: String(streakDays) }) }}
        </span>
      </div>

      <div v-if="showWorkspaceTotal" class="writing-goals__row">
        <span class="writing-goals__row-label">{{ t('writingStats.todayWorkspace') }}</span>
        <span class="writing-goals__row-value">
          {{
            t('writingStats.todayWorkspaceValue', {
              n: session.todayTotal.toLocaleString(),
              docs: String(session.todayDocCount),
            })
          }}
        </span>
      </div>

      <button
        type="button"
        class="rp-btn rp-btn--sm writing-goals__reset"
        @click="onResetSession"
      >
        {{ t('writingStats.resetSession') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.writing-goals {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.writing-goals__pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 10px;
  border-radius: var(--r-full);
  border: 0;
  background: var(--fill-1);
  color: var(--text-2);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  overflow: hidden;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.writing-goals__pill:hover {
  background: var(--fill-2);
  color: var(--text);
}
.writing-goals__pill:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

/* Progress fill sits behind the label; width from --wg-progress. */
.writing-goals__bar {
  position: absolute;
  inset: 0;
  width: var(--wg-progress, 0%);
  background: var(--accent-soft);
  pointer-events: none;
  transition: width var(--dur) var(--ease-out);
}

.writing-goals__label {
  position: relative;
  z-index: 1;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.writing-goals__check {
  color: var(--success);
}

.writing-goals__pill--complete {
  color: var(--text);
}
.writing-goals__pill--complete .writing-goals__bar {
  background: color-mix(in srgb, var(--success) 16%, transparent);
}

@keyframes wg-pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--success) 50%, transparent);
    transform: scale(1);
  }
  35% {
    box-shadow: 0 0 0 8px color-mix(in srgb, var(--success) 0%, transparent);
    transform: scale(1.04);
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
    transform: scale(1);
  }
}

.writing-goals__pill--pulse {
  animation: wg-pulse 1.6s var(--ease-out) 1;
}
@media (prefers-reduced-motion: reduce) {
  .writing-goals__pill--pulse {
    animation: none;
  }
}

/* ---------- Popover (spec §6 menu style) ---------- */

.writing-goals__popover {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 248px;
  padding: 10px 12px 12px;
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  z-index: var(--z-pop);
  font-size: 13px;
  color: var(--text);
  transform-origin: bottom right;
  animation: wg-pop-in var(--dur-fast) var(--ease-out);
}
@keyframes wg-pop-in {
  from {
    opacity: 0;
    transform: scale(0.98);
  }
}

.writing-goals__popover-header {
  margin-bottom: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-3);
}

.writing-goals__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  min-height: 28px;
}

.writing-goals__row-label {
  color: var(--text-2);
}
.writing-goals__row-value {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.writing-goals__reset {
  margin-top: 8px;
  width: 100%;
}
</style>
