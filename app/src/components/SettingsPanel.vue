<script setup lang="ts">
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useToastsStore } from '../stores/toasts';
import { useWorkspaceStore } from '../stores/workspace';
import { useRagStore } from '../stores/rag';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { themeLabels } from '../lib/themes';
import { useI18n } from '../i18n';
import { checkForUpdate, openReleaseUrl, isMasBuild } from '../lib/check-update';
import AISettings from './AISettings.vue';
import CitationPickerSettings from './CitationPickerSettings.vue';
import CaptureEndpointSettings from './CaptureEndpointSettings.vue';
import IntegrationsSettings from './IntegrationsSettings.vue';
import ThemeMarketplace from './ThemeMarketplace.vue';
import { isIOS } from '../lib/platform';
import type { Theme } from '../types';

const isMobilePlatform = isIOS();
const masBuild = isMasBuild();

const { t } = useI18n();

const checkingUpdate = ref(false);
async function manualCheckUpdate() {
  checkingUpdate.value = true;
  try {
    const r = await checkForUpdate();
    if (r.error) {
      // Both solomd.app proxy + GitHub direct failed (offline / DNS / etc).
      // Don't lie to the user with "up to date" — show a real error.
      toasts.error(t('settings.updateCheckFailed'));
    } else if (r.hasUpdate) {
      toasts.success(t('settings.updateAvailable', { version: r.latest || '' }));
      await openReleaseUrl(r.url);
    } else {
      toasts.info(t('settings.upToDate'));
    }
  } catch (e) {
    toasts.error(String(e));
  } finally {
    checkingUpdate.value = false;
  }
}

const settingDefault = ref(false);

async function setAsDefault() {
  settingDefault.value = true;
  try {
    const msg = await invoke<string>('set_as_default_markdown_editor');
    toasts.success(msg);
  } catch (e) {
    toasts.error(String(e));
  } finally {
    settingDefault.value = false;
  }
}

defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const settings = useSettingsStore();
const tabs = useTabsStore();
const toasts = useToastsStore();
const workspace = useWorkspaceStore();
const rag = useRagStore();

async function onToggleRagEnabled() {
  settings.toggleRagEnabled();
  if (settings.ragEnabled && workspace.currentFolder) {
    // Kick off the indexer the moment the user opts in. spawn_blocking
    // on the Rust side keeps the UI thread free.
    await rag.setEnabled(workspace.currentFolder, true);
  } else {
    await rag.setEnabled(workspace.currentFolder, false);
  }
}

async function onReindexNow() {
  if (!workspace.currentFolder) return;
  await rag.reindex(workspace.currentFolder);
}

function onToggleOutlineGlobal() {
  settings.toggleOutline();
  // Apply the new default to all currently-open markdown tabs so the toggle
  // feels immediate, not just prospective for future tabs.
  tabs.setShowOutlineAll(settings.showOutline);
}

async function pickCustomCss() {
  const path = await openFileDialog({
    multiple: false,
    filters: [{ name: 'CSS', extensions: ['css'] }],
  });
  if (path && typeof path === 'string') {
    settings.setCustomCssPath(path);
    toasts.success('Custom CSS theme loaded');
  }
}

// v2.5: theme marketplace modal — opened from the Custom CSS section.
const themeMarketplaceOpen = ref(false);
function openThemeMarketplace() {
  themeMarketplaceOpen.value = true;
}

const fontFamilies = [
  // Monospace — for code-heavy editing
  { label: 'JetBrains Mono', value: 'JetBrains Mono' },
  { label: 'SF Mono', value: 'SF Mono' },
  { label: 'Menlo', value: 'Menlo' },
  { label: 'Consolas', value: 'Consolas' },
  { label: 'Fira Code', value: 'Fira Code' },
  // Proportional — for prose / long-form writing
  { label: 'System Sans', value: '-apple-system, "Segoe UI", system-ui, sans-serif' },
  { label: 'Georgia (Serif)', value: 'Georgia' },
  { label: 'Times New Roman (Serif)', value: 'Times New Roman' },
  // Common CJK faces that already ship on the OS
  { label: 'PingFang SC', value: 'PingFang SC' },
  { label: 'Microsoft YaHei', value: 'Microsoft YaHei' },
  { label: 'Source Han Sans', value: 'Source Han Sans SC' },
  { label: 'Source Han Serif', value: 'Source Han Serif SC' },
  // Writing-friendly CJK faces (open source, install separately if missing)
  { label: 'LXGW WenKai 霞鹜文楷', value: 'LXGW WenKai' },
  { label: 'LXGW Bright 霞鹜新晨宋', value: 'LXGW Bright' },
  { label: 'TsangerJinKai 仓耳今楷', value: 'TsangerJinKai03 W04' },
];
const fontFamilyPresetValues = new Set(fontFamilies.map((f) => f.value));
// Track custom-mode independently of settings.fontFamily so selecting
// "自定义…" reveals the input even before user types anything.
const inCustomMode = ref(!fontFamilyPresetValues.has(settings.fontFamily));
const customFontFamily = ref(
  inCustomMode.value ? settings.fontFamily : ''
);
function onSelectFontFamily(v: string) {
  if (v === '__custom__') {
    inCustomMode.value = true;
    return;
  }
  inCustomMode.value = false;
  customFontFamily.value = '';
  settings.setFontFamily(v);
}
function onCustomFontInput(v: string) {
  customFontFamily.value = v;
  if (v.trim()) settings.setFontFamily(v.trim());
}
const fontFamilySelectValue = computed(() =>
  inCustomMode.value ? '__custom__' : settings.fontFamily
);

// ---- v2.5 F3: PDF / print export defaults ---------------------------------

const pdfMmRangeError = ref(false);
function onCustomMmChange(
  field:
    | 'customWidthMm'
    | 'customHeightMm'
    | 'customMarginTopMm'
    | 'customMarginRightMm'
    | 'customMarginBottomMm'
    | 'customMarginLeftMm',
  raw: string,
) {
  const n = Number(raw);
  // Width/height accept 50–500 mm; margins 5–100 mm. Out-of-range silently
  // clamps (the store also clamps) but flag the error inline so the user
  // sees feedback if they mistype "500" into a 5–100 field.
  const isMargin = field.startsWith('customMargin');
  const min = isMargin ? 5 : 50;
  const max = isMargin ? 100 : 500;
  if (!Number.isFinite(n) || n < min || n > max) {
    pdfMmRangeError.value = true;
  } else {
    pdfMmRangeError.value = false;
  }
  // Forward what we have — the store clamps to the safe range, so a typo
  // won't produce a half-page-wide margin.
  settings.setPdfDefaults({ [field]: n } as any);
}

// PDF font select: the dropdown uses the same `fontFamilies` list as the
// editor; the empty value means "inherit / use stylesheet default."
const pdfFontSelectValue = computed(() =>
  fontFamilyPresetValues.has(settings.pdfDefaults.fontFamily)
    ? settings.pdfDefaults.fontFamily
    : settings.pdfDefaults.fontFamily
      ? '__custom_pdf__'
      : ''
);
function onSelectPdfFont(v: string) {
  if (v === '__custom_pdf__') return;
  settings.setPdfDefaults({ fontFamily: v });
}
</script>

<template>
  <div v-if="open" class="settings__backdrop" @click.self="emit('close')">
    <div class="settings" role="dialog" aria-label="Settings">
      <header class="settings__header">
        <h2>{{ t('settings.title') }}</h2>
        <button class="settings__close" @click="emit('close')">×</button>
      </header>
      <div class="settings__body">
        <section>
          <label>{{ t('settings.language') }}</label>
          <select
            :value="settings.language"
            @change="settings.setLanguage(($event.target as HTMLSelectElement).value as 'en' | 'zh')"
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
          </select>
        </section>

        <section>
          <label>{{ t('settings.theme') }}</label>
          <select
            :value="settings.theme"
            @change="settings.setTheme(($event.target as HTMLSelectElement).value as Theme)"
          >
            <option v-for="th in themeLabels" :key="th.value" :value="th.value">{{ th.label }}</option>
          </select>
        </section>

        <section>
          <label>{{ t('settings.fontFamily') }}</label>
          <select :value="fontFamilySelectValue" @change="onSelectFontFamily(($event.target as HTMLSelectElement).value)">
            <option v-for="f in fontFamilies" :key="f.label" :value="f.value">{{ f.label }}</option>
            <option value="__custom__">{{ t('settings.customFont') }}</option>
          </select>
          <input
            v-if="fontFamilySelectValue === '__custom__'"
            type="text"
            :placeholder="t('settings.customFontPlaceholder')"
            :value="customFontFamily"
            @input="onCustomFontInput(($event.target as HTMLInputElement).value)"
            style="margin-top: 6px; padding: 6px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px; font: inherit; width: 100%;"
          />
          <p class="setting-hint">{{ t('settings.fontFamilyHint') }}</p>
        </section>

        <section>
          <label>{{ t('settings.fontSize') }}: {{ settings.fontSize }}px</label>
          <input
            type="range"
            min="10"
            max="28"
            :value="settings.fontSize"
            @input="settings.setFontSize(+($event.target as HTMLInputElement).value)"
          />
        </section>

        <section>
          <label>{{ t('settings.uiFontSize') }}: {{ settings.uiFontSize }}px</label>
          <input
            type="range"
            min="10"
            max="20"
            :value="settings.uiFontSize"
            @input="settings.setUiFontSize(+($event.target as HTMLInputElement).value)"
          />
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.wordWrap" @change="settings.toggleWordWrap()" />
            {{ t('settings.wordWrap') }}
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.showLineNumbers" @change="settings.toggleLineNumbers()" />
            {{ t('settings.lineNumbers') }}
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.livePreview" @change="settings.toggleLivePreview()" />
            {{ t('settings.livePreview') }}
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.showOutline" @change="onToggleOutlineGlobal()" />
            {{ t('settings.showOutline') }}
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.previewFitWidth" @change="settings.togglePreviewFitWidth()" />
            {{ t('settings.previewFitWidth') }}
          </label>
        </section>

        <section>
          <label>
            <input
              type="checkbox"
              :checked="settings.readingByDefaultOnMobile"
              @change="settings.toggleReadingByDefaultOnMobile()"
            />
            {{ t('reading.readingByDefaultOnMobile') }}
          </label>
          <p style="font-size: 11px; color: var(--text-faint); margin: 4px 0 0; line-height: 1.5;">{{ t('reading.readingByDefaultOnMobileHint') }}</p>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.showFileTree" @change="settings.toggleFileTree()" />
            {{ t('settings.showFileTree') }}
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.showBacklinks" @change="settings.toggleBacklinks()" />
            {{ t('settings.showBacklinks') }}
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.showTagsPanel" @change="settings.toggleTagsPanel()" />
            {{ t('settings.showTagsPanel') }}
          </label>
        </section>

        <section>
          <h3 style="font-size: 13px; font-weight: 600; color: var(--text); margin: 18px 0 6px;">
            {{ t('writingStats.settingsHeading') }}
          </h3>
          <label>
            <input
              type="checkbox"
              :checked="settings.showWritingStats"
              @change="settings.toggleWritingStats()"
            />
            {{ t('writingStats.showInStatusBar') }}
          </label>
          <label style="margin-top: 6px;">
            <input
              type="checkbox"
              :checked="settings.showWorkspaceDailyTotal"
              @change="settings.toggleWorkspaceDailyTotal()"
              :disabled="!settings.showWritingStats"
            />
            {{ t('writingStats.showWorkspaceDailyTotal') }}
          </label>
          <p style="font-size: 11px; color: var(--text-faint); margin: 4px 0 0; line-height: 1.5;">
            {{ t('writingStats.frontMatterHint') }}
          </p>
        </section>

        <section>
          <h3 style="font-size: 13px; font-weight: 600; color: var(--text); margin: 18px 0 6px;">
            {{ t('settings.versionHistoryHeading') }}
          </h3>
          <label>
            <input type="checkbox" :checked="settings.autoGitEnabled" @change="settings.toggleAutoGit()" />
            {{ t('settings.autoGitEnabled') }}
          </label>
          <p style="font-size: 11px; color: var(--text-faint); margin: 4px 0 0; line-height: 1.5;">
            {{ t('settings.autoGitHelp') }}
          </p>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.spellcheckEnabled" @change="settings.toggleSpellcheckEnabled()" />
            {{ t('settings.spellcheckEnabled') }}
          </label>
        </section>

        <section>
          <h3 style="font-size: 13px; font-weight: 600; color: var(--text); margin: 18px 0 6px;">
            {{ t('rag.settingsHeading') }}
          </h3>
          <label>
            <input
              type="checkbox"
              :checked="settings.ragEnabled"
              @change="onToggleRagEnabled()"
            />
            {{ t('rag.enable') }}
          </label>
          <p style="font-size: 11px; color: var(--text-faint); margin: 4px 0 0; line-height: 1.5;">
            {{ t('rag.enableHint') }}
          </p>
          <div
            v-if="settings.ragEnabled && workspace.currentFolder"
            style="margin-top: 8px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;"
          >
            <span style="font-size: 11px; color: var(--text-muted);">
              <template v-if="rag.status?.ready">
                {{ t('rag.statusReady', {
                  indexed: String(rag.status.indexed_files),
                  total: String(rag.status.total_files),
                  chunks: String(rag.status.total_chunks),
                  backend: rag.status.backend,
                }) }}
              </template>
              <template v-else>
                {{ t('rag.statusEmpty') }}
              </template>
            </span>
            <button
              :disabled="rag.indexing"
              @click="onReindexNow"
              style="font-size: 11px; padding: 4px 10px;"
            >
              {{ rag.indexing ? t('rag.indexing') : t('rag.reindexNow') }}
            </button>
          </div>
        </section>

        <!-- v2.5 F3: PDF / print export defaults. Lives between AutoGit and
             Daily-notes so the "documents you produce" cluster reads top-down. -->
        <section>
          <h3 style="font-size: 13px; font-weight: 600; color: var(--text); margin: 18px 0 6px;">
            {{ t('settings.pdfDefaults.heading') }}
          </h3>
          <p class="setting-hint">{{ t('settings.pdfDefaults.headingHint') }}</p>
        </section>

        <section>
          <label>{{ t('settings.pdfDefaults.pageSize') }}</label>
          <select
            :value="settings.pdfDefaults.pageSize"
            @change="settings.setPdfDefaults({ pageSize: ($event.target as HTMLSelectElement).value as any })"
          >
            <option value="A4">A4 (210 × 297 mm)</option>
            <option value="A5">A5 (148 × 210 mm)</option>
            <option value="Letter">{{ t('settings.pdfDefaults.letter') }} (8.5 × 11 in)</option>
            <option value="Legal">{{ t('settings.pdfDefaults.legal') }} (8.5 × 14 in)</option>
            <option value="Custom">{{ t('settings.pdfDefaults.custom') }}</option>
          </select>
          <div
            v-if="settings.pdfDefaults.pageSize === 'Custom'"
            class="row"
            style="gap: 6px; align-items: center; margin-top: 6px;"
          >
            <input
              type="number"
              min="50"
              max="500"
              step="1"
              :value="settings.pdfDefaults.customWidthMm"
              @input="onCustomMmChange('customWidthMm', ($event.target as HTMLInputElement).value)"
              style="width: 90px; padding: 6px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px;"
              :aria-label="t('settings.pdfDefaults.widthMm')"
            />
            <span style="font-size: 12px; color: var(--text-muted);">×</span>
            <input
              type="number"
              min="50"
              max="500"
              step="1"
              :value="settings.pdfDefaults.customHeightMm"
              @input="onCustomMmChange('customHeightMm', ($event.target as HTMLInputElement).value)"
              style="width: 90px; padding: 6px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px;"
              :aria-label="t('settings.pdfDefaults.heightMm')"
            />
            <span style="font-size: 12px; color: var(--text-muted);">mm</span>
          </div>
        </section>

        <section>
          <label>{{ t('settings.pdfDefaults.margin') }}</label>
          <select
            :value="settings.pdfDefaults.margin"
            @change="settings.setPdfDefaults({ margin: ($event.target as HTMLSelectElement).value as any })"
          >
            <option value="Narrow">{{ t('settings.pdfDefaults.marginNarrow') }} (10 mm)</option>
            <option value="Normal">{{ t('settings.pdfDefaults.marginNormal') }} (15 mm)</option>
            <option value="Wide">{{ t('settings.pdfDefaults.marginWide') }} (25 mm)</option>
            <option value="Custom">{{ t('settings.pdfDefaults.custom') }}</option>
          </select>
          <div
            v-if="settings.pdfDefaults.margin === 'Custom'"
            style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; margin-top: 6px;"
          >
            <label style="display: flex; align-items: center; gap: 6px; font-size: 12px;">
              <span style="min-width: 56px; color: var(--text-muted);">{{ t('settings.pdfDefaults.marginTop') }}</span>
              <input
                type="number" min="5" max="100" step="1"
                :value="settings.pdfDefaults.customMarginTopMm"
                @input="onCustomMmChange('customMarginTopMm', ($event.target as HTMLInputElement).value)"
                style="width: 70px; padding: 4px 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px;"
              />
              <span style="font-size: 11px; color: var(--text-muted);">mm</span>
            </label>
            <label style="display: flex; align-items: center; gap: 6px; font-size: 12px;">
              <span style="min-width: 56px; color: var(--text-muted);">{{ t('settings.pdfDefaults.marginRight') }}</span>
              <input
                type="number" min="5" max="100" step="1"
                :value="settings.pdfDefaults.customMarginRightMm"
                @input="onCustomMmChange('customMarginRightMm', ($event.target as HTMLInputElement).value)"
                style="width: 70px; padding: 4px 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px;"
              />
              <span style="font-size: 11px; color: var(--text-muted);">mm</span>
            </label>
            <label style="display: flex; align-items: center; gap: 6px; font-size: 12px;">
              <span style="min-width: 56px; color: var(--text-muted);">{{ t('settings.pdfDefaults.marginBottom') }}</span>
              <input
                type="number" min="5" max="100" step="1"
                :value="settings.pdfDefaults.customMarginBottomMm"
                @input="onCustomMmChange('customMarginBottomMm', ($event.target as HTMLInputElement).value)"
                style="width: 70px; padding: 4px 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px;"
              />
              <span style="font-size: 11px; color: var(--text-muted);">mm</span>
            </label>
            <label style="display: flex; align-items: center; gap: 6px; font-size: 12px;">
              <span style="min-width: 56px; color: var(--text-muted);">{{ t('settings.pdfDefaults.marginLeft') }}</span>
              <input
                type="number" min="5" max="100" step="1"
                :value="settings.pdfDefaults.customMarginLeftMm"
                @input="onCustomMmChange('customMarginLeftMm', ($event.target as HTMLInputElement).value)"
                style="width: 70px; padding: 4px 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px;"
              />
              <span style="font-size: 11px; color: var(--text-muted);">mm</span>
            </label>
          </div>
          <p v-if="pdfMmRangeError" class="setting-hint" style="color: var(--danger, #d12);">
            {{ t('settings.pdfDefaults.mmRangeError') }}
          </p>
        </section>

        <section>
          <label>{{ t('settings.pdfDefaults.fontFamily') }}</label>
          <select
            :value="pdfFontSelectValue"
            @change="onSelectPdfFont(($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('settings.pdfDefaults.fontInherit') }}</option>
            <option v-for="f in fontFamilies" :key="f.label" :value="f.value">{{ f.label }}</option>
          </select>
        </section>

        <section>
          <label>{{ t('settings.pdfDefaults.fontSize') }}: {{ settings.pdfDefaults.fontSize }}pt</label>
          <input
            type="range"
            min="9"
            max="16"
            step="1"
            :value="settings.pdfDefaults.fontSize"
            @input="settings.setPdfDefaults({ fontSize: +($event.target as HTMLInputElement).value })"
          />
        </section>

        <section>
          <label>
            <input
              type="checkbox"
              :checked="settings.pdfDefaults.footer"
              @change="settings.setPdfDefaults({ footer: ($event.target as HTMLInputElement).checked })"
            />
            {{ t('settings.pdfDefaults.footer') }}
          </label>
        </section>

        <section>
          <label>{{ t('settings.pdfDefaults.codeTheme') }}</label>
          <select
            :value="settings.pdfDefaults.codeTheme"
            @change="settings.setPdfDefaults({ codeTheme: ($event.target as HTMLSelectElement).value as any })"
          >
            <option value="preview">{{ t('settings.pdfDefaults.codeThemePreview') }}</option>
            <option value="light">{{ t('settings.pdfDefaults.codeThemeLight') }}</option>
            <option value="dark">{{ t('settings.pdfDefaults.codeThemeDark') }}</option>
          </select>
          <p class="setting-hint">{{ t('settings.pdfDefaults.frontmatterHint') }}</p>
        </section>

        <section>
          <label>{{ t('settings.dailyNotesFolder') }}</label>
          <input
            type="text"
            :value="settings.dailyNotesFolder"
            @input="settings.setDailyNotesFolder(($event.target as HTMLInputElement).value)"
            placeholder="Daily"
            style="padding: 6px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px; font: inherit;"
          />
        </section>

        <section>
          <label>{{ t('settings.dailyNotesFormat') }}</label>
          <input
            type="text"
            :value="settings.dailyNotesFormat"
            @input="settings.setDailyNotesFormat(($event.target as HTMLInputElement).value)"
            placeholder="YYYY-MM-DD.md"
            style="padding: 6px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px; font: inherit;"
          />
        </section>

        <CitationPickerSettings />

        <AISettings
          :enabled="settings.aiEnabled"
          :provider="(settings.aiProvider as any)"
          :model="settings.aiModel"
          :base-url="settings.aiBaseUrl"
          @update:enabled="settings.toggleAiEnabled()"
          @update:provider="(v: string) => settings.setAiProvider(v)"
          @update:model="(v: string) => settings.setAiModel(v)"
          @update:baseUrl="(v: string) => settings.setAiBaseUrl(v)"
        />

        <!-- v2.4: Integrations (CLI + MCP) — sits under AI rewrite so the
             "things SoloMD talks to" section reads as one cluster. -->
        <IntegrationsSettings />

        <section>
          <label>
            <input type="checkbox" :checked="settings.spellCheck" @change="settings.toggleSpellCheck()" />
            {{ t('settings.spellCheck') }}
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.focusMode" @change="settings.toggleFocusMode()" />
            {{ t('settings.focusMode') }}
          </label>
        </section>

        <section>
          <h3 style="font-size: 13px; font-weight: 600; color: var(--text); margin: 18px 0 6px;">
            {{ t('pomodoro.settingsHeading') }}
          </h3>
          <label>
            <input
              type="checkbox"
              :checked="settings.pomodoroShowControls"
              @change="settings.togglePomodoroShowControls()"
            />
            {{ t('pomodoro.showControls') }}
          </label>
          <p style="font-size: 11px; color: var(--text-faint); margin: 4px 0 8px; line-height: 1.5;">
            {{ t('pomodoro.showControlsHint') }}
          </p>
          <label>
            <input
              type="checkbox"
              :checked="settings.pomodoroAutoEngageFocus"
              @change="settings.togglePomodoroAutoEngageFocus()"
            />
            {{ t('pomodoro.autoEngageFocus') }}
          </label>
          <p style="font-size: 11px; color: var(--text-faint); margin: 4px 0 8px; line-height: 1.5;">
            {{ t('pomodoro.autoEngageFocusHint') }}
          </p>
          <label style="display: block; margin-top: 4px;">{{ t('pomodoro.defaultDuration') }}</label>
          <select
            :value="String(settings.pomodoroDefaultMinutes)"
            @change="(e) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === 'custom') return;
              settings.setPomodoroDefaultMinutes(parseInt(v, 10));
            }"
            style="margin-top: 4px;"
          >
            <option value="25">25 {{ t('pomodoro.minShort') }}</option>
            <option value="50">50 {{ t('pomodoro.minShort') }}</option>
            <option value="90">90 {{ t('pomodoro.minShort') }}</option>
          </select>
          <input
            type="number"
            min="1"
            max="600"
            :value="settings.pomodoroDefaultMinutes"
            @input="settings.setPomodoroDefaultMinutes(parseInt(($event.target as HTMLInputElement).value, 10) || 25)"
            :aria-label="t('pomodoro.customDurationLabel')"
            style="margin-left: 8px; padding: 4px 6px; width: 70px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px; font: inherit;"
          />
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.typewriterMode" @change="settings.toggleTypewriterMode()" />
            {{ t('settings.typewriterMode') }}
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.vimMode" @change="settings.toggleVimMode()" />
            {{ t('settings.vimMode') }}
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.slashCommandsEnabled" @change="settings.toggleSlashCommandsEnabled()" />
            {{ t('settings.slashCommandsEnabled') }}
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.restoreSession" @change="settings.toggleRestoreSession()" />
            {{ t('settings.restoreSession') }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('settings.restoreSessionHint') }}
          </div>
        </section>

        <section v-if="!isMobilePlatform">
          <label>
            <input type="checkbox" :checked="settings.openFileInNewWindow" @change="settings.toggleOpenFileInNewWindow()" />
            {{ t('settings.openFileInNewWindow') }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('settings.openFileInNewWindowHint') }}
          </div>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.revealInFileTreeOnOpen" @change="settings.toggleRevealInFileTreeOnOpen()" />
            {{ t('settings.revealInFileTreeOnOpen') }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('settings.revealInFileTreeOnOpenHint') }}
          </div>
        </section>

        <section v-if="!isMobilePlatform && !masBuild">
          <label>
            <input type="checkbox" :checked="settings.autoCheckUpdate" @change="settings.toggleAutoCheckUpdate()" />
            {{ t('settings.autoCheckUpdate') }}
          </label>
          <div class="row" style="gap: 8px; align-items: center; margin-top: 8px;">
            <button :disabled="checkingUpdate" @click="manualCheckUpdate">
              {{ checkingUpdate ? t('settings.checkingUpdate') : t('settings.checkUpdate') }}
            </button>
          </div>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.telemetryEnabled" @change="settings.toggleTelemetry()" />
            {{ t('settings.telemetry') }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('settings.telemetryHint') }}
          </div>
        </section>

        <section>
          <label>{{ t('settings.customCss') }}</label>
          <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
            <button @click="pickCustomCss">{{ t('settings.pickCss') }}</button>
            <button @click="openThemeMarketplace">{{ t('themes.browseBtn') }}</button>
            <button v-if="settings.customCssPath" @click="settings.setCustomCssPath('')">{{ t('settings.clear') }}</button>
          </div>
          <div v-if="settings.customCssPath" style="font-size: 11px; color: var(--text-faint); word-break: break-all; margin-top: 4px;">
            {{ settings.customCssPath }}
          </div>
          <p class="setting-hint">{{ t('themes.browseHint') }}</p>
        </section>

        <section>
          <label>{{ t('settings.fileAssoc') }}</label>
          <div class="row" style="gap: 8px; align-items: center;">
            <button
              class="primary-btn"
              :disabled="settingDefault"
              @click="setAsDefault"
            >
              {{ settingDefault ? t('settings.settingDefault') : t('settings.setDefault') }}
            </button>
          </div>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 6px; line-height: 1.5;">
            {{ t('settings.setDefaultHint') }}
          </div>
        </section>

        <!-- v2.4 Integrations: HTTP capture endpoint. Self-contained subcomponent
             so the diff against parallel Integrations work stays clean. -->
        <CaptureEndpointSettings />
      </div>
    </div>
    <!-- v2.5: theme marketplace modal. Lives outside settings__body so it
         overlays the entire viewport, but inside the settings backdrop so
         closing settings closes it too. -->
    <ThemeMarketplace
      :open="themeMarketplaceOpen"
      @close="themeMarketplaceOpen = false"
    />
  </div>
</template>

<style scoped>
.settings__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}
.settings {
  background: var(--bg-elev);
  width: min(480px, 92vw);
  max-height: 80vh;
  border-radius: 10px;
  border: 1px solid var(--border);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
}
.settings__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.settings__header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.settings__close {
  font-size: 20px;
  line-height: 1;
  padding: 0 6px;
  color: var(--text-muted);
}
.settings__body {
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
section > label {
  font-size: 13px;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}
section > label:has(input[type='checkbox']) {
  display: inline-flex;
  align-self: flex-start;
  cursor: pointer;
}
section > label:not(:has(input)) {
  font-size: 12px;
  color: var(--text-muted);
}
.setting-hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint, #888);
  line-height: 1.5;
}
.setting-hint a {
  color: var(--accent);
  text-decoration: underline;
}
.row {
  display: flex;
  gap: 4px;
}
.row button {
  border: 1px solid var(--border);
  padding: 6px 14px;
  font-size: 12px;
}
.row button.active {
  background: var(--bg-active);
  color: var(--accent);
  border-color: var(--accent);
}
select,
input[type='range'] {
  width: 100%;
}
select {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  padding: 6px 8px;
  border-radius: 4px;
  font: inherit;
}
input[type='range'] {
  accent-color: var(--accent);
}
input[type='checkbox'] {
  accent-color: var(--accent);
}
</style>
