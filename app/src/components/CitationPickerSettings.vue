<!--
  F5 settings block — two file pickers for the workspace bibliography
  (`.bib` / `.csl-json`) and the CSL style file. Designed to be embedded
  inside SettingsPanel.vue alongside the existing `Custom CSS Theme`
  picker.

  The settings store is expected to expose:
    - workspaceBibliography: string  (default '')
    - workspaceCsl: string           (default '')
    - setWorkspaceBibliography(p: string): void
    - setWorkspaceCsl(p: string): void

  We read/write via type-cast so the component still type-checks before
  the parent has wired those fields in (see SUMMARY.md).
-->
<script setup lang="ts">
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import { usePandocExport } from '../composables/usePandocExport';

const { t } = useI18n();
const settings = useSettingsStore();
const toasts = useToastsStore();
const { invalidateCitationsCache } = usePandocExport();

// Cast: parent must add these fields. Keeping the cast local so we don't
// silence type checking elsewhere in the settings store.
interface CitationSettings {
  workspaceBibliography?: string;
  workspaceCsl?: string;
  setWorkspaceBibliography?: (p: string) => void;
  setWorkspaceCsl?: (p: string) => void;
  $patch?: (p: Record<string, unknown>) => void;
  persist?: () => void;
}

function getSetting(key: 'workspaceBibliography' | 'workspaceCsl'): string {
  const s = settings as unknown as CitationSettings;
  return s[key] || '';
}

function applySetting(key: 'workspaceBibliography' | 'workspaceCsl', value: string) {
  const s = settings as unknown as CitationSettings;
  if (key === 'workspaceBibliography' && typeof s.setWorkspaceBibliography === 'function') {
    s.setWorkspaceBibliography(value);
    return;
  }
  if (key === 'workspaceCsl' && typeof s.setWorkspaceCsl === 'function') {
    s.setWorkspaceCsl(value);
    return;
  }
  // Fallback: write directly + persist (Pinia stores allow this).
  if (typeof s.$patch === 'function') {
    s.$patch({ [key]: value });
  } else {
    (s as unknown as Record<string, unknown>)[key] = value;
  }
  if (typeof s.persist === 'function') s.persist();
}

async function pickBibliography() {
  const path = await openFileDialog({
    multiple: false,
    filters: [
      { name: 'BibTeX / CSL-JSON', extensions: ['bib', 'json', 'cslj', 'csl-json'] },
    ],
  });
  if (path && typeof path === 'string') {
    applySetting('workspaceBibliography', path);
    invalidateCitationsCache();
    toasts.success(t('settings.bibliographyPicked'));
  }
}

async function pickCsl() {
  const path = await openFileDialog({
    multiple: false,
    filters: [{ name: 'CSL Style', extensions: ['csl', 'xml'] }],
  });
  if (path && typeof path === 'string') {
    applySetting('workspaceCsl', path);
    toasts.success(t('settings.cslPicked'));
  }
}

function clearBibliography() {
  applySetting('workspaceBibliography', '');
  invalidateCitationsCache();
}

function clearCsl() {
  applySetting('workspaceCsl', '');
}
</script>

<template>
  <section>
    <label>{{ t('settings.bibliography') }}</label>
    <div class="row" style="gap: 8px; align-items: center;">
      <button @click="pickBibliography">{{ t('settings.pickBibliography') }}</button>
      <button v-if="getSetting('workspaceBibliography')" @click="clearBibliography">
        {{ t('settings.clear') }}
      </button>
    </div>
    <div
      v-if="getSetting('workspaceBibliography')"
      style="font-size: 11px; color: var(--text-faint); word-break: break-all; margin-top: 4px;"
    >
      {{ getSetting('workspaceBibliography') }}
    </div>
    <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
      {{ t('settings.bibliographyHint') }}
    </div>
  </section>

  <section>
    <label>{{ t('settings.csl') }}</label>
    <div class="row" style="gap: 8px; align-items: center;">
      <button @click="pickCsl">{{ t('settings.pickCsl') }}</button>
      <button v-if="getSetting('workspaceCsl')" @click="clearCsl">
        {{ t('settings.clear') }}
      </button>
    </div>
    <div
      v-if="getSetting('workspaceCsl')"
      style="font-size: 11px; color: var(--text-faint); word-break: break-all; margin-top: 4px;"
    >
      {{ getSetting('workspaceCsl') }}
    </div>
    <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
      {{ t('settings.cslHint') }}
    </div>
  </section>
</template>
