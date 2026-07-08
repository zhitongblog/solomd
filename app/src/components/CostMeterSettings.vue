<script setup lang="ts">
/**
 * v4.0 BYOK cost meter — Settings → AI subsection.
 *
 * Per-provider cumulative tokens + USD totals across every panel chat and
 * scheduled recipe. Off by default; opt-in. Resetting starts the window
 * over from "now"; the per-provider rows follow what `pricing::estimate_cost_usd`
 * already writes into each `agent-runs/<id>/meta.json`.
 */
import { computed, onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

interface ProviderTotals {
  input: number;
  output: number;
  cost_usd: number;
  runs: number;
}

interface CostMeter {
  enabled: boolean;
  since_epoch: number;
  providers: Record<string, ProviderTotals>;
}

const { t } = useI18n();
const toasts = useToastsStore();

const meter = ref<CostMeter>({
  enabled: false,
  since_epoch: 0,
  providers: {},
});

async function refresh() {
  try {
    meter.value = await invoke<CostMeter>('cost_meter_get');
  } catch (e) {
    // Match the toast pattern used by onToggleEnabled / onReset below —
    // a silent console.warn means the user has no idea why the table is
    // stale after they hit "Refresh".
    toasts.error(t('cost.refreshFailed', { err: String(e) }));
  }
}

async function onToggleEnabled() {
  const next = !meter.value.enabled;
  try {
    meter.value = await invoke<CostMeter>('cost_meter_set_enabled', {
      enabled: next,
    });
    toasts.info(next ? t('cost.enabled') : t('cost.disabled'));
  } catch (e) {
    toasts.error(`${e}`);
  }
}

async function onReset() {
  try {
    meter.value = await invoke<CostMeter>('cost_meter_reset');
    toasts.success(t('cost.resetDone'));
  } catch (e) {
    toasts.error(`${e}`);
  }
}

const sinceLabel = computed(() => {
  if (!meter.value.since_epoch) return '—';
  const d = new Date(meter.value.since_epoch * 1000);
  return d.toLocaleString();
});

const rows = computed(() => {
  return Object.entries(meter.value.providers)
    .map(([name, t]) => ({ name, ...t }))
    .sort((a, b) => b.cost_usd - a.cost_usd || b.runs - a.runs);
});

const totalCost = computed(() => rows.value.reduce((s, r) => s + r.cost_usd, 0));
const totalIn = computed(() => rows.value.reduce((s, r) => s + r.input, 0));
const totalOut = computed(() => rows.value.reduce((s, r) => s + r.output, 0));
const totalRuns = computed(() => rows.value.reduce((s, r) => s + r.runs, 0));

function fmtUsd(n: number): string {
  // Cost estimates are dominated by sub-cent runs. Show 4 decimals so a
  // 0.0003 cost doesn't render as "$0.00".
  return `$${n.toFixed(4)}`;
}

function fmtTok(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

onMounted(refresh);
</script>

<template>
  <section class="cost">
    <div class="cost__head">
      <h4 class="cost__heading">{{ t('cost.heading') }}</h4>
      <label class="cost__toggle">
        <input
          type="checkbox"
          :checked="meter.enabled"
          @change="onToggleEnabled"
        />
        <span>{{ t('cost.enable') }}</span>
      </label>
    </div>
    <p class="cost__hint">{{ t('cost.hint') }}</p>

    <div v-if="meter.enabled" class="cost__body">
      <div class="cost__since">
        {{ t('cost.since', { ts: sinceLabel }) }}
        <button class="cost__btn" @click="refresh">{{ t('cost.refresh') }}</button>
        <button class="cost__btn" @click="onReset">{{ t('cost.reset') }}</button>
      </div>

      <table v-if="rows.length" class="cost__table">
        <thead>
          <tr>
            <th>{{ t('cost.provider') }}</th>
            <th class="cost__num">{{ t('cost.runs') }}</th>
            <th class="cost__num">{{ t('cost.input') }}</th>
            <th class="cost__num">{{ t('cost.output') }}</th>
            <th class="cost__num">{{ t('cost.cost') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.name">
            <td>{{ r.name }}</td>
            <td class="cost__num">{{ r.runs }}</td>
            <td class="cost__num">{{ fmtTok(r.input) }}</td>
            <td class="cost__num">{{ fmtTok(r.output) }}</td>
            <td class="cost__num">{{ fmtUsd(r.cost_usd) }}</td>
          </tr>
          <tr class="cost__total">
            <td>{{ t('cost.total') }}</td>
            <td class="cost__num">{{ totalRuns }}</td>
            <td class="cost__num">{{ fmtTok(totalIn) }}</td>
            <td class="cost__num">{{ fmtTok(totalOut) }}</td>
            <td class="cost__num">{{ fmtUsd(totalCost) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="cost__empty">{{ t('cost.empty') }}</p>
    </div>
  </section>
</template>

<style scoped>
.cost {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary, transparent);
}
.cost__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.cost__heading {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.cost__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.cost__hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
}
.cost__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}
.cost__since {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted);
}
.cost__btn {
  font-size: 11px;
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  cursor: pointer;
}
.cost__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.cost__table th,
.cost__table td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
.cost__num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono, ui-monospace, monospace);
}
.cost__total td {
  font-weight: 600;
  border-top: 1px solid var(--border);
}
.cost__empty {
  margin: 4px 0;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
