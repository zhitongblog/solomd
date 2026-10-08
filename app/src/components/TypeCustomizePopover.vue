<script setup lang="ts">
/**
 * F2 — Type customize popover.
 *
 * Live editor for a single type-definition note's presentation metadata:
 * icon (curated grid), color (6 accent swatches), order (stepper),
 * sidebar_label, pinned properties (multiselect from member frontmatter
 * keys), and template. On save it patches ONLY the definition note's
 * frontmatter via the types store (frontmatter splice — body bytes
 * preserved). If the type has no definition note yet, the store creates one.
 *
 * i18n keys (en.ts): types.customize, types.iconLabel, types.colorLabel,
 *   types.orderLabel, types.sidebarLabelLabel, types.pinnedLabel,
 *   types.pinnedEmpty, types.templateLabel, types.save, types.cancel,
 *   types.patchFailed
 */
import { ref, watch, computed } from 'vue';
import Icons from './Icons.vue';
import '../styles/panels.css';
import { useTypesStore } from '../stores/types';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import { TYPE_COLORS, type TypeColorKey } from '../lib/types-registry';

const props = defineProps<{
  open: boolean;
  /** Canonical type name being edited. */
  typeName: string;
  /** Anchor position (viewport px) — popover opens near the section header. */
  anchor: { x: number; y: number } | null;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const types = useTypesStore();
const toasts = useToastsStore();
const { t } = useI18n();

/** Curated icon keys backed by Icons.vue's `type-*` glyphs. */
const ICON_CHOICES = [
  'type-generic',
  'type-project',
  'type-person',
  'type-meeting',
  'type-idea',
  'type-book',
];

const icon = ref<string>('type-generic');
const color = ref<TypeColorKey | null>(null);
const order = ref<number | null>(null);
const sidebarLabel = ref<string>('');
const pinned = ref<string[]>([]);
const template = ref<string>('');
const busy = ref(false);

/** Property keys available across this type's members. */
const availableProps = computed(() => types.propertyKeysOf(props.typeName));

/** Hydrate fields from the current section/def whenever the popover opens. */
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const sec = types.sectionOf(props.typeName);
    const def = types.typeDefs.find(
      (d) => d.name.toLowerCase() === props.typeName.toLowerCase(),
    );
    icon.value = def?.icon || sec?.icon || 'type-generic';
    color.value = def?.color ?? sec?.color ?? null;
    order.value = def?.order ?? null;
    sidebarLabel.value = def?.sidebarLabel ?? '';
    pinned.value = [...(def?.pinned ?? sec?.pinned ?? [])];
    template.value = def?.template ?? '';
    busy.value = false;
  },
  { immediate: true },
);

function togglePinned(key: string) {
  const i = pinned.value.indexOf(key);
  if (i >= 0) pinned.value.splice(i, 1);
  else pinned.value.push(key);
}

const popoverStyle = computed(() => {
  if (!props.anchor) return {};
  // Clamp into the viewport with a small margin.
  const x = Math.min(props.anchor.x, window.innerWidth - 320);
  const y = Math.min(props.anchor.y, window.innerHeight - 360);
  return { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` };
});

async function save() {
  if (busy.value) return;
  busy.value = true;
  try {
    await types.patchTypeDef(props.typeName, {
      icon: icon.value || undefined,
      color: color.value ?? undefined,
      order: order.value ?? undefined,
      sidebar_label: sidebarLabel.value.trim() || undefined,
      pinned: pinned.value.length ? pinned.value : undefined,
      template: template.value.trim() || undefined,
    });
    emit('close');
  } catch (e) {
    toasts.error(t('types.patchFailed', { error: String(e) }));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <template v-if="open">
      <div class="tcp__backdrop" @click="emit('close')" />
      <div class="tcp" role="dialog" :style="popoverStyle" @keydown.esc="emit('close')">
        <header class="tcp__head">
          <span class="tcp__title">{{ t('types.customize') }} · {{ typeName }}</span>
          <button class="rp-icon-btn" type="button" :aria-label="t('types.cancel')" @click="emit('close')">
            <Icons name="close" :size="14" />
          </button>
        </header>

        <div class="tcp__body">
          <!-- Icon grid -->
          <label class="tcp__label">{{ t('types.iconLabel') }}</label>
          <div class="tcp__icons">
            <button
              v-for="ic in ICON_CHOICES"
              :key="ic"
              class="tcp__icon"
              :class="{ 'tcp__icon--on': icon === ic }"
              type="button"
              :aria-pressed="icon === ic"
              @click="icon = ic"
            >
              <Icons :name="ic" :size="16" />
            </button>
          </div>

          <!-- Color swatches -->
          <label class="tcp__label">{{ t('types.colorLabel') }}</label>
          <div class="tcp__swatches">
            <button
              v-for="c in TYPE_COLORS"
              :key="c"
              class="tcp__swatch"
              :class="{ 'tcp__swatch--on': color === c }"
              type="button"
              :style="{ '--swatch': `var(--type-${c})` }"
              :title="c"
              :aria-pressed="color === c"
              @click="color = color === c ? null : c"
            />
          </div>

          <!-- Order + sidebar label -->
          <div class="tcp__row">
            <div class="tcp__col">
              <label class="tcp__label">{{ t('types.orderLabel') }}</label>
              <input
                class="rp-input"
                type="number"
                :value="order ?? ''"
                @input="order = ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value)"
              />
            </div>
            <div class="tcp__col tcp__col--grow">
              <label class="tcp__label">{{ t('types.sidebarLabelLabel') }}</label>
              <input v-model="sidebarLabel" class="rp-input" type="text" />
            </div>
          </div>

          <!-- Pinned properties -->
          <label class="tcp__label">{{ t('types.pinnedLabel') }}</label>
          <div v-if="availableProps.length === 0" class="rp-sub">
            {{ t('types.pinnedEmpty') }}
          </div>
          <div v-else class="rp-chips">
            <button
              v-for="k in availableProps"
              :key="k"
              class="rp-chip"
              :class="{ 'is-active': pinned.includes(k) }"
              type="button"
              :aria-pressed="pinned.includes(k)"
              @click="togglePinned(k)"
            >{{ k }}</button>
          </div>

          <!-- Template -->
          <label class="tcp__label">{{ t('types.templateLabel') }}</label>
          <textarea v-model="template" class="rp-textarea tcp__textarea" rows="3" />
        </div>

        <footer class="tcp__foot">
          <button class="rp-btn" type="button" @click="emit('close')">
            {{ t('types.cancel') }}
          </button>
          <button class="rp-btn rp-btn--primary" type="button" :disabled="busy" @click="save">
            {{ t('types.save') }}
          </button>
        </footer>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.tcp__backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
}
.tcp {
  position: fixed;
  z-index: calc(var(--z-modal) + 1);
  display: flex;
  flex-direction: column;
  width: 300px;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 13px;
  transform-origin: top left;
  animation: tcp-in var(--dur-fast) var(--ease-out);
}
@keyframes tcp-in {
  from {
    opacity: 0;
    transform: scale(0.98);
  }
}
.tcp__head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 8px 0 14px;
  border-bottom: var(--bd-hair);
}
.tcp__title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tcp__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 14px 14px;
}
.tcp__label {
  margin-top: 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-3);
}
.tcp__icons {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.tcp__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--r-md);
  background: var(--fill-1);
  color: var(--text-2);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.tcp__icon:hover {
  background: var(--fill-2);
  color: var(--text);
}
.tcp__icon--on,
.tcp__icon--on:hover {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.tcp__swatches {
  display: flex;
  gap: 8px;
}
.tcp__swatch {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--r-full);
  background: var(--swatch);
  cursor: pointer;
  transition: box-shadow var(--dur-fast) var(--ease);
}
.tcp__swatch--on {
  box-shadow: 0 0 0 2px var(--bg-pop), 0 0 0 3.5px var(--swatch);
}
.tcp__icon:focus-visible,
.tcp__swatch:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.tcp__row {
  display: flex;
  gap: 8px;
}
.tcp__col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 80px;
}
.tcp__col--grow {
  flex: 1;
  width: auto;
}
.tcp__textarea {
  font-family: var(--font-mono);
  font-size: 12px;
}
.tcp__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: var(--bd-hair);
}
@media (prefers-reduced-motion: reduce) {
  .tcp {
    animation: none;
  }
}
</style>
