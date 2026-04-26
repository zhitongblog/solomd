<script setup lang="ts">
/**
 * v2.5 F6 — CJK Proofread panel.
 *
 * Modal-style overlay (à la GlobalSearch) that lists every flagged
 * issue in the active doc grouped by severity. Click a row to jump
 * the editor to the position; "Apply" replaces in place.
 *
 * Why a modal instead of a permanent right-side panel:
 *   - Right sidebar is already crowded (Outline / Backlinks / Tags /
 *     History) and adding a fifth panel makes the layout fight.
 *   - Proofread is a *task*, not an always-on view — modal opens via
 *     ⌘⇧J, user runs through fixes, dismisses.
 *   - Same component works on small / mobile screens with no extra
 *     responsive code.
 *
 * Apply semantics:
 *   - Issues carry **byte offsets** into the *snapshot* text we
 *     scanned. After any apply, those offsets shift, so we re-scan
 *     after every replacement and re-render. (For batch apply, we
 *     coalesce into one transaction by walking right-to-left so
 *     earlier offsets stay valid.)
 *   - We jump the editor via the existing `solomd:outline-goto`
 *     event (same plumbing Backlinks uses). Highlight isn't
 *     persistent — placing the cursor at the issue is enough cue.
 */

import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useTabsStore } from '../stores/tabs';
import { useToastsStore } from '../stores/toasts';
import { useTilesStore } from '../stores/tiles';
import { useI18n } from '../i18n';
import { track } from '../lib/telemetry';

interface Issue {
  line: number;
  col_start: number;
  col_end: number;
  severity: 'high' | 'medium' | 'low';
  category:
    | 'punct_halfwidth'
    | 'de_misuse'
    | 'latin_quotes'
    | 'cjk_latin_space'
    | 'repeat'
    | 'digit_unit_space';
  original: string;
  suggestion: string;
  explanation: string;
}

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const tabs = useTabsStore();
const toasts = useToastsStore();
const tiles = useTilesStore();
const { t, lang } = useI18n();

const issues = ref<Issue[]>([]);
const loading = ref(false);
const selectedIdx = ref(-1);

watch(
  () => props.open,
  async (v) => {
    if (v) {
      await nextTick();
      await rescan();
      track('cjk_proofread_opened');
    }
  },
);

// Re-scan when the active tab content changes (so the panel
// stays accurate after the user types or applies a fix).
watch(
  () => tabs.activeTab?.content,
  () => {
    if (props.open) rescan();
  },
);

async function rescan() {
  const tab = tabs.activeTab;
  if (!tab) {
    issues.value = [];
    return;
  }
  loading.value = true;
  try {
    const result = await invoke<Issue[]>('cjk_proofread', { text: tab.content ?? '' });
    issues.value = result;
    selectedIdx.value = -1;
  } catch (e) {
    console.error('cjk_proofread invoke failed', e);
    toasts.warning(`Proofread failed: ${e}`);
    issues.value = [];
  } finally {
    loading.value = false;
  }
}

const counts = computed(() => {
  let high = 0,
    medium = 0,
    low = 0;
  for (const i of issues.value) {
    if (i.severity === 'high') high++;
    else if (i.severity === 'medium') medium++;
    else low++;
  }
  return { high, medium, low };
});

const grouped = computed(() => {
  const high: Issue[] = [];
  const medium: Issue[] = [];
  const low: Issue[] = [];
  for (const i of issues.value) {
    if (i.severity === 'high') high.push(i);
    else if (i.severity === 'medium') medium.push(i);
    else low.push(i);
  }
  return { high, medium, low };
});

function categoryLabel(cat: Issue['category']): string {
  switch (cat) {
    case 'punct_halfwidth':
      return t('proofread.categoryPunct');
    case 'de_misuse':
      return t('proofread.categoryDe');
    case 'latin_quotes':
      return t('proofread.categoryQuotes');
    case 'repeat':
      return t('proofread.categoryRepeat');
    case 'cjk_latin_space':
      return t('proofread.categorySpace');
    case 'digit_unit_space':
      return t('proofread.categoryUnit');
  }
}

/** Build a tiny context window (5 chars on each side) using the
 * snapshot we scanned. Indices are byte offsets; we slice the doc
 * with substring math that respects UTF-8 by clamping to char
 * boundaries. */
function contextOf(issue: Issue): { before: string; hit: string; after: string } {
  const tab = tabs.activeTab;
  if (!tab) return { before: '', hit: '', after: '' };
  const text = tab.content ?? '';
  // Convert byte offsets to char offsets to slice safely without
  // splitting a multi-byte boundary. JavaScript indexes by code unit
  // (UTF-16) so we need a Uint8Array round-trip.
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const bytes = enc.encode(text);
  const safeStart = Math.max(0, issue.col_start);
  const safeEnd = Math.min(bytes.length, issue.col_end);
  const before = dec.decode(bytes.slice(Math.max(0, safeStart - 15), safeStart));
  const hit = dec.decode(bytes.slice(safeStart, safeEnd));
  const after = dec.decode(bytes.slice(safeEnd, Math.min(bytes.length, safeEnd + 15)));
  return { before: before.slice(-5), hit, after: after.slice(0, 5) };
}

function jumpTo(issue: Issue, idx: number) {
  selectedIdx.value = idx;
  // Reuse the outline-goto event (PaneContent listens for it). Pass
  // undefined paneId so the focused pane handles it.
  window.dispatchEvent(
    new CustomEvent('solomd:outline-goto', {
      detail: { line: issue.line, paneId: tiles.focusedPaneId },
    }),
  );
}

/** Apply ONE issue to the active tab content. */
function applyOne(issue: Issue) {
  const tab = tabs.activeTab;
  if (!tab) return;
  const text = tab.content ?? '';
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const bytes = enc.encode(text);
  if (issue.col_start > bytes.length || issue.col_end > bytes.length) {
    toasts.warning('Issue out of range — please rescan');
    return;
  }
  const before = dec.decode(bytes.slice(0, issue.col_start));
  const after = dec.decode(bytes.slice(issue.col_end));
  const next = before + issue.suggestion + after;
  tabs.setContent(tab.id, next);
  toasts.success(t('proofread.appliedToast', { n: 1 }));
  track('cjk_proofread_apply', { category: issue.category, severity: issue.severity });
  // The watcher on `tab.content` will trigger a rescan automatically.
}

/** Apply all issues at a given severity in one batch. We walk the
 * issues right-to-left (descending col_start) so each splice keeps
 * later offsets unchanged for earlier-in-doc issues. */
function applyAll(severity: 'high' | 'medium' | 'low' | 'all') {
  const tab = tabs.activeTab;
  if (!tab) return;
  const target = severity === 'all'
    ? [...issues.value]
    : issues.value.filter((i) => i.severity === severity);
  if (target.length === 0) {
    toasts.info(t('proofread.nothingToApply'));
    return;
  }
  // Sort descending so applying late edits doesn't shift early offsets.
  // ALSO: skip overlapping issues (e.g. cjk_latin_space across the
  // same boundary) — a simple greedy filter keeps the first (latest
  // by position) per overlap window. Chosen over a more elaborate
  // resolver because overlaps are rare in practice and the rescan
  // afterwards picks up anything we skipped.
  const sorted = target.slice().sort((a, b) => b.col_start - a.col_start);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let bytes = enc.encode(tab.content ?? '');
  let applied = 0;
  let lastStart = Infinity;
  for (const issue of sorted) {
    if (issue.col_end > lastStart) continue; // overlap — skip
    if (issue.col_start > bytes.length || issue.col_end > bytes.length) continue;
    const sugBytes = enc.encode(issue.suggestion);
    const merged = new Uint8Array(
      issue.col_start + sugBytes.length + (bytes.length - issue.col_end),
    );
    merged.set(bytes.slice(0, issue.col_start), 0);
    merged.set(sugBytes, issue.col_start);
    merged.set(bytes.slice(issue.col_end), issue.col_start + sugBytes.length);
    bytes = merged;
    applied++;
    lastStart = issue.col_start;
  }
  const next = dec.decode(bytes);
  if (next === tab.content) return;
  tabs.setContent(tab.id, next);
  toasts.success(t('proofread.appliedToast', { n: applied }));
  track('cjk_proofread_apply_all', { severity, count: applied });
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
});

// `lang` is referenced so the i18n re-renders when the user
// flips language while the panel is open.
void lang;
</script>

<template>
  <div v-if="open" class="proof__backdrop" @click.self="emit('close')">
    <div class="proof" role="dialog" aria-label="CJK Proofread">
      <header class="proof__head">
        <h2 class="proof__title">中 {{ t('proofread.heading') }}</h2>
        <div class="proof__counts">
          <span class="proof__pill proof__pill--high">
            {{ t('proofread.severityHigh') }} · {{ counts.high }}
          </span>
          <span class="proof__pill proof__pill--medium">
            {{ t('proofread.severityMedium') }} · {{ counts.medium }}
          </span>
          <span class="proof__pill proof__pill--low">
            {{ t('proofread.severityLow') }} · {{ counts.low }}
          </span>
        </div>
        <div class="proof__actions">
          <button class="btn btn--ghost" @click="rescan" :disabled="loading">
            {{ t('proofread.rescan') }}
          </button>
          <button
            class="btn btn--primary"
            :disabled="issues.length === 0"
            @click="applyAll('all')"
          >
            {{ t('proofread.applyAll') }}
          </button>
          <button class="btn btn--close" @click="emit('close')" aria-label="Close">×</button>
        </div>
      </header>

      <p class="proof__legend">{{ t('proofread.legend') }}</p>

      <div v-if="!tabs.activeTab" class="proof__empty">{{ t('proofread.noActive') }}</div>
      <div v-else-if="loading" class="proof__empty">…</div>
      <div v-else-if="issues.length === 0" class="proof__empty">
        {{ t('proofread.noIssues') }}
      </div>
      <div v-else class="proof__body">
        <section
          v-for="bucket in (['high', 'medium', 'low'] as const)"
          :key="bucket"
          v-show="grouped[bucket].length"
          class="proof__bucket"
          :class="`proof__bucket--${bucket}`"
        >
          <header class="proof__buckethead">
            <span class="proof__bucketlabel">
              {{ t(`proofread.severity${bucket.charAt(0).toUpperCase() + bucket.slice(1)}`) }}
              ({{ grouped[bucket].length }})
            </span>
            <button
              class="btn btn--small"
              @click="applyAll(bucket)"
              :title="t('proofread.applyAllSeverity', { severity: bucket })"
            >
              {{ t('proofread.applyAll') }}
            </button>
          </header>
          <ul class="proof__list">
            <li
              v-for="(issue, i) in grouped[bucket]"
              :key="`${issue.col_start}-${issue.col_end}-${i}`"
              class="proof__row"
              :class="{ 'proof__row--selected': selectedIdx === issues.indexOf(issue) }"
              @click="jumpTo(issue, issues.indexOf(issue))"
            >
              <span class="proof__lineno">{{ t('proofread.line', { n: issue.line }) }}</span>
              <span class="proof__category">{{ categoryLabel(issue.category) }}</span>
              <span class="proof__ctx">
                <span class="proof__ctx-side">{{ contextOf(issue).before }}</span><span
                  class="proof__ctx-hit"
                >{{ contextOf(issue).hit }}</span><span class="proof__ctx-side">{{ contextOf(issue).after }}</span>
              </span>
              <span class="proof__arrow">→</span>
              <span class="proof__suggestion">{{ issue.suggestion }}</span>
              <button
                class="btn btn--apply"
                @click.stop="applyOne(issue)"
                :title="issue.explanation"
              >
                {{ t('proofread.apply') }}
              </button>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.proof__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.42);
  z-index: 1000;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 8vh;
}
.proof {
  background: var(--bg);
  color: var(--text);
  width: min(820px, 92vw);
  max-height: 78vh;
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.proof__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft, var(--bg));
  flex-wrap: wrap;
}
.proof__title {
  font-size: 14px;
  font-weight: 700;
  margin: 0;
  letter-spacing: 0.02em;
}
.proof__counts {
  display: flex;
  gap: 6px;
  flex: 1;
}
.proof__pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.proof__pill--high {
  border-color: rgba(220, 70, 70, 0.4);
  color: #c0322c;
  background: rgba(220, 70, 70, 0.08);
}
.proof__pill--medium {
  border-color: rgba(214, 161, 0, 0.45);
  color: #946a00;
  background: rgba(214, 161, 0, 0.08);
}
.proof__pill--low {
  color: var(--text-faint);
}
.proof__actions {
  display: flex;
  gap: 6px;
}
.btn {
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
  transition: all 0.12s;
}
.btn:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--accent);
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.btn--primary {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}
.btn--primary:hover:not(:disabled) {
  filter: brightness(1.08);
  background: var(--accent);
  color: var(--bg);
}
.btn--ghost {
  background: transparent;
}
.btn--small {
  font-size: 11px;
  padding: 2px 8px;
}
.btn--close {
  font-size: 18px;
  line-height: 1;
  padding: 0 8px;
  background: transparent;
  border: none;
  color: var(--text-faint);
}
.btn--apply {
  font-size: 11px;
  padding: 2px 8px;
  margin-left: auto;
  flex-shrink: 0;
}

.proof__legend {
  margin: 0;
  padding: 6px 16px;
  font-size: 11px;
  color: var(--text-faint);
  border-bottom: 1px solid var(--border);
}

.proof__empty {
  padding: 36px;
  text-align: center;
  color: var(--text-faint);
  font-size: 13px;
}

.proof__body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px 14px;
}

.proof__bucket {
  margin-top: 10px;
}
.proof__buckethead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 4px;
  margin-bottom: 4px;
}
.proof__bucketlabel {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}
.proof__bucket--high .proof__bucketlabel { color: #c0322c; }
.proof__bucket--medium .proof__bucketlabel { color: #946a00; }

.proof__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.proof__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.12s, border-color 0.12s;
}
.proof__row:hover,
.proof__row--selected {
  background: var(--bg-hover);
  border-color: var(--border);
}
.proof__lineno {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  min-width: 56px;
}
.proof__category {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 7px;
  flex-shrink: 0;
}
.proof__ctx {
  font-family: var(--font-mono);
  white-space: pre;
  color: var(--text-muted);
  flex-shrink: 0;
}
.proof__ctx-hit {
  background: rgba(220, 70, 70, 0.18);
  color: var(--text);
  padding: 0 1px;
  border-radius: 2px;
}
.proof__bucket--medium .proof__ctx-hit {
  background: rgba(214, 161, 0, 0.22);
}
.proof__bucket--low .proof__ctx-hit {
  background: rgba(120, 120, 120, 0.18);
}
.proof__arrow {
  color: var(--text-faint);
  font-family: var(--font-mono);
  flex-shrink: 0;
}
.proof__suggestion {
  font-family: var(--font-mono);
  color: var(--accent);
  flex-shrink: 0;
}
</style>
