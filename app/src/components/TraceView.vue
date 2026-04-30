<script setup lang="ts">
/**
 * v4.0 Pillar 3 — Agent Trace View.
 *
 * Renders one agent run's `trace.jsonl` as a vertical column of collapsible
 * step cards. Used by the Panel's history tab AND the Recipes Settings
 * page to inspect a previous run.
 *
 * Pairing logic:
 *   - `model_call` + `model_done` (consecutive, same run): merged into one
 *     "model turn" card showing elapsed ms + token counts.
 *   - `tool_call` + `tool_result` (matched by `tool_call_id`): merged into
 *     one "tool" card with three tabs (args / result / error).
 *
 * Replay button: emits `replay` with the step's `seq`. The parent panel
 * (P1) wires this into `agentTrace.replayFrom` + `ai_chat`. We DO NOT
 * mutate panel state here — the boundary between P3 (this file) and P1
 * (the panel) goes through the event.
 *
 * Cost breakdown: tokens × per-1k rate from `costRateFor()`. The rate
 * table is conservative and clearly defaults to $0 for unknown providers
 * — better to show "—" than fabricate a number.
 *
 * Styling: same CSS variables as the rest of the app (--bg, --border etc.).
 *
 * Props:
 *   workspace: absolute path of the workspace
 *   run_id:    the run id under .solomd/agent-runs/
 *   live?:     true while the run is still streaming; we re-fetch every
 *              2s so the user sees new steps appear. Off = static read.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useAgentTraceStore, type TraceLine } from '../stores/agentTrace';

const props = defineProps<{
  workspace: string;
  runId: string;
  live?: boolean;
}>();

const emit = defineEmits<{
  (e: 'replay', payload: { seq: number; runId: string }): void;
  (e: 'close'): void;
}>();

const store = useAgentTraceStore();
const expanded = ref<Set<number>>(new Set());
const error = ref<string | null>(null);
let pollHandle: ReturnType<typeof setInterval> | null = null;

const lines = computed<TraceLine[]>(() => {
  const key = `${props.workspace}::${props.runId}`;
  return store.cache[key]?.lines ?? [];
});

/** Logical "card" — either a single line or a paired group. */
interface Card {
  /** Anchor seq — used as v-for key + the seq passed to the replay event. */
  seq: number;
  primary: TraceLine;
  /** Optional pair (model_done / tool_result). */
  pair?: TraceLine;
  /** Pre-computed per-card display data — kept in the model so the
   *  template stays readable. */
  icon: string;
  title: string;
  subtitle: string;
  ts: number;
}

const cards = computed<Card[]>(() => {
  const ls = lines.value;
  const out: Card[] = [];
  // Index tool_results by tool_call_id for cheap pairing — model_call /
  // model_done matching is positional (next line of the right kind).
  const toolResultByCallId = new Map<string, TraceLine>();
  for (const l of ls) {
    if (l.kind === 'tool_result') {
      const id = (l as Record<string, unknown>).tool_call_id;
      if (typeof id === 'string') toolResultByCallId.set(id, l);
    }
  }
  const consumed = new Set<number>();
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (consumed.has(l.seq)) continue;
    if (l.kind === 'tool_result') {
      // A tool_result without a matching tool_call (out of order, or
      // partially-truncated trace). Render standalone.
      out.push(simpleCard(l));
      continue;
    }
    if (l.kind === 'tool_call') {
      const callId = (l as Record<string, unknown>).tool_call_id;
      const result =
        typeof callId === 'string' ? toolResultByCallId.get(callId) : undefined;
      if (result) consumed.add(result.seq);
      out.push(toolPairCard(l, result));
      continue;
    }
    if (l.kind === 'model_call') {
      // Find the next model_done with no model_call in between.
      let pair: TraceLine | undefined;
      for (let j = i + 1; j < ls.length; j++) {
        if (ls[j].kind === 'model_call') break;
        if (ls[j].kind === 'model_done') {
          pair = ls[j];
          break;
        }
      }
      if (pair) consumed.add(pair.seq);
      out.push(modelPairCard(l, pair));
      continue;
    }
    out.push(simpleCard(l));
  }
  return out;
});

function simpleCard(l: TraceLine): Card {
  return {
    seq: l.seq,
    primary: l,
    icon: iconFor(l.kind),
    title: titleFor(l),
    subtitle: subtitleFor(l),
    ts: l.ts,
  };
}

function modelPairCard(call: TraceLine, done?: TraceLine): Card {
  const tokensIn = done ? num(done, 'tokens_in') : 0;
  const tokensOut = done ? num(done, 'tokens_out') : 0;
  const elapsed = done ? Math.max(0, done.ts - call.ts) : null;
  const provider = str(call, 'provider') ?? '?';
  const model = str(call, 'model') ?? '?';
  const subtitle = done
    ? `${provider}/${model} · ${elapsed}ms · ${tokensIn} in / ${tokensOut} out`
    : `${provider}/${model} · streaming…`;
  return {
    seq: call.seq,
    primary: call,
    pair: done,
    icon: '🧠',
    title: done ? 'Model turn' : 'Model call (in flight)',
    subtitle,
    ts: call.ts,
  };
}

function toolPairCard(call: TraceLine, result?: TraceLine): Card {
  const tool = str(call, 'tool') ?? 'tool';
  const args = (call as Record<string, unknown>).args;
  const argHint = firstArg(args);
  const truncated = result && (result as Record<string, unknown>).truncated === true;
  const errored = result && typeof (result as Record<string, unknown>).error === 'string';
  let subtitle = argHint ? `${tool}(${argHint})` : tool;
  if (errored) subtitle += ' · error';
  else if (truncated) subtitle += ' · truncated';
  else if (!result) subtitle += ' · pending';
  return {
    seq: call.seq,
    primary: call,
    pair: result,
    icon: errored ? '❌' : '🔧',
    title: 'Tool call',
    subtitle,
    ts: call.ts,
  };
}

function iconFor(kind: string): string {
  switch (kind) {
    case 'run_started':
      return '▶️';
    case 'run_ended':
      return '⏹';
    case 'model_call':
    case 'model_done':
    case 'model_chunk':
      return '🧠';
    case 'tool_call':
    case 'tool_result':
      return '🔧';
    case 'git_commit':
      return '💾';
    case 'prompt':
      return '💬';
    case 'note':
      return '📝';
    default:
      return '•';
  }
}

function titleFor(l: TraceLine): string {
  switch (l.kind) {
    case 'run_started':
      return `Run started · ${str(l, 'run_kind') ?? 'panel'}`;
    case 'run_ended':
      return `Run ended · ${str(l, 'status') ?? 'unknown'}`;
    case 'prompt':
      return `Prompt (${str(l, 'role') ?? 'user'})`;
    case 'note':
      return 'Note';
    case 'git_commit':
      return 'Git commit';
    case 'model_chunk':
      return 'Model chunk';
    default:
      return l.kind;
  }
}

function subtitleFor(l: TraceLine): string {
  switch (l.kind) {
    case 'run_started':
      return `${str(l, 'provider') ?? '?'}/${str(l, 'model') ?? '?'}${
        str(l, 'replayed_from') ? ` · replay of ${str(l, 'replayed_from')}` : ''
      }`;
    case 'run_ended':
      return `${num(l, 'tokens_in_total')} in · ${num(l, 'tokens_out_total')} out · $${(num(
        l,
        'cost_usd_estimate',
      ) ?? 0).toFixed(4)}`;
    case 'prompt': {
      const c = str(l, 'content') ?? '';
      return c.length > 80 ? c.slice(0, 80) + '…' : c;
    }
    case 'note':
      return str(l, 'text') ?? '';
    case 'git_commit':
      return `${str(l, 'branch') ?? '?'} @ ${(str(l, 'sha') ?? '').slice(0, 7)} — ${
        str(l, 'summary') ?? ''
      }`;
    default:
      return '';
  }
}

function firstArg(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';
  const first = keys[0];
  const v = obj[first];
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length > 32) s = s.slice(0, 32) + '…';
  return `${first}: ${s}`;
}

function str(l: TraceLine | undefined, key: string): string | null {
  if (!l) return null;
  const v = (l as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

function num(l: TraceLine | undefined, key: string): number {
  if (!l) return 0;
  const v = (l as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : 0;
}

// Cost breakdown: per-1k token rates. Conservative defaults; unknown
// providers fall through to 0 (we render "—" rather than lying).
const COST_PER_1K: Record<string, { in: number; out: number }> = {
  // Anthropic — claude-sonnet-4-x baseline.
  anthropic: { in: 0.003, out: 0.015 },
  // OpenAI — gpt-4.x family rough average.
  openai: { in: 0.003, out: 0.012 },
  // Google Gemini Pro — public list price.
  gemini: { in: 0.00125, out: 0.005 },
  xai: { in: 0.005, out: 0.015 },
  mistral: { in: 0.002, out: 0.006 },
  groq: { in: 0.0005, out: 0.0008 },
  deepseek: { in: 0.00027, out: 0.0011 },
  qwen: { in: 0.0004, out: 0.0012 },
  glm: { in: 0.0005, out: 0.0015 },
  kimi: { in: 0.0006, out: 0.0024 },
  volcengine: { in: 0.0004, out: 0.0012 },
  siliconflow: { in: 0.0004, out: 0.0012 },
  openrouter: { in: 0.003, out: 0.012 },
  // Local models — no cost.
  ollama: { in: 0, out: 0 },
};

function costRateFor(provider: string | null | undefined): { in: number; out: number } | null {
  if (!provider) return null;
  return COST_PER_1K[provider] ?? null;
}

const totals = computed(() => {
  let tokensIn = 0;
  let tokensOut = 0;
  let provider: string | null = null;
  // v4.0 — the Rust pricing module writes a real `cost_usd_estimate`
  // into the `run_ended` trace line. When it's present and > 0 we use
  // that authoritative number; otherwise we fall back to the on-the-fly
  // per-1k rate table below for older runs that predate the fix.
  let costFromBackend: number | null = null;
  for (const l of lines.value) {
    if (l.kind === 'run_started') provider = str(l, 'provider');
    if (l.kind === 'model_done') {
      tokensIn += num(l, 'tokens_in');
      tokensOut += num(l, 'tokens_out');
    }
    if (l.kind === 'run_ended') {
      // Trust totals from run_ended when present.
      const t = num(l, 'tokens_in_total');
      const o = num(l, 'tokens_out_total');
      if (t > 0) tokensIn = t;
      if (o > 0) tokensOut = o;
      const c = num(l, 'cost_usd_estimate');
      if (c > 0) costFromBackend = c;
    }
  }
  let cost: number | null = costFromBackend;
  if (cost === null) {
    const rate = costRateFor(provider);
    cost =
      rate === null
        ? null
        : (tokensIn / 1000) * rate.in + (tokensOut / 1000) * rate.out;
  }
  return {
    tokensIn,
    tokensOut,
    provider: provider ?? '?',
    cost,
  };
});

function toggle(seq: number) {
  const next = new Set(expanded.value);
  if (next.has(seq)) next.delete(seq);
  else next.add(seq);
  expanded.value = next;
}

function fmtAbs(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function fmtRel(ts: number): string {
  const delta = (Date.now() - ts) / 1000;
  if (delta < 60) return `${Math.round(delta)}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

function fmtCost(c: number | null): string {
  if (c === null) return '—';
  return `$${c.toFixed(4)}`;
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

async function reload() {
  try {
    await store.loadTrace(props.workspace, props.runId, true);
    error.value = null;
  } catch (e) {
    error.value = String(e);
  }
}

function onReplay(seq: number) {
  emit('replay', { seq, runId: props.runId });
}

watch(
  () => [props.workspace, props.runId, props.live],
  () => {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
    reload();
    if (props.live) {
      pollHandle = setInterval(reload, 2000);
    }
  },
);

onMounted(() => {
  reload();
  if (props.live) pollHandle = setInterval(reload, 2000);
});

onUnmounted(() => {
  if (pollHandle) clearInterval(pollHandle);
});
</script>

<template>
  <div class="trace-view">
    <header class="trace-header">
      <div class="trace-title">
        <span>Run</span>
        <code>{{ props.runId }}</code>
      </div>
      <button v-if="$slots.close === undefined" class="trace-close" type="button" @click="emit('close')">
        ×
      </button>
    </header>

    <div v-if="error" class="trace-error">{{ error }}</div>
    <div v-if="!error && lines.length === 0" class="trace-empty">
      No steps yet.
    </div>

    <ol class="trace-list">
      <li
        v-for="card in cards"
        :key="card.seq"
        class="trace-card"
        :class="{ 'is-open': expanded.has(card.seq) }"
      >
        <button class="trace-card-head" type="button" @click="toggle(card.seq)">
          <span class="trace-card-icon" aria-hidden="true">{{ card.icon }}</span>
          <span class="trace-card-body">
            <span class="trace-card-title">
              <span class="trace-card-seq">#{{ card.seq }}</span>
              {{ card.title }}
            </span>
            <span class="trace-card-subtitle">{{ card.subtitle }}</span>
          </span>
          <span class="trace-card-ts" :title="fmtAbs(card.ts)">{{ fmtRel(card.ts) }}</span>
        </button>
        <div v-if="expanded.has(card.seq)" class="trace-card-body-open">
          <pre class="trace-payload">{{ prettyJson(card.primary) }}</pre>
          <pre v-if="card.pair" class="trace-payload trace-payload-paired">{{ prettyJson(card.pair) }}</pre>
          <div class="trace-card-actions">
            <button type="button" class="trace-action" @click="onReplay(card.seq)">
              Replay from this step
            </button>
          </div>
        </div>
      </li>
    </ol>

    <footer class="trace-footer">
      <div class="trace-totals">
        <span><strong>{{ totals.tokensIn }}</strong> in / <strong>{{ totals.tokensOut }}</strong> out</span>
        <span class="trace-totals-cost">{{ fmtCost(totals.cost) }}</span>
        <span class="trace-totals-provider">{{ totals.provider }}</span>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.trace-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
}
.trace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
}
.trace-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}
.trace-title code {
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 12px;
  color: var(--text);
}
.trace-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}
.trace-close:hover {
  background: var(--border);
  color: var(--text);
}
.trace-error {
  margin: 8px 12px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: #b00;
  background: var(--bg-soft);
  font-size: 12px;
}
.trace-empty {
  padding: 20px 12px;
  color: var(--text-muted);
  text-align: center;
}
.trace-list {
  list-style: none;
  margin: 0;
  padding: 8px 0;
  flex: 1;
  overflow-y: auto;
}
.trace-card {
  border-top: 1px solid var(--border);
}
.trace-card:first-child {
  border-top: none;
}
.trace-card-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.trace-card-head:hover {
  background: var(--bg-soft);
}
.trace-card.is-open .trace-card-head {
  background: var(--bg-soft);
}
.trace-card-icon {
  flex: 0 0 auto;
  font-size: 14px;
  line-height: 18px;
}
.trace-card-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.trace-card-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-weight: 500;
}
.trace-card-seq {
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 11px;
  color: var(--text-muted);
}
.trace-card-subtitle {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trace-card-ts {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.trace-card-body-open {
  padding: 4px 12px 12px 36px;
}
.trace-payload {
  margin: 0 0 8px 0;
  padding: 8px 10px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
  max-height: 240px;
  overflow: auto;
}
.trace-payload-paired {
  border-left: 2px solid var(--accent);
}
.trace-card-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.trace-action {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.trace-action:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.trace-footer {
  border-top: 1px solid var(--border);
  background: var(--bg-soft);
  padding: 8px 12px;
}
.trace-totals {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}
.trace-totals strong {
  color: var(--text);
  font-weight: 600;
}
.trace-totals-cost {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.trace-totals-provider {
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 11px;
}
</style>
