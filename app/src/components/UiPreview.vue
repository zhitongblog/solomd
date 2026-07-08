<script setup lang="ts">
/* Dev-only UI gallery. Renders every Ds* primitive in every variant so the
 * token layer can be eyeballed across light/dark and all 8 themes. Gated in
 * App.vue behind `?uikit`. Literal English labels are fine here — it's a dev
 * tool, not user-facing surface. */
import { ref } from 'vue';
import {
  DsButton,
  DsInput,
  DsTextarea,
  DsSelect,
  DsDropdown,
  DsModal,
  DsPopover,
  DsChip,
  DsPanel,
  DsListRow,
  DsTooltip,
  DsTabs,
} from '../ui';

const THEMES = [
  'light',
  'dark',
  'nord',
  'solarized-light',
  'solarized-dark',
  'monokai',
  'github-light',
  'dracula',
] as const;

const theme = ref<(typeof THEMES)[number]>('light');

function applyTheme(name: string) {
  theme.value = name as (typeof THEMES)[number];
  if (name === 'light') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', name);
}

function setMode(mode: 'light' | 'dark') {
  applyTheme(mode);
}

const inputVal = ref('Hello world');
const areaVal = ref('Multi-line\ntext area');
const selectVal = ref('md');
const selectOpts = [
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Medium' },
  { value: 'lg', label: 'Large', disabled: true },
];

const dropItems = [
  { value: 'rename', label: 'Rename' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'delete', label: 'Delete', disabled: true },
];
const lastPicked = ref('—');

const modalOpen = ref(false);

const tab = ref('one');
const tabs = [
  { value: 'one', label: 'Overview' },
  { value: 'two', label: 'Details' },
  { value: 'three', label: 'Disabled', disabled: true },
];

const selectedRow = ref('b');
const chips = ref(['design', 'tokens', 'ui']);
function removeChip(c: string) {
  chips.value = chips.value.filter((x) => x !== c);
}
</script>

<template>
  <div class="uikit">
    <header class="uikit__bar">
      <strong class="uikit__brand">SoloMD UI Kit</strong>
      <div class="uikit__controls">
        <DsButton size="sm" variant="subtle" @click="setMode('light')">Light</DsButton>
        <DsButton size="sm" variant="subtle" @click="setMode('dark')">Dark</DsButton>
        <DsDropdown :items="THEMES.map((t) => ({ value: t, label: t }))" @select="applyTheme">
          <template #trigger>
            <span class="uikit__triggerbtn">Theme: {{ theme }} ▾</span>
          </template>
        </DsDropdown>
      </div>
    </header>

    <main class="uikit__body">
      <section class="uikit__sec">
        <h3>Buttons</h3>
        <div class="row">
          <DsButton variant="primary">Primary</DsButton>
          <DsButton variant="subtle">Subtle</DsButton>
          <DsButton variant="ghost">Ghost</DsButton>
          <DsButton variant="danger">Danger</DsButton>
        </div>
        <div class="row">
          <DsButton variant="primary" size="sm">Primary sm</DsButton>
          <DsButton variant="subtle" size="sm">Subtle sm</DsButton>
          <DsButton variant="primary" loading>Loading</DsButton>
          <DsButton variant="subtle" disabled>Disabled</DsButton>
        </div>
      </section>

      <section class="uikit__sec">
        <h3>Inputs</h3>
        <div class="grid2">
          <DsInput v-model="inputVal" placeholder="Type here" />
          <DsInput placeholder="Disabled" disabled />
          <DsSelect v-model="selectVal" :options="selectOpts" />
          <DsInput v-model="inputVal" size="sm" placeholder="Small" />
        </div>
        <DsTextarea v-model="areaVal" :rows="3" />
      </section>

      <section class="uikit__sec">
        <h3>Overlays</h3>
        <div class="row">
          <DsDropdown :items="dropItems" @select="lastPicked = $event">
            <template #trigger>
              <span class="uikit__triggerbtn">Dropdown ▾</span>
            </template>
          </DsDropdown>
          <span class="muted">picked: {{ lastPicked }}</span>

          <DsPopover>
            <template #trigger>
              <span class="uikit__triggerbtn">Popover</span>
            </template>
            <div style="width: 180px">
              <strong>Popover content</strong>
              <p class="muted">Anchored, Esc to close.</p>
            </div>
          </DsPopover>

          <DsTooltip label="I am a tooltip">
            <span class="uikit__triggerbtn">Hover me</span>
          </DsTooltip>

          <DsButton variant="primary" @click="modalOpen = true">Open modal</DsButton>
        </div>
      </section>

      <section class="uikit__sec">
        <h3>Chips</h3>
        <div class="row">
          <DsChip v-for="c in chips" :key="c" removable @remove="removeChip(c)">{{ c }}</DsChip>
          <DsChip color="#38a169">success</DsChip>
          <DsChip color="#e53e3e">danger</DsChip>
          <DsChip color="#ff9f40">accent</DsChip>
        </div>
      </section>

      <section class="uikit__sec">
        <h3>Tabs</h3>
        <DsTabs v-model="tab" :tabs="tabs">
          <template #default="{ active }">
            <p class="muted">Active tab: {{ active }}</p>
          </template>
        </DsTabs>
      </section>

      <section class="uikit__sec uikit__sec--split">
        <div>
          <h3>List rows</h3>
          <DsListRow
            v-for="r in ['a', 'b', 'c']"
            :key="r"
            :selected="selectedRow === r"
            @click="selectedRow = r"
          >
            <template #leading>•</template>
            Row {{ r.toUpperCase() }}
            <template #trailing>↵</template>
          </DsListRow>
        </div>
        <div class="uikit__panelbox">
          <h3>Panel</h3>
          <div style="height: 180px; border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden">
            <DsPanel title="Backlinks" grip @close="() => {}">
              <div style="padding: 12px">
                <p class="muted">Panel body content goes here.</p>
              </div>
            </DsPanel>
          </div>
        </div>
      </section>
    </main>

    <DsModal v-model="modalOpen" title="Example modal">
      <p>This modal teleports, traps focus, and closes on Esc / backdrop.</p>
      <DsInput placeholder="Focus me first" />
      <template #footer>
        <DsButton variant="ghost" @click="modalOpen = false">Cancel</DsButton>
        <DsButton variant="primary" @click="modalOpen = false">Confirm</DsButton>
      </template>
    </DsModal>
  </div>
</template>

<style scoped>
.uikit {
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui);
}
.uikit__bar {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-5);
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.uikit__brand {
  font-size: 14px;
}
.uikit__controls {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.uikit__body {
  max-width: 880px;
  margin: 0 auto;
  padding: var(--sp-6) var(--sp-5);
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.uikit__sec h3 {
  margin: 0 0 var(--sp-3);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.uikit__sec--split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-5);
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.muted {
  color: var(--text-muted);
  font-size: 12px;
}
.uikit__triggerbtn {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 var(--sp-3);
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
.uikit__triggerbtn:hover {
  background: var(--bg-hover);
}
</style>
