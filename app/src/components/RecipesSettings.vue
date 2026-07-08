<script setup lang="ts">
/**
 * RecipesSettings — v4.0 Pillar 2 panel under Settings → Integrations.
 *
 * Three sections, top to bottom:
 *   1. Pending review — runs that finished `ok` but await Accept/Reject.
 *   2. Recipes — the declarative jobs in `.solomd/agents/*.yml`.
 *   3. History — newest-first list of every run, click to drill into the
 *      raw `trace.jsonl` + `run.md` (Pillar 3 will replace this with the
 *      pretty step view; for v4.0 we ship the JSON-per-line raw form).
 *
 * Plus a "New recipe" wizard that writes a starter yml + opens it for
 * the user to edit, and a YAML editor modal for in-place edits.
 */

import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useRecipesStore, type RecipeSummary, type RunMeta } from '../stores/recipes';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';
import TraceView from './TraceView.vue';

const { t } = useI18n();
const store = useRecipesStore();
const workspace = useWorkspaceStore();
const toasts = useToastsStore();
const { openPath } = useFiles();

const folder = computed(() => workspace.currentFolder);

// ---------------------------------------------------------------------------
// Lifecycle — refresh on mount + when the folder changes, subscribe to
// the run-finished event so the pending list updates without polling.
// ---------------------------------------------------------------------------

watch(folder, async (f) => {
  await store.refresh(f);
}, { immediate: true });

// Map slug -> run_id so we can clear the "running" lock when the matching
// `solomd://recipes-run-finished` event arrives. Without this the button
// only stayed disabled during the (very brief) `recipes_run_now` invoke,
// so a user could mash it and queue the same recipe many times in a row.
const slugByRunId = ref<Map<string, string>>(new Map());
let unlistenRunFinished: UnlistenFn | null = null;

onMounted(async () => {
  await store.subscribe(() => folder.value);
  unlistenRunFinished = await listen<RunMeta>(
    'solomd://recipes-run-finished',
    (e) => {
      const slug = slugByRunId.value.get(e.payload.run_id);
      if (slug) {
        runningSlugs.value.delete(slug);
        runningSlugs.value = new Set(runningSlugs.value);
        slugByRunId.value.delete(e.payload.run_id);
      }
    },
  );
});

onBeforeUnmount(() => {
  void store.unsubscribe();
  if (unlistenRunFinished) {
    unlistenRunFinished();
    unlistenRunFinished = null;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function triggerLabel(t_: string): string {
  switch (t_) {
    case 'schedule': return t('recipes.triggerSchedule');
    case 'on-save': return t('recipes.triggerOnSave');
    case 'on-commit': return t('recipes.triggerOnCommit');
    case 'on-tag-add': return t('recipes.triggerOnTagAdd');
    case 'manual': return t('recipes.triggerManual');
    default: return t_;
  }
}

function statusLabel(s: string | null): string {
  switch (s) {
    case 'ok': return t('recipes.runStatusOk');
    case 'accepted': return t('recipes.runStatusAccepted');
    case 'rejected': return t('recipes.runStatusRejected');
    case 'error': return t('recipes.runStatusError');
    case 'running': return t('recipes.runStatusRunning');
    case 'cancelled': return t('recipes.runStatusCancelled');
    default: return s ?? '—';
  }
}

function statusColor(s: string | null): string {
  switch (s) {
    case 'ok': return 'var(--accent)';
    case 'accepted': return '#16a34a';
    case 'rejected': return 'var(--text-faint)';
    case 'error': return '#dc2626';
    case 'running': return '#0ea5e9';
    default: return 'var(--text-faint)';
  }
}

function fmtDate(unixSec: number | null): string {
  if (!unixSec) return '—';
  const d = new Date(unixSec * 1000);
  return d.toLocaleString();
}

// ---------------------------------------------------------------------------
// Recipe row actions
// ---------------------------------------------------------------------------

const runningSlugs = ref<Set<string>>(new Set());

async function runNow(r: RecipeSummary) {
  if (!folder.value) return;
  if (runningSlugs.value.has(r.slug)) return;
  runningSlugs.value.add(r.slug);
  // Force template reactivity for the `Set` (Vue tracks identity, not contents).
  runningSlugs.value = new Set(runningSlugs.value);
  const id = await store.runNow(folder.value, r.slug);
  if (id) {
    // Keep the lock until the matching run-finished event clears it.
    slugByRunId.value.set(id, r.slug);
    toasts.success(t('recipes.toastRunQueued'));
  } else {
    // The invoke itself failed — release the lock immediately, no event coming.
    runningSlugs.value.delete(r.slug);
    runningSlugs.value = new Set(runningSlugs.value);
    if (store.lastError) toasts.error(store.lastError);
  }
}

async function deleteRecipe(r: RecipeSummary) {
  if (!folder.value) return;
  if (!window.confirm(t('recipes.confirmDelete', { name: r.name }))) return;
  await store.delete(folder.value, r.slug);
  toasts.success(t('recipes.toastDeleted'));
}

function openInTab(r: RecipeSummary) {
  if (r.path) {
    void openPath(r.path);
  }
}

// ---------------------------------------------------------------------------
// Pending-run panel
// ---------------------------------------------------------------------------

const expandedDiff = ref<string | null>(null); // run_id whose diff is shown
const diffByRun = ref<Record<string, string>>({});

async function toggleDiff(run: RunMeta) {
  if (expandedDiff.value === run.run_id) {
    expandedDiff.value = null;
    return;
  }
  expandedDiff.value = run.run_id;
  if (!diffByRun.value[run.run_id] && folder.value) {
    const d = await store.readDiff(folder.value, run.run_id);
    diffByRun.value[run.run_id] = d ?? t('recipes.diffEmpty');
  }
}

async function acceptRun(run: RunMeta) {
  if (!folder.value) return;
  const ok = await store.accept(folder.value, run.run_id);
  if (ok) toasts.success(t('recipes.toastAccepted'));
  else if (store.lastError) toasts.error(store.lastError);
}

async function rejectRun(run: RunMeta) {
  if (!folder.value) return;
  if (!window.confirm(t('recipes.confirmReject'))) return;
  const ok = await store.reject(folder.value, run.run_id);
  if (ok) toasts.success(t('recipes.toastRejected'));
  else if (store.lastError) toasts.error(store.lastError);
}

// ---------------------------------------------------------------------------
// History panel
// ---------------------------------------------------------------------------

const expandedHistory = ref<string | null>(null);
const runMdByRun = ref<Record<string, string>>({});

async function toggleHistory(run: RunMeta) {
  if (expandedHistory.value === run.run_id) {
    expandedHistory.value = null;
    return;
  }
  expandedHistory.value = run.run_id;
  if (!folder.value) return;
  if (!runMdByRun.value[run.run_id]) {
    const md = await store.readRunMd(folder.value, run.run_id);
    runMdByRun.value[run.run_id] = md ?? '';
  }
}

async function onReplayFromStep(runId: string, payload: { seq: number; runId: string }) {
  if (!folder.value) return;
  try {
    const newRunId = await invoke<string>('agent_trace_replay_from', {
      workspace: folder.value,
      runId: payload.runId ?? runId,
      seq: payload.seq,
    });
    toasts.success(t('recipes.replayStartedToast', { run: newRunId }));
    await store.refresh(folder.value);
    expandedHistory.value = newRunId;
  } catch (err) {
    toasts.error(String(err));
  }
}

// ---------------------------------------------------------------------------
// New-recipe wizard — minimal form. Saves a starter yml + opens it as a
// tab for the user to refine. We don't try to be a full GUI editor.
// ---------------------------------------------------------------------------

const showWizard = ref(false);
const wizName = ref('');
const wizTrigger = ref<'manual' | 'schedule' | 'on-save' | 'on-commit' | 'on-tag-add'>('manual');
const wizSchedule = ref('0 18 * * SUN');
const wizMatch = ref('daily/**/*.md');
const wizTag = ref('review-me');
const wizPrompt = ref('Read this week\'s daily/ notes.\nWrite weekly/{{date:YYYY-WW}}.md: themes / decisions / open threads.');
const wizAllowWrite = ref(false);
const wizWriteCap = ref(5);

const wizSlug = computed(() => {
  const slug = wizName.value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'recipe';
});

const wizYaml = computed(() => {
  const lines: string[] = [];
  lines.push(`name: ${wizName.value || 'New recipe'}`);
  lines.push(`trigger: ${wizTrigger.value}`);
  if (wizTrigger.value === 'schedule') lines.push(`schedule: "${wizSchedule.value}"`);
  if (['on-save', 'on-commit', 'on-tag-add'].includes(wizTrigger.value)) {
    lines.push(`match: "${wizMatch.value}"`);
  }
  if (wizTrigger.value === 'on-tag-add') lines.push(`tag: ${wizTag.value}`);
  lines.push('prompt: |');
  for (const l of wizPrompt.value.split('\n')) lines.push(`  ${l}`);
  lines.push(`allow-write: ${wizAllowWrite.value}`);
  lines.push(`write-cap: ${wizWriteCap.value}`);
  return lines.join('\n') + '\n';
});

function resetWizard() {
  wizName.value = '';
  wizTrigger.value = 'manual';
  wizSchedule.value = '0 18 * * SUN';
  wizMatch.value = 'daily/**/*.md';
  wizTag.value = 'review-me';
  wizPrompt.value = 'Read this week\'s daily/ notes.\nWrite weekly/{{date:YYYY-WW}}.md: themes / decisions / open threads.';
  wizAllowWrite.value = false;
  wizWriteCap.value = 5;
}

async function saveWizard() {
  if (!folder.value) return;
  const path = await store.save(folder.value, wizYaml.value, wizSlug.value);
  if (path) {
    toasts.success(t('recipes.toastSaved'));
    showWizard.value = false;
    resetWizard();
    // Open the file so the user can refine it.
    void openPath(path);
  } else if (store.lastError) {
    toasts.error(store.lastError);
  }
}

// ---------------------------------------------------------------------------
// YAML editor modal (Edit YAML button)
// ---------------------------------------------------------------------------

const editing = ref<RecipeSummary | null>(null);
const editingYaml = ref('');

async function openYamlEditor(r: RecipeSummary) {
  if (!folder.value) return;
  const yaml = await store.readYaml(folder.value, r.slug);
  if (yaml === null) {
    if (store.lastError) toasts.error(store.lastError);
    return;
  }
  editing.value = r;
  editingYaml.value = yaml;
}

async function saveYamlEdit() {
  if (!folder.value || !editing.value) return;
  const path = await store.save(folder.value, editingYaml.value, editing.value.slug);
  if (path) {
    toasts.success(t('recipes.toastSaved'));
    editing.value = null;
    editingYaml.value = '';
  } else if (store.lastError) {
    toasts.error(store.lastError);
  }
}

function cancelYamlEdit() {
  editing.value = null;
  editingYaml.value = '';
}

// ---------------------------------------------------------------------------
// Cookbook — bundled YAML templates the user can install with one click.
// `cookbook_list` returns parsed metadata for each entry; `cookbook_install`
// copies it into <workspace>/.solomd/agents/<slug>.yml (auto-suffixed on
// collision). After install we refresh the recipe list so the row appears.
// ---------------------------------------------------------------------------

interface CookbookEntry {
  file_stem: string;
  name: string;
  trigger: string;
  allow_write: boolean;
  provider: string;
  schedule: string | null;
  match_glob: string | null;
  description: string;
  yaml: string;
}
const showCookbook = ref(false);
const cookbookEntries = ref<CookbookEntry[]>([]);
const cookbookExpanded = ref<string | null>(null);
const installing = ref<string | null>(null);

async function openCookbook() {
  if (cookbookEntries.value.length === 0) {
    try {
      cookbookEntries.value = await invoke<CookbookEntry[]>('cookbook_list');
    } catch (e) {
      toasts.error(`Cookbook: ${e}`);
      return;
    }
  }
  showCookbook.value = true;
}

async function installCookbookEntry(entry: CookbookEntry) {
  if (!folder.value) {
    toasts.error(t('recipes.openWorkspace'));
    return;
  }
  installing.value = entry.file_stem;
  try {
    const path = await invoke<string>('cookbook_install', {
      workspace: folder.value,
      fileStem: entry.file_stem,
    });
    toasts.success(t('cookbook.installedToast', { name: entry.name }));
    await store.refresh(folder.value);
    showCookbook.value = false;
    void openPath(path);
  } catch (e) {
    toasts.error(`Cookbook install: ${e}`);
  } finally {
    installing.value = null;
  }
}
</script>

<template>
  <div class="recipes">
    <div class="recipes__header">
      <h3>{{ t('recipes.heading') }}</h3>
      <p class="recipes__intro">{{ t('recipes.intro') }}</p>
    </div>

    <div v-if="!folder" class="recipes__empty">
      {{ t('recipes.openWorkspace') }}
    </div>

    <template v-else>
      <!-- Pending runs -->
      <section class="recipes__section">
        <h4>{{ t('recipes.pendingHeading') }}</h4>
        <p class="recipes__hint">{{ t('recipes.pendingHint') }}</p>
        <div v-if="store.pendingRuns.length === 0" class="recipes__empty">
          {{ t('recipes.pendingEmpty') }}
        </div>
        <div v-else class="recipes__list">
          <div v-for="run in store.pendingRuns" :key="run.run_id" class="recipes__pending">
            <div class="recipes__pendingHeader">
              <div>
                <strong>{{ run.recipe?.name || run.run_id }}</strong>
                <span class="recipes__meta">
                  · {{ run.recipe?.trigger || '—' }}
                  · {{ fmtDate(run.started_at) }}
                </span>
              </div>
              <div class="recipes__actions">
                <button @click="toggleDiff(run)">{{ t('recipes.btnViewDiff') }}</button>
                <button class="recipes__btnPrimary" @click="acceptRun(run)">
                  {{ t('recipes.btnAccept') }}
                </button>
                <button @click="rejectRun(run)">{{ t('recipes.btnReject') }}</button>
              </div>
            </div>
            <pre v-if="expandedDiff === run.run_id" class="recipes__diff">{{ diffByRun[run.run_id] || t('recipes.diffEmpty') }}</pre>
          </div>
        </div>
      </section>

      <!-- Recipes list -->
      <section class="recipes__section">
        <div class="recipes__sectionHeader">
          <h4>{{ t('recipes.list') }}</h4>
          <div class="recipes__actions">
            <button @click="openCookbook">{{ t('cookbook.browse') }}</button>
            <button class="recipes__btnPrimary" @click="showWizard = true">
              {{ t('recipes.btnNew') }}
            </button>
          </div>
        </div>
        <div v-if="store.recipes.length === 0" class="recipes__empty">
          {{ t('recipes.listEmpty') }}
        </div>
        <table v-else class="recipes__table">
          <thead>
            <tr>
              <th>{{ t('recipes.fieldName') }}</th>
              <th>{{ t('recipes.fieldTrigger') }}</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in store.recipes" :key="r.slug">
              <td>
                <div>
                  <strong>{{ r.name }}</strong>
                  <span v-if="r.allow_write" class="recipes__badge">{{ t('recipes.badgeAllowWrite') }}</span>
                  <span class="recipes__badge">{{ t('recipes.badgeWriteCap', { n: r.write_cap }) }}</span>
                </div>
                <div class="recipes__metaSmall">
                  <span v-if="r.last_run_status" :style="{ color: statusColor(r.last_run_status) }">
                    {{ statusLabel(r.last_run_status) }}
                  </span>
                  <span v-else>—</span>
                </div>
              </td>
              <td>
                <div>{{ triggerLabel(r.trigger) }}</div>
                <div class="recipes__metaSmall">
                  <code v-if="r.schedule">{{ r.schedule }}</code>
                  <code v-else-if="r.match_glob">{{ r.match_glob }}</code>
                  <code v-else-if="r.tag">#{{ r.tag }}</code>
                </div>
              </td>
              <td class="recipes__metaSmall">
                <span v-if="r.provider || r.model">
                  {{ r.provider || '—' }}<span v-if="r.model"> · {{ r.model }}</span>
                </span>
              </td>
              <td>
                <div class="recipes__actions">
                  <button :disabled="runningSlugs.has(r.slug)" @click="runNow(r)">
                    {{ t('recipes.btnRunNow') }}
                  </button>
                  <button @click="openYamlEditor(r)">{{ t('recipes.btnEditYaml') }}</button>
                  <button @click="openInTab(r)">↗</button>
                  <button @click="deleteRecipe(r)">{{ t('recipes.btnDelete') }}</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- History -->
      <section class="recipes__section">
        <h4>{{ t('recipes.historyHeading') }}</h4>
        <div v-if="store.history.length === 0" class="recipes__empty">
          {{ t('recipes.historyEmpty') }}
        </div>
        <div v-else class="recipes__list">
          <div v-for="run in store.history" :key="run.run_id" class="recipes__historyItem">
            <div class="recipes__historyHeader" @click="toggleHistory(run)">
              <div>
                <strong>{{ run.recipe?.name || run.kind }}</strong>
                <span class="recipes__meta">· {{ fmtDate(run.started_at) }}</span>
              </div>
              <span :style="{ color: statusColor(run.status) }">
                {{ statusLabel(run.status) }}
              </span>
            </div>
            <div v-if="expandedHistory === run.run_id" class="recipes__historyBody">
              <h5>{{ t('recipes.traceHeading') }}</h5>
              <TraceView
                v-if="folder"
                :workspace="folder"
                :run-id="run.run_id"
                :live="run.status === 'running'"
                @replay="onReplayFromStep(run.run_id, $event)"
              />
              <details class="recipes__transcriptDetails">
                <summary>{{ t('recipes.transcriptHeading') }}</summary>
                <pre class="recipes__pre">{{ runMdByRun[run.run_id] || '' }}</pre>
              </details>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- Wizard modal -->
    <div v-if="showWizard" class="recipes__modalBackdrop" @click.self="showWizard = false">
      <div class="recipes__modal">
        <h4>{{ t('recipes.wizardHeading') }}</h4>
        <label>
          {{ t('recipes.fieldName') }}
          <input v-model="wizName" type="text" placeholder="Weekly review" />
        </label>
        <label>
          {{ t('recipes.fieldTrigger') }}
          <select v-model="wizTrigger">
            <option value="manual">{{ t('recipes.triggerManual') }}</option>
            <option value="schedule">{{ t('recipes.triggerSchedule') }}</option>
            <option value="on-save">{{ t('recipes.triggerOnSave') }}</option>
            <option value="on-commit">{{ t('recipes.triggerOnCommit') }}</option>
            <option value="on-tag-add">{{ t('recipes.triggerOnTagAdd') }}</option>
          </select>
        </label>
        <label v-if="wizTrigger === 'schedule'">
          {{ t('recipes.fieldSchedule') }}
          <input v-model="wizSchedule" type="text" placeholder="0 18 * * SUN" />
        </label>
        <label v-if="['on-save', 'on-commit', 'on-tag-add'].includes(wizTrigger)">
          {{ t('recipes.fieldMatch') }}
          <input v-model="wizMatch" type="text" placeholder="daily/**/*.md" />
        </label>
        <label v-if="wizTrigger === 'on-tag-add'">
          {{ t('recipes.fieldTag') }}
          <input v-model="wizTag" type="text" placeholder="review-me" />
        </label>
        <label>
          {{ t('recipes.fieldPrompt') }}
          <textarea v-model="wizPrompt" rows="6"></textarea>
        </label>
        <label class="recipes__inline">
          <input v-model="wizAllowWrite" type="checkbox" />
          {{ t('recipes.fieldAllowWrite') }}
        </label>
        <label class="recipes__inline">
          {{ t('recipes.fieldWriteCap') }}
          <input v-model.number="wizWriteCap" type="number" min="1" max="50" style="width: 80px;" />
        </label>
        <div class="recipes__metaSmall">
          {{ t('recipes.wizardSlugHint', { slug: wizSlug }) }}
        </div>
        <details>
          <summary>{{ t('recipes.wizardYamlHint') }}</summary>
          <pre class="recipes__pre">{{ wizYaml }}</pre>
        </details>
        <div class="recipes__actions">
          <button class="recipes__btnPrimary" @click="saveWizard">
            {{ t('recipes.wizardSavePrompt') }}
          </button>
          <button @click="showWizard = false; resetWizard()">
            {{ t('recipes.wizardCancel') }}
          </button>
        </div>
      </div>
    </div>

    <!-- YAML editor modal -->
    <div v-if="editing" class="recipes__modalBackdrop" @click.self="cancelYamlEdit">
      <div class="recipes__modal recipes__modalLarge">
        <h4>{{ t('recipes.yamlEditorHeading', { name: editing.name }) }}</h4>
        <textarea v-model="editingYaml" rows="20" class="recipes__yamlEditor"></textarea>
        <div class="recipes__actions">
          <button class="recipes__btnPrimary" @click="saveYamlEdit">
            {{ t('recipes.yamlSave') }}
          </button>
          <button @click="cancelYamlEdit">{{ t('recipes.yamlCancel') }}</button>
        </div>
      </div>
    </div>

    <!-- Cookbook modal -->
    <div
      v-if="showCookbook"
      class="recipes__modalBackdrop"
      @click.self="showCookbook = false"
    >
      <div class="recipes__modal recipes__modal--wide">
        <div class="recipes__modalHead">
          <h4>{{ t('cookbook.heading') }}</h4>
          <button @click="showCookbook = false">×</button>
        </div>
        <p class="recipes__hint">{{ t('cookbook.intro') }}</p>
        <div class="recipes__list">
          <div
            v-for="entry in cookbookEntries"
            :key="entry.file_stem"
            class="recipes__cookbookItem"
          >
            <div class="recipes__cookbookHead">
              <div>
                <strong>{{ entry.name }}</strong>
                <span class="recipes__badge">{{ triggerLabel(entry.trigger) }}</span>
                <span v-if="entry.allow_write" class="recipes__badge">
                  {{ t('recipes.badgeAllowWrite') }}
                </span>
                <span v-if="entry.provider" class="recipes__badge">
                  {{ entry.provider }}
                </span>
              </div>
              <div class="recipes__actions">
                <button
                  @click="cookbookExpanded = cookbookExpanded === entry.file_stem ? null : entry.file_stem"
                >
                  {{ cookbookExpanded === entry.file_stem ? t('cookbook.hidePreview') : t('cookbook.preview') }}
                </button>
                <button
                  class="recipes__btnPrimary"
                  :disabled="installing === entry.file_stem"
                  @click="installCookbookEntry(entry)"
                >
                  {{ installing === entry.file_stem ? t('cookbook.installing') : t('cookbook.install') }}
                </button>
              </div>
            </div>
            <p class="recipes__metaSmall">{{ entry.description }}</p>
            <pre
              v-if="cookbookExpanded === entry.file_stem"
              class="recipes__pre"
            >{{ entry.yaml }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.recipes {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.recipes__header h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 4px;
}
.recipes__intro {
  font-size: 12px;
  color: var(--text-faint);
  margin: 0;
  line-height: 1.5;
}
.recipes__section {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  background: var(--bg);
}
.recipes__sectionHeader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.recipes__section h4 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}
.recipes__hint {
  font-size: 11px;
  color: var(--text-faint);
  margin: 0 0 8px;
  line-height: 1.5;
}
.recipes__empty {
  font-size: 12px;
  color: var(--text-faint);
  padding: 8px 0;
}
.recipes__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.recipes__pending,
.recipes__historyItem {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
  background: var(--bg-alt, var(--bg));
}
.recipes__pendingHeader,
.recipes__historyHeader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.recipes__historyHeader {
  cursor: pointer;
}
.recipes__historyBody {
  margin-top: 8px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.recipes__historyBody h5 {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  margin: 8px 0 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.recipes__transcriptDetails {
  margin-top: 12px;
}
.recipes__transcriptDetails > summary {
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  user-select: none;
  margin-bottom: 4px;
}
.recipes__transcriptDetails > summary:hover {
  color: var(--text-muted);
}
.recipes__diff,
.recipes__pre {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.45;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
  overflow-x: auto;
  white-space: pre;
  max-height: 400px;
  margin-top: 8px;
}
.recipes__meta,
.recipes__metaSmall {
  font-size: 11px;
  color: var(--text-faint);
}
.recipes__metaSmall {
  margin-top: 2px;
}
.recipes__metaSmall code {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
}
.recipes__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.recipes__actions button {
  padding: 4px 8px;
  font-size: 11px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  cursor: pointer;
}
.recipes__actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.recipes__btnPrimary {
  background: var(--accent) !important;
  color: var(--accent-text, #fff) !important;
  border-color: var(--accent) !important;
}
.recipes__badge {
  display: inline-block;
  font-size: 10px;
  padding: 1px 6px;
  background: var(--border);
  border-radius: 3px;
  margin-left: 6px;
  color: var(--text-faint);
  font-weight: 400;
}
.recipes__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.recipes__table th {
  text-align: left;
  font-weight: 500;
  font-size: 11px;
  color: var(--text-faint);
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
}
.recipes__table td {
  padding: 6px;
  vertical-align: top;
  border-bottom: 1px solid var(--border);
}
.recipes__modalBackdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.recipes__modal {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  width: 480px;
  max-height: 90vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.recipes__modalLarge {
  width: 720px;
}
.recipes__modal--wide {
  width: 720px;
}
.recipes__modalHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.recipes__modalHead h4 {
  margin: 0;
}
.recipes__modalHead button {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: var(--text-muted);
}
.recipes__cookbookItem {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.recipes__cookbookHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.recipes__modal label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.recipes__modal input[type="text"],
.recipes__modal input[type="number"],
.recipes__modal select,
.recipes__modal textarea {
  padding: 6px 8px;
  font: inherit;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
}
.recipes__modal textarea {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  resize: vertical;
}
.recipes__inline {
  flex-direction: row !important;
  align-items: center;
  gap: 6px;
}
.recipes__yamlEditor {
  width: 100%;
  min-height: 360px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
</style>
