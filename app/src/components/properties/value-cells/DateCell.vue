<script setup lang="ts">
/** v4.6 F1 — date value cell. Renders the ISO date as a clickable trigger; a
 *  DS Popover hosts a month-grid calendar plus a direct ISO text input (Tolaria
 *  parity: you can either pick or type `YYYY-MM-DD`). Emits an ISO date string.
 *
 *  There is no DS `Calendar` primitive in the design system, so the month grid
 *  is built here from DS tokens (no raw hex / ad-hoc palette). */
import { ref, computed, watch } from 'vue';
import { DsPopover, DsInput } from '../../../ui';
import { useI18n } from '../../../i18n';

const props = defineProps<{ value: unknown }>();
const emit = defineEmits<{ update: [string] }>();

const { t } = useI18n();

const popRef = ref<InstanceType<typeof DsPopover> | null>(null);

const current = computed<string>(() => {
  const v = props.value;
  return v == null ? '' : typeof v === 'string' ? v : String(v);
});

/** Parse `YYYY-MM-DD` (ignoring any time suffix) into a local Date, or null. */
function parseIso(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// The month currently shown in the grid. Driven off the current value, falling
// back to today.
const viewMonth = ref<Date>(parseIso(current.value) ?? new Date());
const typed = ref('');

watch(
  () => props.value,
  () => {
    viewMonth.value = parseIso(current.value) ?? new Date();
  },
);

const monthLabel = computed(() =>
  viewMonth.value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
);

const weekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** The 6×7 day cells for the shown month (leading/trailing days from adjacent
 *  months are included but dimmed). */
const grid = computed(() => {
  const y = viewMonth.value.getFullYear();
  const m = viewMonth.value.getMonth();
  const first = new Date(y, m, 1);
  const startDow = first.getDay();
  const cells: { date: Date; inMonth: boolean; iso: string }[] = [];
  const start = new Date(y, m, 1 - startDow);
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ date: d, inMonth: d.getMonth() === m, iso: toIso(d) });
  }
  return cells;
});

const selectedIso = computed(() => {
  const d = parseIso(current.value);
  return d ? toIso(d) : '';
});
const todayIso = toIso(new Date());

function stepMonth(delta: number) {
  const d = viewMonth.value;
  viewMonth.value = new Date(d.getFullYear(), d.getMonth() + delta, 1);
}

function pick(iso: string) {
  if (iso !== current.value) emit('update', iso);
  popRef.value?.close();
}

function onOpen() {
  typed.value = current.value;
  viewMonth.value = parseIso(current.value) ?? new Date();
}

function commitTyped() {
  const d = parseIso(typed.value);
  if (d) pick(toIso(d));
  else popRef.value?.close();
}
</script>

<template>
  <DsPopover ref="popRef" align="start">
    <template #trigger>
      <span class="prop-value-trigger" :class="{ 'prop-value-trigger--empty': current === '' }" @click="onOpen">
        {{ current || '—' }}
      </span>
    </template>

    <div class="prop-cal">
      <DsInput
        v-model="typed"
        size="sm"
        placeholder="YYYY-MM-DD"
        @keydown.enter.prevent="commitTyped"
        @keydown.esc.prevent="popRef?.close()"
      />
      <div class="prop-cal__head">
        <button type="button" class="prop-cal__nav" @click="stepMonth(-1)" :aria-label="t('inspector.prevMonth')">‹</button>
        <span class="prop-cal__month">{{ monthLabel }}</span>
        <button type="button" class="prop-cal__nav" @click="stepMonth(1)" :aria-label="t('inspector.nextMonth')">›</button>
      </div>
      <div class="prop-cal__grid">
        <span v-for="(w, i) in weekdays" :key="`w${i}`" class="prop-cal__dow">{{ w }}</span>
        <button
          v-for="cell in grid"
          :key="cell.iso"
          type="button"
          class="prop-cal__day"
          :class="{
            'prop-cal__day--muted': !cell.inMonth,
            'prop-cal__day--today': cell.iso === todayIso,
            'prop-cal__day--selected': cell.iso === selectedIso,
          }"
          @click="pick(cell.iso)"
        >{{ cell.date.getDate() }}</button>
      </div>
      <div class="prop-cal__foot">
        <button type="button" class="prop-cal__today" @click="pick(todayIso)">{{ t('inspector.today') }}</button>
      </div>
    </div>
  </DsPopover>
</template>

<style scoped>
.prop-cal {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  width: 224px;
}
.prop-cal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.prop-cal__month {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.prop-cal__nav {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  width: 24px;
  height: 24px;
  border-radius: var(--r-sm);
}
.prop-cal__nav:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.prop-cal__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.prop-cal__dow {
  text-align: center;
  font-size: 10px;
  color: var(--text-muted);
  padding-bottom: 2px;
}
.prop-cal__day {
  aspect-ratio: 1;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 11px;
  border-radius: var(--r-sm);
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.prop-cal__day:hover {
  background: var(--bg-hover);
}
.prop-cal__day:focus-visible,
.prop-cal__nav:focus-visible,
.prop-cal__today:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.prop-cal__day--muted {
  color: var(--text-muted);
  opacity: 0.5;
}
.prop-cal__day--today {
  box-shadow: inset 0 0 0 1px var(--border);
}
.prop-cal__day--selected {
  background: var(--accent);
  color: var(--accent-fg);
}
.prop-cal__day--selected:hover {
  background: var(--accent);
}
.prop-cal__foot {
  display: flex;
  justify-content: flex-end;
}
.prop-cal__today {
  background: transparent;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
}
.prop-cal__today:hover {
  text-decoration: underline;
}
</style>
