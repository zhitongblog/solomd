<script setup lang="ts">
import { ref, computed, watch } from 'vue';
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
import { IS_APP_STORE_BUILD } from '../lib/app-build';
import AISettings from './AISettings.vue';
import CitationPickerSettings from './CitationPickerSettings.vue';
import CaptureEndpointSettings from './CaptureEndpointSettings.vue';
import RestApiSettings from './RestApiSettings.vue';
import CostMeterSettings from './CostMeterSettings.vue';
import IntegrationsSettings from './IntegrationsSettings.vue';
// v4.0 Pillar 2 — Agent Recipes panel. Mounted under the existing
// "Integrations" category so users find Recipes alongside CLI / MCP /
// AI rewrite — i.e. the cluster of "things SoloMD talks to" rather
// than a brand-new top-level category.
import RecipesSettings from './RecipesSettings.vue';
import GithubSyncSettings from './GithubSyncSettings.vue';
import CloudFolderBanner from './CloudFolderBanner.vue';
import ProxySettings from './ProxySettings.vue';
import ThemeMarketplace from './ThemeMarketplace.vue';
import { isIOS } from '../lib/platform';
import { DsModal } from '../ui';
import type { Theme } from '../types';

const isMobilePlatform = isIOS();
const masBuild = isMasBuild();

const { t } = useI18n();

// v3.0 — left-side category nav. Settings was a 30+ item single scroll;
// split into 6 groups so the user navigates by category, not by scroll.
type SettingsCategory = 'basics' | 'writing' | 'sync' | 'integrations' | 'export' | 'advanced';
const activeCategory = ref<SettingsCategory>('basics');
const categories: { id: SettingsCategory; icon: string; labelKey: string }[] = [
  { id: 'basics', icon: '⚙️', labelKey: 'settings.catBasics' },
  { id: 'writing', icon: '✍️', labelKey: 'settings.catWriting' },
  { id: 'sync', icon: '☁️', labelKey: 'settings.catSync' },
  { id: 'integrations', icon: '🔌', labelKey: 'settings.catIntegrations' },
  { id: 'export', icon: '📤', labelKey: 'settings.catExport' },
  { id: 'advanced', icon: '🛠️', labelKey: 'settings.catAdvanced' },
];

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

const props = defineProps<{ open: boolean; initialSection?: string | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();

// Deep-link support: callers (toolbar AI button, RAG empty state, etc.)
// pass `initial-section` to land on a specific category instead of the
// default `basics`. We watch open transitions to true rather than the
// section value alone, because the parent leaves the section ref in place
// after close — re-opening would otherwise jump back to the same anchor.
const VALID_CATEGORIES = new Set<SettingsCategory>([
  'basics', 'writing', 'sync', 'integrations', 'export', 'advanced',
]);
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    const target = props.initialSection;
    if (target && VALID_CATEGORIES.has(target as SettingsCategory)) {
      activeCategory.value = target as SettingsCategory;
    }
  },
);

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
  if (rag.lastError) {
    toasts.error(`RAG: ${rag.lastError}`);
  }
}

async function onReindexNow() {
  if (!workspace.currentFolder) return;
  await rag.reindex(workspace.currentFolder);
  if (rag.lastError) {
    toasts.error(`RAG reindex failed: ${rag.lastError}`);
  } else {
    toasts.success(`Reindexed ${rag.status?.indexed_files ?? 0} files`);
  }
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
  <DsModal
    :model-value="open"
    :title="t('settings.title')"
    width="820px"
    class="settings-modal"
    @update:model-value="emit('close')"
  >
      <div class="settings__layout">
        <!-- v3.0 — left-side category nav. Click switches the right-side
             content panel; only one category visible at a time. -->
        <nav class="settings__nav">
          <button
            v-for="c in categories"
            :key="c.id"
            class="settings__nav-item"
            :class="{ 'settings__nav-item--active': activeCategory === c.id }"
            @click="activeCategory = c.id"
          >
            <span class="settings__nav-icon">{{ c.icon }}</span>
            <span class="settings__nav-label">{{ t(c.labelKey) }}</span>
          </button>
        </nav>
      <div class="settings__body" :data-active-cat="activeCategory">
        <section data-cat="basics">
          <label>{{ t('settings.language') }}</label>
          <select
            :value="settings.language"
            @change="settings.setLanguage(($event.target as HTMLSelectElement).value as 'en' | 'zh' | 'ja' | 'ko' | 'de' | 'fr' | 'es' | 'pt' | 'it' | 'pl' | 'nl' | 'tr' | 'sv' | 'uk')"
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="de">Deutsch</option>
            <option value="fr">Français</option>
            <option value="es">Español</option>
            <option value="pt">Português</option>
            <option value="it">Italiano</option>
            <option value="pl">Polski</option>
            <option value="nl">Nederlands</option>
            <option value="tr">Türkçe</option>
            <option value="sv">Svenska</option>
            <option value="uk">Українська</option>
          </select>
        </section>

        <section data-cat="basics">
          <label>{{ t('settings.theme') }}</label>
          <select
            :value="settings.theme"
            @change="settings.setTheme(($event.target as HTMLSelectElement).value as Theme)"
          >
            <option v-for="th in themeLabels" :key="th.value" :value="th.value">{{ th.label }}</option>
          </select>
        </section>

        <section data-cat="basics">
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

        <section data-cat="basics">
          <label>{{ t('settings.fontSize') }}: {{ settings.fontSize }}px</label>
          <input
            type="range"
            min="10"
            max="28"
            :value="settings.fontSize"
            @input="settings.setFontSize(+($event.target as HTMLInputElement).value)"
          />
        </section>

        <section data-cat="basics">
          <label>{{ t('settings.uiFontSize') }}: {{ settings.uiFontSize }}px</label>
          <input
            type="range"
            min="10"
            max="20"
            :value="settings.uiFontSize"
            @input="settings.setUiFontSize(+($event.target as HTMLInputElement).value)"
          />
        </section>

        <section data-cat="basics">
          <label>
            {{ t('settings.globalZoom') }}:
            {{ Math.round((settings.globalZoom || 1) * 100) }}%
          </label>
          <input
            type="range"
            min="0.75"
            max="2.5"
            step="0.05"
            :value="settings.globalZoom"
            @input="settings.setGlobalZoom(+($event.target as HTMLInputElement).value)"
          />
          <p class="setting-hint">
            {{ t('settings.globalZoomHint') }}
            <button
              type="button"
              class="link-button"
              style="margin-left: 8px;"
              @click="settings.resetZoom()"
            >
              {{ t('settings.globalZoomReset') }}
            </button>
          </p>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.wordWrap" @change="settings.toggleWordWrap()" />
            {{ t('settings.wordWrap') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.showLineNumbers" @change="settings.toggleLineNumbers()" />
            {{ t('settings.lineNumbers') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.livePreview" @change="settings.toggleLivePreview()" />
            {{ t('settings.livePreview') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.showOutline" @change="onToggleOutlineGlobal()" />
            {{ t('settings.showOutline') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>{{ t('settings.outlineSide') }}</label>
          <select
            :value="settings.outlineSide"
            @change="settings.setOutlineSide(($event.target as HTMLSelectElement).value as 'left' | 'right')"
          >
            <option value="left">{{ t('settings.outlineSideLeft') }}</option>
            <option value="right">{{ t('settings.outlineSideRight') }}</option>
          </select>
        </section>

        <section data-cat="basics">
          <label>{{ t('settings.outlineMarker') }}</label>
          <select
            :value="settings.outlineMarker"
            @change="settings.setOutlineMarker(($event.target as HTMLSelectElement).value as 'jump' | 'number' | 'none')"
          >
            <option value="jump">{{ t('settings.outlineMarkerJump') }}</option>
            <option value="number">{{ t('settings.outlineMarkerNumber') }}</option>
            <option value="none">{{ t('settings.outlineMarkerNone') }}</option>
          </select>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.previewFitWidth" @change="settings.togglePreviewFitWidth()" />
            {{ t('settings.previewFitWidth') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.limitEditorWidth" @change="settings.toggleLimitEditorWidth()" />
            {{ t('settings.limitEditorWidth') || 'Limit editor width (readable column)' }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.codeBlockLineNumbers"
              @change="settings.toggleCodeBlockLineNumbers()"
            />
            {{ t('settings.codeBlockLineNumbers') }}
          </label>
          <p class="setting-hint">{{ t('settings.codeBlockLineNumbersHint') }}</p>
        </section>

        <section data-cat="basics">
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

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.showFileTree" @change="settings.toggleFileTree()" />
            {{ t('settings.showFileTree') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.showBacklinks" @change="settings.toggleBacklinks()" />
            {{ t('settings.showBacklinks') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.showTagsPanel" @change="settings.toggleTagsPanel()" />
            {{ t('settings.showTagsPanel') }}
          </label>
        </section>

        <section data-cat="writing">
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

        <section data-cat="sync">
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

        <!-- v2.6.1 cloud-folder banner. Self-hides if the workspace isn't
             inside a known cloud-sync folder. -->
        <div data-cat="sync"><CloudFolderBanner /></div>

        <!-- v2.6 GitHub sync — sits right under AutoGit since it pushes the
             same commits AutoGit produces; reads top-down as one story. -->
        <div data-cat="sync"><GithubSyncSettings /></div>

        <!-- v3.0 — proxy URL (network-level, applies to libgit2 push/pull
             across GitHub / GitLab / Gitea). Pulled out of GithubSyncSettings
             so users hitting timeouts find it at the top of the Sync tab. -->
        <div data-cat="sync"><ProxySettings /></div>

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.spellcheckEnabled" @change="settings.toggleSpellcheckEnabled()" />
            {{ t('settings.spellcheckEnabled') }}
          </label>
        </section>

        <section data-cat="integrations">
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

        <!-- v2.5 F3: PDF / print export defaults. -->
        <section data-cat="export">
          <h3 style="font-size: 13px; font-weight: 600; color: var(--text); margin: 18px 0 6px;">
            {{ t('settings.pdfDefaults.heading') }}
          </h3>
          <p class="setting-hint">{{ t('settings.pdfDefaults.headingHint') }}</p>
        </section>

        <section data-cat="export">
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

        <section data-cat="export">
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

        <section data-cat="export">
          <label>{{ t('settings.pdfDefaults.fontFamily') }}</label>
          <select
            :value="pdfFontSelectValue"
            @change="onSelectPdfFont(($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('settings.pdfDefaults.fontInherit') }}</option>
            <option v-for="f in fontFamilies" :key="f.label" :value="f.value">{{ f.label }}</option>
          </select>
        </section>

        <section data-cat="export">
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

        <section data-cat="export">
          <label>
            <input
              type="checkbox"
              :checked="settings.pdfDefaults.footer"
              @change="settings.setPdfDefaults({ footer: ($event.target as HTMLInputElement).checked })"
            />
            {{ t('settings.pdfDefaults.footer') }}
          </label>
        </section>

        <section data-cat="export">
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

        <section data-cat="export">
          <label>
            <input
              type="checkbox"
              :checked="settings.imageExportBranding"
              @change="settings.toggleImageExportBranding()"
            />
            {{ t('settings.imageExportBranding') }}
          </label>
          <p class="setting-hint">{{ t('settings.imageExportBrandingHint') }}</p>
        </section>

        <section data-cat="writing">
          <label>{{ t('settings.attachmentMode') }}</label>
          <select
            :value="settings.attachmentMode"
            @change="settings.setAttachmentMode(($event.target as HTMLSelectElement).value as 'shared' | 'per-file' | 'custom')"
          >
            <option value="shared">{{ t('settings.attachmentModeShared') }}</option>
            <option value="per-file">{{ t('settings.attachmentModePerFile') }}</option>
            <option value="custom">{{ t('settings.attachmentModeCustom') }}</option>
          </select>
          <p class="setting-hint">{{ t('settings.attachmentModeHint') }}</p>
        </section>

        <section data-cat="writing" v-if="settings.attachmentMode === 'shared'">
          <label>{{ t('settings.assetsDirName') }}</label>
          <input
            type="text"
            :value="settings.assetsDirName"
            @change="settings.setAssetsDirName(($event.target as HTMLInputElement).value)"
            placeholder="_assets"
            style="padding: 6px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px; font: inherit;"
          />
          <p class="setting-hint">{{ t('settings.assetsDirNameHint') }}</p>
        </section>

        <section data-cat="writing" v-if="settings.attachmentMode === 'custom'">
          <label>{{ t('settings.attachmentCustomPath') }}</label>
          <input
            type="text"
            :value="settings.attachmentCustomPath"
            @change="settings.setAttachmentCustomPath(($event.target as HTMLInputElement).value)"
            placeholder="./images/${filename}/"
            style="padding: 6px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px; font: inherit;"
          />
          <p class="setting-hint">{{ t('settings.attachmentCustomPathHint') }}</p>
        </section>

        <!-- 图床 / image upload (external image hosting) — like Typora / MarkText.
             Instead of (or alongside) copying a pasted image locally, upload it
             to an image host and insert the returned URL. -->
        <section data-cat="writing">
          <label>{{ t('settings.imageUploaderSection') }}</label>
          <select
            :value="settings.imageUploader"
            @change="settings.setImageUpload({ imageUploader: ($event.target as HTMLSelectElement).value as 'none' | 'picgo' | 'command' | 'smms' | 's3' | 'github' })"
          >
            <option value="none">{{ t('settings.imageUploaderNone') }}</option>
            <option value="picgo">{{ t('settings.imageUploaderPicgo') }}</option>
            <option value="command">{{ t('settings.imageUploaderCommand') }}</option>
            <option value="smms">{{ t('settings.imageUploaderSmms') }}</option>
            <option value="s3">{{ t('settings.imageUploaderS3') }}</option>
            <option value="github">{{ t('settings.imageUploaderGithub') }}</option>
          </select>
        </section>

        <template v-if="settings.imageUploader !== 'none'">
          <section data-cat="writing">
            <label>
              <input
                type="checkbox"
                :checked="settings.imageUploadOnPaste"
                @change="settings.setImageUpload({ imageUploadOnPaste: ($event.target as HTMLInputElement).checked })"
              />
              {{ t('settings.imageUploadOnPaste') }}
            </label>
            <p class="setting-hint">{{ t('settings.imageUploadOnPasteHint') }}</p>
          </section>
          <section data-cat="writing">
            <label>
              <input
                type="checkbox"
                :checked="settings.imageUploadKeepLocal"
                @change="settings.setImageUpload({ imageUploadKeepLocal: ($event.target as HTMLInputElement).checked })"
              />
              {{ t('settings.imageUploadKeepLocal') }}
            </label>
            <p class="setting-hint">{{ t('settings.imageUploadKeepLocalHint') }}</p>
          </section>

          <!-- PicGo -->
          <section data-cat="writing" v-if="settings.imageUploader === 'picgo'">
            <label>{{ t('settings.picgoEndpoint') }}</label>
            <input
              class="img-field"
              type="text"
              :value="settings.picgoEndpoint"
              @change="settings.setImageUpload({ picgoEndpoint: ($event.target as HTMLInputElement).value })"
              placeholder="http://127.0.0.1:36677/upload"
            />
            <p class="setting-hint">{{ t('settings.picgoEndpointHint') }}</p>
          </section>

          <!-- Custom command -->
          <section data-cat="writing" v-if="settings.imageUploader === 'command'">
            <label>{{ t('settings.imageUploadCommand') }}</label>
            <input
              class="img-field"
              type="text"
              :value="settings.imageUploadCommand"
              @change="settings.setImageUpload({ imageUploadCommand: ($event.target as HTMLInputElement).value })"
              placeholder="picgo upload {path}"
            />
            <p class="setting-hint">{{ t('settings.imageUploadCommandHint') }}</p>
          </section>

          <!-- SM.MS -->
          <section data-cat="writing" v-if="settings.imageUploader === 'smms'">
            <label>{{ t('settings.smmsToken') }}</label>
            <input
              class="img-field"
              type="password"
              :value="settings.smmsToken"
              @change="settings.setImageUpload({ smmsToken: ($event.target as HTMLInputElement).value })"
            />
            <p class="setting-hint">{{ t('settings.smmsTokenHint') }}</p>
          </section>

          <!-- S3-compatible -->
          <template v-if="settings.imageUploader === 's3'">
            <section data-cat="writing">
              <label>{{ t('settings.s3Endpoint') }}</label>
              <input class="img-field" type="text" :value="settings.s3Endpoint" @change="settings.setImageUpload({ s3Endpoint: ($event.target as HTMLInputElement).value })" placeholder="https://s3.amazonaws.com" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.s3Region') }}</label>
              <input class="img-field" type="text" :value="settings.s3Region" @change="settings.setImageUpload({ s3Region: ($event.target as HTMLInputElement).value })" placeholder="us-east-1" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.s3Bucket') }}</label>
              <input class="img-field" type="text" :value="settings.s3Bucket" @change="settings.setImageUpload({ s3Bucket: ($event.target as HTMLInputElement).value })" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.s3AccessKeyId') }}</label>
              <input class="img-field" type="text" :value="settings.s3AccessKeyId" @change="settings.setImageUpload({ s3AccessKeyId: ($event.target as HTMLInputElement).value })" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.s3SecretAccessKey') }}</label>
              <input class="img-field" type="password" :value="settings.s3SecretAccessKey" @change="settings.setImageUpload({ s3SecretAccessKey: ($event.target as HTMLInputElement).value })" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.s3PathPrefix') }}</label>
              <input class="img-field" type="text" :value="settings.s3PathPrefix" @change="settings.setImageUpload({ s3PathPrefix: ($event.target as HTMLInputElement).value })" placeholder="images/" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.s3CustomDomain') }}</label>
              <input class="img-field" type="text" :value="settings.s3CustomDomain" @change="settings.setImageUpload({ s3CustomDomain: ($event.target as HTMLInputElement).value })" placeholder="https://cdn.example.com" />
            </section>
            <section data-cat="writing">
              <label>
                <input type="checkbox" :checked="settings.s3UsePathStyle" @change="settings.setImageUpload({ s3UsePathStyle: ($event.target as HTMLInputElement).checked })" />
                {{ t('settings.s3UsePathStyle') }}
              </label>
            </section>
          </template>

          <!-- GitHub repo + CDN -->
          <template v-if="settings.imageUploader === 'github'">
            <section data-cat="writing">
              <label>{{ t('settings.ghImageRepo') }}</label>
              <input class="img-field" type="text" :value="settings.ghImageRepo" @change="settings.setImageUpload({ ghImageRepo: ($event.target as HTMLInputElement).value })" placeholder="owner/repo" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.ghImageBranch') }}</label>
              <input class="img-field" type="text" :value="settings.ghImageBranch" @change="settings.setImageUpload({ ghImageBranch: ($event.target as HTMLInputElement).value })" placeholder="main" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.ghImageToken') }}</label>
              <input class="img-field" type="password" :value="settings.ghImageToken" @change="settings.setImageUpload({ ghImageToken: ($event.target as HTMLInputElement).value })" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.ghImagePathPrefix') }}</label>
              <input class="img-field" type="text" :value="settings.ghImagePathPrefix" @change="settings.setImageUpload({ ghImagePathPrefix: ($event.target as HTMLInputElement).value })" placeholder="images/" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.ghImageCdn') }}</label>
              <select
                :value="settings.ghImageCdn"
                @change="settings.setImageUpload({ ghImageCdn: ($event.target as HTMLSelectElement).value as 'raw' | 'jsdelivr' })"
              >
                <option value="jsdelivr">{{ t('settings.ghImageCdnJsdelivr') }}</option>
                <option value="raw">{{ t('settings.ghImageCdnRaw') }}</option>
              </select>
            </section>
          </template>
        </template>

        <section data-cat="advanced">
          <label>{{ t('settings.dailyNotesFolder') }}</label>
          <input
            type="text"
            :value="settings.dailyNotesFolder"
            @input="settings.setDailyNotesFolder(($event.target as HTMLInputElement).value)"
            placeholder="Daily"
            style="padding: 6px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px; font: inherit;"
          />
        </section>

        <section data-cat="advanced">
          <label>{{ t('settings.dailyNotesFormat') }}</label>
          <input
            type="text"
            :value="settings.dailyNotesFormat"
            @input="settings.setDailyNotesFormat(($event.target as HTMLInputElement).value)"
            placeholder="YYYY-MM-DD.md"
            style="padding: 6px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 4px; font: inherit;"
          />
        </section>

        <div data-cat="export"><CitationPickerSettings /></div>

        <!-- App Store builds strip the AI / Agent / Recipes / CostMeter
             surface under Guideline 3.1.1 (BYOK API keys unlocking paid
             functionality). The GitHub Developer ID build keeps them. -->
        <div v-if="!IS_APP_STORE_BUILD" data-cat="integrations"><AISettings
          :enabled="settings.aiEnabled"
          :provider="(settings.aiProvider as any)"
          :model="settings.aiModel"
          :base-url="settings.aiBaseUrl"
          @update:enabled="settings.toggleAiEnabled()"
          @update:provider="(v: string) => settings.setAiProvider(v)"
          @update:model="(v: string) => settings.setAiModel(v)"
          @update:baseUrl="(v: string) => settings.setAiBaseUrl(v)"
        /></div>

        <!-- v4.0: BYOK cost meter — sits under AI so users see "your spend"
             right below "your provider key". -->
        <div v-if="!IS_APP_STORE_BUILD" data-cat="integrations"><CostMeterSettings /></div>

        <!-- v2.4: Integrations (CLI + MCP). -->
        <div data-cat="integrations"><IntegrationsSettings /></div>

        <!-- v4.0 Pillar 2: Agent Recipes. -->
        <div v-if="!IS_APP_STORE_BUILD" data-cat="integrations"><RecipesSettings /></div>

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.spellCheck" @change="settings.toggleSpellCheck()" />
            {{ t('settings.spellCheck') }}
          </label>
        </section>

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.focusMode" @change="settings.toggleFocusMode()" />
            {{ t('settings.focusMode') }}
          </label>
        </section>

        <section data-cat="writing">
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

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.typewriterMode" @change="settings.toggleTypewriterMode()" />
            {{ t('settings.typewriterMode') }}
          </label>
        </section>

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.vimMode" @change="settings.toggleVimMode()" />
            {{ t('settings.vimMode') }}
          </label>
        </section>

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.slashCommandsEnabled" @change="settings.toggleSlashCommandsEnabled()" />
            {{ t('settings.slashCommandsEnabled') }}
          </label>
        </section>

        <!-- v4.6 F6 — Inbox workflow -->
        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.inboxWorkflowEnabled" @change="settings.toggleInboxWorkflow()" />
            {{ t('inbox.workflowSetting') }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('inbox.workflowSettingHint') }}
          </div>
          <label v-if="settings.inboxWorkflowEnabled" style="margin-top: 8px;">
            <input type="checkbox" :checked="settings.autoAdvanceInboxAfterOrganize" @change="settings.toggleAutoAdvanceInbox()" />
            {{ t('inbox.autoAdvanceSetting') }}
          </label>
          <div v-if="settings.inboxWorkflowEnabled" style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('inbox.autoAdvanceSettingHint') }}
          </div>
        </section>

        <section data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.restoreSession" @change="settings.toggleRestoreSession()" />
            {{ t('settings.restoreSession') }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('settings.restoreSessionHint') }}
          </div>
        </section>

        <section data-cat="advanced">
          <label>{{ t('settings.startupViewMode') }}</label>
          <select
            :value="settings.startupViewMode ?? ''"
            @change="settings.setStartupViewMode((($event.target as HTMLSelectElement).value || null) as any)"
          >
            <option value="">{{ t('settings.startupViewModeLastUsed') }}</option>
            <option value="edit">Edit</option>
            <option value="liveEdit">Live edit</option>
            <option value="split">Split</option>
            <option value="preview">Preview</option>
            <option value="reading">Reading</option>
          </select>
          <p class="setting-hint">{{ t('settings.startupViewModeHint') }}</p>
        </section>

        <section data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.perWorkspaceTabs" @change="settings.togglePerWorkspaceTabs()" />
            {{ t('settings.perWorkspaceTabs') }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('settings.perWorkspaceTabsHint') }}
          </div>
        </section>

        <section data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.autoReloadExternalChanges" @change="settings.toggleAutoReloadExternalChanges()" />
            {{ t('settings.autoReloadExternalChanges') }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('settings.autoReloadExternalChangesHint') }}
          </div>
        </section>

        <section data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.autoSaveOnBlur" @change="settings.toggleAutoSaveOnBlur()" />
            {{ t('settings.autoSaveOnBlur') }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('settings.autoSaveOnBlurHint') }}
          </div>
        </section>

        <section v-if="!isMobilePlatform" data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.openFileInNewWindow" @change="settings.toggleOpenFileInNewWindow()" />
            {{ t('settings.openFileInNewWindow') }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('settings.openFileInNewWindowHint') }}
          </div>
        </section>

        <section data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.revealInFileTreeOnOpen" @change="settings.toggleRevealInFileTreeOnOpen()" />
            {{ t('settings.revealInFileTreeOnOpen') }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('settings.revealInFileTreeOnOpenHint') }}
          </div>
        </section>

        <section v-if="!isMobilePlatform && !masBuild" data-cat="advanced">
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

        <section data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.telemetryEnabled" @change="settings.toggleTelemetry()" />
            {{ t('settings.telemetry') }}
          </label>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5;">
            {{ t('settings.telemetryHint') }}
          </div>
        </section>

        <section data-cat="advanced">
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

        <section data-cat="advanced">
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

        <!-- v2.4 Integrations: HTTP capture endpoint. -->
        <div data-cat="integrations"><CaptureEndpointSettings /></div>

        <!-- v4.0: Public REST API for non-MCP clients. -->
        <div data-cat="integrations"><RestApiSettings /></div>
      </div>
      </div>
    <!-- v2.5: theme marketplace modal. Lives outside settings__body so it
         overlays the entire viewport; it self-teleports to body so closing
         settings (which unmounts DsModal) closes it too. -->
    <ThemeMarketplace
      :open="themeMarketplaceOpen"
      @close="themeMarketplaceOpen = false"
    />
  </DsModal>
</template>

<style scoped>
/* DsModal supplies the backdrop / frame / header (title + close). Zero its
   body padding so the two-column nav+body layout fills the panel edge-to-edge,
   and give the panel a fixed working height like the old shell. */
.settings-modal :deep(.ds-modal__body) {
  padding: 0;
  display: flex;
  flex-direction: column;
}
.settings__layout {
  flex: 1;
  display: flex;
  min-height: 0;
  height: min(560px, 78vh);
}
.settings__nav {
  width: 160px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-soft, var(--bg));
  display: flex;
  flex-direction: column;
  padding: 10px 6px;
  gap: 1px;
  overflow-y: auto;
}
.settings__nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: all 0.12s;
}
.settings__nav-item:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text);
}
.settings__nav-item--active {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  font-weight: 600;
}
.settings__nav-icon {
  font-size: 16px;
  line-height: 1;
}
.settings__nav-label {
  flex: 1;
}
/* v3.0 — single-source-of-truth visibility: each section/component
   gets data-cat="basics|writing|sync|integrations|export|advanced",
   the body's data-active-cat determines which subset renders. Saves
   wrapping every section in v-if. */
.settings__body[data-active-cat] > [data-cat] {
  display: none;
}
.settings__body[data-active-cat="basics"] > [data-cat="basics"],
.settings__body[data-active-cat="writing"] > [data-cat="writing"],
.settings__body[data-active-cat="sync"] > [data-cat="sync"],
.settings__body[data-active-cat="integrations"] > [data-cat="integrations"],
.settings__body[data-active-cat="export"] > [data-cat="export"],
.settings__body[data-active-cat="advanced"] > [data-cat="advanced"] {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.settings__body {
  flex: 1;
  padding: 16px 22px;
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
/* Image-upload (图床) text/password fields — match the inline-styled inputs
   used elsewhere in this panel. */
.img-field {
  padding: 6px 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  font: inherit;
  width: 100%;
  box-sizing: border-box;
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
