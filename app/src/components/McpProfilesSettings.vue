<script setup lang="ts">
/**
 * v4.0 P4 federation — MCP profiles UI.
 *
 * Mounted inside `IntegrationsSettings.vue` directly under the
 * single-workspace MCP card. Lets the user define named bundles of
 * `(alias, workspace path)` entries and copy a ready-to-paste Claude
 * Desktop config for each one.
 *
 * Design notes:
 *
 *   * The list of profiles is the source of truth; each card holds a
 *     local *draft* you only commit on Save (avoids mid-edit churn
 *     hitting the disk and avoids accidental partial saves).
 *
 *   * The first entry in each profile is the *default* workspace at the
 *     MCP server level — we surface that with a "default" pill on the
 *     first row, plus disabled "move up" on row 0 / disabled "move down"
 *     on the last row.
 *
 *   * "Use currently open folder" prefills with the active workspace so
 *     the common case (this single open vault as alias #1) is one click.
 */

import { ref, computed, onMounted, reactive } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useToastsStore } from '../stores/toasts';
import { useWorkspaceStore } from '../stores/workspace';
import {
  useMcpProfilesStore,
  type McpProfile,
  type McpWorkspaceEntry,
} from '../stores/mcpProfiles';
import { useI18n } from '../i18n';

const { t } = useI18n();
const toasts = useToastsStore();
const workspace = useWorkspaceStore();
const store = useMcpProfilesStore();

interface McpPath {
  path: string | null;
  bundled: boolean;
}
const mcpPath = ref<McpPath>({ path: null, bundled: false });

/** A profile being edited; mirrors `McpProfile` but mutable. */
interface DraftProfile {
  /** The pristine name we use to identify the row in the store (so
   *  renames upsert correctly). Empty for never-saved profiles. */
  originalName: string;
  name: string;
  entries: McpWorkspaceEntry[];
  allow_write: boolean;
  /** True if this row is in edit mode (showing inputs vs. summary). */
  editing: boolean;
}

const drafts = reactive<DraftProfile[]>([]);

function profileToDraft(p: McpProfile): DraftProfile {
  return {
    originalName: p.name,
    name: p.name,
    entries: p.entries.map((e) => ({ ...e })),
    allow_write: !!p.allow_write,
    editing: false,
  };
}

function syncDraftsFromStore() {
  // Replace items in place so any "editing" state on rows the user is
  // currently editing gets dropped (after a save we'd rather collapse
  // back to the read-only summary).
  drafts.splice(0, drafts.length, ...store.profiles.map(profileToDraft));
}

onMounted(async () => {
  try {
    mcpPath.value = await invoke<McpPath>('mcp_path');
  } catch {
    mcpPath.value = { path: null, bundled: false };
  }
  await store.refresh();
  syncDraftsFromStore();
});

// ---------------------------------------------------------------------------
// Mutations on a draft.
// ---------------------------------------------------------------------------

function addDraftEntry(d: DraftProfile) {
  d.entries.push({ alias: '', path: '' });
}
function removeDraftEntry(d: DraftProfile, idx: number) {
  d.entries.splice(idx, 1);
}
function moveDraftEntry(d: DraftProfile, idx: number, delta: number) {
  const j = idx + delta;
  if (j < 0 || j >= d.entries.length) return;
  const tmp = d.entries[idx];
  d.entries[idx] = d.entries[j];
  d.entries[j] = tmp;
}

async function pickPathForEntry(d: DraftProfile, idx: number) {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    defaultPath: d.entries[idx].path || workspace.currentFolder || undefined,
  });
  if (typeof selected === 'string' && selected) {
    d.entries[idx].path = selected;
    if (!d.entries[idx].alias) {
      // Default alias to the basename, mirroring the server-side rule.
      const seg = selected.split(/[\\/]/).filter(Boolean).pop();
      if (seg) d.entries[idx].alias = sanitizeAlias(seg);
    }
  }
}

function fillCurrentWorkspace(d: DraftProfile, idx: number) {
  const folder = workspace.currentFolder;
  if (!folder) return;
  d.entries[idx].path = folder;
  if (!d.entries[idx].alias) {
    const seg = folder.split(/[\\/]/).filter(Boolean).pop();
    if (seg) d.entries[idx].alias = sanitizeAlias(seg);
  }
}

/** Strip characters the Rust-side validator would reject. */
function sanitizeAlias(s: string): string {
  return s.replace(/[^A-Za-z0-9_\-]/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Profile-level actions.
// ---------------------------------------------------------------------------

function newProfile() {
  // Pick a unique default name in case the user spams "New profile".
  let base = t('integrations.profilesNewProfileDefault');
  let candidate = base;
  let i = 2;
  while (drafts.some((d) => d.name === candidate)) {
    candidate = `${base} ${i++}`;
  }
  drafts.push({
    originalName: '',
    name: candidate,
    entries: workspace.currentFolder
      ? [
          {
            alias: sanitizeAlias(
              workspace.currentFolder.split(/[\\/]/).filter(Boolean).pop() ||
                'workspace',
            ),
            path: workspace.currentFolder,
          },
        ]
      : [{ alias: '', path: '' }],
    allow_write: false,
    editing: true,
  });
}

function duplicateProfile(d: DraftProfile) {
  const baseName = `${d.name} copy`;
  let candidate = baseName;
  let i = 2;
  while (drafts.some((x) => x.name === candidate)) {
    candidate = `${baseName} ${i++}`;
  }
  drafts.push({
    originalName: '',
    name: candidate,
    entries: d.entries.map((e) => ({ ...e })),
    allow_write: d.allow_write,
    editing: true,
  });
}

async function deleteProfile(d: DraftProfile) {
  if (!confirm(t('integrations.profilesDeleteConfirm', { name: d.name }))) return;
  // Newly-added drafts that were never saved aren't in the store; just
  // drop them locally.
  if (!d.originalName) {
    drafts.splice(drafts.indexOf(d), 1);
    return;
  }
  try {
    await store.remove(d.originalName);
    syncDraftsFromStore();
  } catch (e) {
    toasts.error(String((e as Error)?.message ?? e));
  }
}

async function saveDraft(d: DraftProfile) {
  // Build the canonical profile body. The Rust validator enforces all
  // the hard rules — we just hand it a clean object and surface the
  // error to the user verbatim.
  const profile: McpProfile = {
    name: d.name.trim(),
    entries: d.entries.map((e) => ({
      alias: e.alias.trim(),
      path: e.path.trim(),
    })),
    allow_write: d.allow_write,
  };
  try {
    // Save the new profile FIRST. If validation fails inside the Rust
    // store, the old profile stays intact — earlier code removed the old
    // name first, so a validation failure on the new one wiped both.
    // (No `mcp_profile_rename` command exists on the Rust side, so we
    // simulate atomic-ish rename = save-new-then-remove-old.)
    await store.save(profile);
    if (d.originalName && d.originalName !== profile.name) {
      try {
        await store.remove(d.originalName);
      } catch {
        // The save succeeded so the user's data is safe. A leftover old
        // entry is annoying but recoverable; surface no error here.
      }
    }
    d.originalName = profile.name;
    d.editing = false;
    toasts.success(t('integrations.profilesSaved'));
    syncDraftsFromStore();
  } catch (e) {
    toasts.error(
      t('integrations.profilesValidationFailed', {
        msg: String((e as Error)?.message ?? e),
      }),
    );
  }
}

async function copyConfigFor(d: DraftProfile) {
  if (!d.originalName) {
    // Have to save first so the store has the row.
    await saveDraft(d);
    if (!d.originalName) return; // save failed
  }
  try {
    const snippet = await store.exportConfig(d.originalName, mcpPath.value.path);
    await writeText(snippet);
    if (!mcpPath.value.bundled) {
      toasts.info(t('integrations.profilesNoMcpBinary'));
    } else {
      toasts.success(t('integrations.profilesCopiedToast'));
    }
  } catch (e) {
    toasts.error(String((e as Error)?.message ?? e));
  }
}

const isEmpty = computed(() => drafts.length === 0);
</script>

<template>
  <section class="mcpp" data-testid="mcp-profiles">
    <div class="mcpp__heading-row">
      <h4 class="mcpp__heading">{{ t('integrations.profilesHeading') }}</h4>
      <button class="ic-btn" @click="newProfile">
        + {{ t('integrations.profilesCreate') }}
      </button>
    </div>
    <p class="mcpp__intro">{{ t('integrations.profilesIntro') }}</p>

    <p v-if="isEmpty" class="mcpp__empty">
      {{ t('integrations.profilesEmpty') }}
    </p>

    <div
      v-for="d in drafts"
      :key="d.originalName || `unsaved-${d.name}`"
      class="mcpp__card"
    >
      <!-- Card header: profile name + per-card actions -->
      <div class="mcpp__row">
        <label class="mcpp__label">
          <span>{{ t('integrations.profilesNameLabel') }}</span>
          <input
            v-model="d.name"
            type="text"
            class="mcpp__input"
            :placeholder="t('integrations.profilesNamePlaceholder')"
          />
        </label>
        <div class="mcpp__card-actions">
          <button class="ic-btn" @click="duplicateProfile(d)">
            {{ t('integrations.profilesDuplicate') }}
          </button>
          <button class="ic-btn ic-btn--danger" @click="deleteProfile(d)">
            {{ t('integrations.profilesDelete') }}
          </button>
        </div>
      </div>

      <!-- Entries list -->
      <div class="mcpp__entries-heading">
        {{ t('integrations.profilesEntriesHeading') }}
      </div>
      <div
        v-for="(entry, idx) in d.entries"
        :key="idx"
        class="mcpp__entry"
      >
        <span v-if="idx === 0" class="mcpp__pill">default</span>
        <input
          v-model="entry.alias"
          type="text"
          class="mcpp__input mcpp__input--alias"
          :placeholder="t('integrations.profilesAliasPlaceholder')"
          :aria-label="t('integrations.profilesAliasLabel')"
        />
        <input
          v-model="entry.path"
          type="text"
          class="mcpp__input mcpp__input--path"
          :placeholder="t('integrations.profilesPathPlaceholder')"
          :aria-label="t('integrations.profilesPathLabel')"
        />
        <button
          class="ic-btn mcpp__icon-btn"
          @click="pickPathForEntry(d, idx)"
          :title="t('integrations.profilesPickPath')"
        >
          {{ t('integrations.profilesPickPath') }}
        </button>
        <button
          class="ic-btn mcpp__icon-btn"
          :disabled="!workspace.currentFolder"
          @click="fillCurrentWorkspace(d, idx)"
          :title="t('integrations.profilesUseCurrentWorkspace')"
        >
          {{ t('integrations.profilesUseCurrentWorkspace') }}
        </button>
        <button
          class="ic-btn mcpp__icon-btn"
          :disabled="idx === 0"
          @click="moveDraftEntry(d, idx, -1)"
          :title="t('integrations.profilesMoveUp')"
        >
          ↑
        </button>
        <button
          class="ic-btn mcpp__icon-btn"
          :disabled="idx === d.entries.length - 1"
          @click="moveDraftEntry(d, idx, 1)"
          :title="t('integrations.profilesMoveDown')"
        >
          ↓
        </button>
        <button
          class="ic-btn ic-btn--danger mcpp__icon-btn"
          :disabled="d.entries.length <= 1"
          @click="removeDraftEntry(d, idx)"
        >
          {{ t('integrations.profilesRemoveEntry') }}
        </button>
      </div>

      <div class="mcpp__row">
        <button class="ic-btn" @click="addDraftEntry(d)">
          + {{ t('integrations.profilesAddEntry') }}
        </button>
        <label class="mcpp__checkbox">
          <input v-model="d.allow_write" type="checkbox" />
          <span>{{ t('integrations.profilesAllowWrite') }}</span>
        </label>
      </div>
      <p class="mcpp__hint">{{ t('integrations.profilesAllowWriteHint') }}</p>

      <div class="mcpp__row mcpp__row--actions">
        <button class="ic-btn ic-btn--primary" @click="saveDraft(d)">
          {{ t('integrations.profilesSave') }}
        </button>
        <button class="ic-btn" @click="copyConfigFor(d)">
          {{ t('integrations.profilesCopyConfigBtn') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.mcpp {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.mcpp__heading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.mcpp__heading {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}
.mcpp__intro {
  font-size: 11px;
  color: var(--text-faint);
  margin: 0;
  line-height: 1.5;
}
.mcpp__empty {
  font-size: 11px;
  color: var(--text-faint);
  font-style: italic;
  margin: 4px 0;
}
.mcpp__card {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg);
}
.mcpp__row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mcpp__row--actions {
  margin-top: 4px;
}
.mcpp__label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
  flex: 1;
  min-width: 0;
}
.mcpp__input {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  padding: 4px 6px;
  font-size: 11px;
  border-radius: 4px;
  font: inherit;
  flex: 1;
  min-width: 0;
}
.mcpp__input--alias {
  flex: 0 1 120px;
}
.mcpp__input--path {
  flex: 1 1 200px;
}
.mcpp__card-actions {
  display: flex;
  gap: 4px;
}
.mcpp__entries-heading {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
  margin-top: 4px;
}
.mcpp__entry {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.mcpp__pill {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: var(--accent, #4ade80);
  color: white;
  padding: 1px 6px;
  border-radius: 999px;
}
.mcpp__icon-btn {
  padding: 3px 6px;
  font-size: 10px;
}
.mcpp__checkbox {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-muted);
}
.mcpp__hint {
  font-size: 10px;
  color: var(--text-faint);
  margin: 0;
  line-height: 1.4;
}
.ic-btn--primary {
  background: var(--accent, #4ade80);
  color: white;
  border-color: var(--accent, #4ade80);
}
.ic-btn--danger {
  color: var(--danger, #ef4444);
}
</style>
