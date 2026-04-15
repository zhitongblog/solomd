<script setup lang="ts">
import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { themeLabels } from '../lib/themes';
import { useI18n } from '../i18n';
import type { Theme } from '../types';

const { t } = useI18n();

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
const toasts = useToastsStore();

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

const fontFamilies = [
  { label: 'JetBrains Mono', value: '"JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, monospace' },
  { label: 'SF Mono', value: '"SF Mono", Menlo, monospace' },
  { label: 'Menlo', value: 'Menlo, Consolas, monospace' },
  { label: 'Consolas', value: 'Consolas, "Courier New", monospace' },
  { label: 'System UI', value: '-apple-system, "Segoe UI", Inter, Roboto, system-ui, sans-serif' },
];
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
          <select :value="settings.fontFamily" @change="settings.setFontFamily(($event.target as HTMLSelectElement).value)">
            <option v-for="f in fontFamilies" :key="f.label" :value="f.value">{{ f.label }}</option>
          </select>
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
            <input type="checkbox" :checked="settings.showOutline" @change="settings.toggleOutline()" />
            {{ t('settings.showOutline') }}
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.showFileTree" @change="settings.toggleFileTree()" />
            {{ t('settings.showFileTree') }}
          </label>
        </section>

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
          <label>{{ t('settings.customCss') }}</label>
          <div class="row" style="gap: 8px; align-items: center;">
            <button @click="pickCustomCss">{{ t('settings.pickCss') }}</button>
            <button v-if="settings.customCssPath" @click="settings.setCustomCssPath('')">{{ t('settings.clear') }}</button>
          </div>
          <div v-if="settings.customCssPath" style="font-size: 11px; color: var(--text-faint); word-break: break-all; margin-top: 4px;">
            {{ settings.customCssPath }}
          </div>
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
      </div>
    </div>
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
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 8px;
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
