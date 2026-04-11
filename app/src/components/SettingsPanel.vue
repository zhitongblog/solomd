<script setup lang="ts">
import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';

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
        <h2>Settings</h2>
        <button class="settings__close" @click="emit('close')">×</button>
      </header>
      <div class="settings__body">
        <section>
          <label>Theme</label>
          <div class="row">
            <button :class="{ active: settings.theme === 'light' }" @click="settings.setTheme('light')">Light</button>
            <button :class="{ active: settings.theme === 'dark' }" @click="settings.setTheme('dark')">Dark</button>
          </div>
        </section>

        <section>
          <label>Font Family</label>
          <select :value="settings.fontFamily" @change="settings.setFontFamily(($event.target as HTMLSelectElement).value)">
            <option v-for="f in fontFamilies" :key="f.label" :value="f.value">{{ f.label }}</option>
          </select>
        </section>

        <section>
          <label>Font Size: {{ settings.fontSize }}px</label>
          <input
            type="range"
            min="10"
            max="28"
            :value="settings.fontSize"
            @input="settings.setFontSize(+($event.target as HTMLInputElement).value)"
          />
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.wordWrap" @change="settings.toggleWordWrap()" />
            Word Wrap
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.showLineNumbers" @change="settings.toggleLineNumbers()" />
            Line Numbers
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.livePreview" @change="settings.toggleLivePreview()" />
            Live Preview (Markdown) — hide markers off-line, render headings, bold etc.
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.showOutline" @change="settings.toggleOutline()" />
            Show Outline (Markdown)
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.showFileTree" @change="settings.toggleFileTree()" />
            Show File Tree
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.spellCheck" @change="settings.toggleSpellCheck()" />
            Spell Check (browser)
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.focusMode" @change="settings.toggleFocusMode()" />
            Focus Mode — dim non-active lines
          </label>
        </section>

        <section>
          <label>
            <input type="checkbox" :checked="settings.typewriterMode" @change="settings.toggleTypewriterMode()" />
            Typewriter Mode — keep cursor centered
          </label>
        </section>

        <section>
          <label>Custom CSS Theme</label>
          <div class="row" style="gap: 8px; align-items: center;">
            <button @click="pickCustomCss">Pick .css file…</button>
            <button v-if="settings.customCssPath" @click="settings.setCustomCssPath('')">Clear</button>
          </div>
          <div v-if="settings.customCssPath" style="font-size: 11px; color: var(--text-faint); word-break: break-all; margin-top: 4px;">
            {{ settings.customCssPath }}
          </div>
        </section>

        <section>
          <label>File Association</label>
          <div class="row" style="gap: 8px; align-items: center;">
            <button
              class="primary-btn"
              :disabled="settingDefault"
              @click="setAsDefault"
            >
              {{ settingDefault ? 'Setting…' : '⭐ Set SoloMD as default Markdown editor' }}
            </button>
          </div>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 6px; line-height: 1.5;">
            Registers SoloMD as the default app for .md / .markdown / .mdown / .mkd files. On Windows, also adds SoloMD to the "Open with" menu. On Linux requires <code>xdg-utils</code>.
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
