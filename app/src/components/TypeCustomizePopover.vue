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
          <button class="tcp__x" @click="emit('close')" aria-label="Cancel">×</button>
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
              @click="icon = ic"
            >
              <Icons :name="ic" :size="18" />
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
              :style="{ background: `var(--type-${c})` }"
              :title="c"
              @click="color = color === c ? null : c"
            />
          </div>

          <!-- Order + sidebar label -->
          <div class="tcp__row">
            <div class="tcp__col">
              <label class="tcp__label">{{ t('types.orderLabel') }}</label>
              <input
                class="tcp__input"
                type="number"
                :value="order ?? ''"
                @input="order = ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value)"
              />
            </div>
            <div class="tcp__col tcp__col--grow">
              <label class="tcp__label">{{ t('types.sidebarLabelLabel') }}</label>
              <input v-model="sidebarLabel" class="tcp__input" type="text" />
            </div>
          </div>

          <!-- Pinned properties -->
          <label class="tcp__label">{{ t('types.pinnedLabel') }}</label>
          <div v-if="availableProps.length === 0" class="tcp__hint">
            {{ t('types.pinnedEmpty') }}
          </div>
          <div v-else class="tcp__chips">
            <button
              v-for="k in availableProps"
              :key="k"
              class="tcp__chip"
              :class="{ 'tcp__chip--on': pinned.includes(k) }"
              type="button"
              @click="togglePinned(k)"
            >{{ k }}</button>
          </div>

          <!-- Template -->
          <label class="tcp__label">{{ t('types.templateLabel') }}</label>
          <textarea v-model="template" class="tcp__textarea" rows="3" />
        </div>

        <footer class="tcp__foot">
          <button class="tcp__btn tcp__btn--cancel" @click="emit('close')">
            {{ t('types.cancel') }}
          </button>
          <button class="tcp__btn tcp__btn--save" :disabled="busy" @click="save">
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
  z-index: 2000;
}
.tcp {
  position: fixed;
  z-index: 2001;
  width: 300px;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
}
.tcp__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.tcp__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.tcp__x {
  background: transparent;
  border: none;
  color: var(--text-faint);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  border-radius: 6px;
  padding: 2px 6px;
}
.tcp__x:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.tcp__body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tcp__label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-top: 6px;
}
.tcp__icons {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tcp__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.12s;
}
.tcp__icon:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.tcp__icon--on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--bg-hover);
}
.tcp__swatches {
  display: flex;
  gap: 8px;
}
.tcp__swatch {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  border: 2px solid transparent;
  cursor: pointer;
  transition: transform 0.1s;
}
.tcp__swatch:hover {
  transform: scale(1.1);
}
.tcp__swatch--on {
  border-color: var(--text);
  box-shadow: 0 0 0 2px var(--bg-elev) inset;
}
.tcp__row {
  display: flex;
  gap: 8px;
}
.tcp__col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 80px;
}
.tcp__col--grow {
  flex: 1;
  width: auto;
}
.tcp__input,
.tcp__textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  font-family: inherit;
}
.tcp__textarea {
  resize: vertical;
  font-family: var(--font-mono);
}
.tcp__input:focus,
.tcp__textarea:focus {
  border-color: var(--accent);
}
.tcp__hint {
  font-size: 11px;
  color: var(--text-faint);
  font-style: italic;
}
.tcp__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tcp__chip {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.12s;
}
.tcp__chip:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.tcp__chip--on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-fg);
}
.tcp__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
}
.tcp__btn {
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all 0.15s;
}
.tcp__btn--cancel {
  background: transparent;
  color: var(--text-muted);
}
.tcp__btn--cancel:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.tcp__btn--save {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}
.tcp__btn--save:hover:not(:disabled) {
  opacity: 0.9;
}
.tcp__btn--save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
