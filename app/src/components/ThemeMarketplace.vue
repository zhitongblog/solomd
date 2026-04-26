<script setup lang="ts">
/**
 * v2.5 Theme marketplace modal — opened from Settings → "Browse community themes".
 *
 * Three columns of theme cards: preview image, name + author, description,
 * tag chips, and an Install / ✓ Active / Update button. Filter chips at the
 * top narrow the list by tag (Dark / Light / OLED / Sepia / Warm / Cool).
 *
 * Manifest fetch is delegated to `useThemesStore.loadManifest()` which
 * handles the 5-minute TTL cache. Install downloads the .css and pipes the
 * resulting absolute path into `settings.customCssPath` so the existing
 * `lib/custom-theme.ts` watcher applies it without us having to touch
 * `<style>` tags directly.
 */
import { onMounted, computed } from 'vue';
import { useThemesStore, type ThemeManifestEntry } from '../stores/themes';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const themes = useThemesStore();
const settings = useSettingsStore();
const toasts = useToastsStore();
const { t } = useI18n();

onMounted(() => {
  if (themes.manifest === null) themes.loadManifest();
});

function isActive(theme: ThemeManifestEntry): boolean {
  const installed = themes.installedById[theme.id];
  if (!installed) return false;
  return settings.customCssPath === installed.path;
}

function isInstalled(theme: ThemeManifestEntry): boolean {
  return themes.installedById[theme.id] !== undefined;
}

async function onInstall(theme: ThemeManifestEntry) {
  try {
    const path = await themes.install(theme);
    settings.setCustomCssPath(path);
    toasts.success(t('themes.installed', { name: theme.name }));
  } catch (e) {
    toasts.error(
      t('themes.installFailed', { error: String((e as Error)?.message ?? e) }),
    );
  }
}

async function onUpdate(theme: ThemeManifestEntry) {
  // Same code path as install — overwrite the file. If the theme is
  // currently active, the watcher on customCssPath won't re-fire because
  // the path didn't change; nudge it by clearing + restoring.
  try {
    const wasActive = isActive(theme);
    const path = await themes.install(theme);
    if (wasActive) {
      // Force the App.vue watcher to re-read the (now-updated) file.
      const previous = settings.customCssPath;
      settings.setCustomCssPath('');
      // Vue watchers are flushed in microtasks; nextTick before re-set.
      await Promise.resolve();
      settings.setCustomCssPath(previous);
    } else {
      settings.setCustomCssPath(path);
    }
    toasts.success(t('themes.updated', { name: theme.name }));
  } catch (e) {
    toasts.error(
      t('themes.updateFailed', { error: String((e as Error)?.message ?? e) }),
    );
  }
}

async function onUninstall(theme: ThemeManifestEntry) {
  try {
    const wasActive = isActive(theme);
    await themes.uninstall(theme.id);
    if (wasActive) settings.setCustomCssPath('');
    toasts.success(t('themes.uninstalled', { name: theme.name }));
  } catch (e) {
    toasts.error(
      t('themes.uninstallFailed', {
        error: String((e as Error)?.message ?? e),
      }),
    );
  }
}

async function onRefresh() {
  await themes.loadManifest(true);
}

const visible = computed(() => themes.visibleThemes);
</script>

<template>
  <div v-if="open" class="tm__backdrop" @click.self="emit('close')">
    <div class="tm" role="dialog" aria-label="Theme marketplace">
      <header class="tm__header">
        <h2>{{ t('themes.title') }}</h2>
        <div class="tm__header-actions">
          <button
            class="tm__refresh"
            :disabled="themes.loading"
            :title="t('themes.refresh')"
            @click="onRefresh"
          >
            {{ themes.loading ? t('themes.loading') : t('themes.refresh') }}
          </button>
          <button class="tm__close" @click="emit('close')">×</button>
        </div>
      </header>

      <div class="tm__filterbar">
        <span class="tm__filterlabel">{{ t('themes.filterBy') }}</span>
        <button
          class="tm__chip"
          :class="{ 'tm__chip--active': themes.activeTags.length === 0 }"
          @click="themes.clearTags()"
        >
          {{ t('themes.allTags') }}
        </button>
        <button
          v-for="tag in themes.allTags"
          :key="tag"
          class="tm__chip"
          :class="{ 'tm__chip--active': themes.activeTags.includes(tag) }"
          @click="themes.toggleTag(tag)"
        >
          {{ tag }}
        </button>
      </div>

      <div class="tm__body">
        <p v-if="themes.error" class="tm__error">
          {{ t('themes.fetchFailed', { error: themes.error }) }}
        </p>

        <p
          v-else-if="themes.loading && !themes.manifest"
          class="tm__placeholder"
        >
          {{ t('themes.loading') }}
        </p>

        <p
          v-else-if="visible.length === 0"
          class="tm__placeholder"
        >
          {{ t('themes.empty') }}
        </p>

        <div v-else class="tm__grid">
          <article
            v-for="theme in visible"
            :key="theme.id"
            class="tm__card"
            :data-theme-id="theme.id"
          >
            <div class="tm__preview">
              <img
                v-if="theme.preview"
                :src="theme.preview"
                :alt="theme.name"
                loading="lazy"
              />
              <div v-else class="tm__preview-fallback" />
              <span v-if="isActive(theme)" class="tm__badge tm__badge--active">
                {{ t('themes.activeBadge') }}
              </span>
            </div>
            <div class="tm__meta">
              <h3 class="tm__name">{{ theme.name }}</h3>
              <p class="tm__author">
                {{ t('themes.byAuthor', { author: theme.author }) }}
              </p>
              <p class="tm__desc">{{ theme.description }}</p>
              <div v-if="theme.tags?.length" class="tm__tags">
                <span
                  v-for="tag in theme.tags"
                  :key="tag"
                  class="tm__tag"
                >#{{ tag }}</span>
              </div>
              <div class="tm__actions">
                <button
                  v-if="!isInstalled(theme)"
                  class="tm__btn tm__btn--primary"
                  :disabled="themes.installingId === theme.id"
                  @click="onInstall(theme)"
                >
                  {{
                    themes.installingId === theme.id
                      ? t('themes.installing')
                      : t('themes.install')
                  }}
                </button>
                <template v-else>
                  <button
                    class="tm__btn"
                    :disabled="themes.installingId === theme.id"
                    @click="onUpdate(theme)"
                  >
                    {{ t('themes.update') }}
                  </button>
                  <button
                    v-if="!isActive(theme)"
                    class="tm__btn tm__btn--primary"
                    @click="
                      settings.setCustomCssPath(themes.installedById[theme.id].path)
                    "
                  >
                    {{ t('themes.activate') }}
                  </button>
                  <button class="tm__btn tm__btn--danger" @click="onUninstall(theme)">
                    {{ t('themes.uninstall') }}
                  </button>
                </template>
              </div>
            </div>
          </article>
        </div>

        <p class="tm__footer">
          {{ t('themes.publishHint') }}
          <a
            href="https://github.com/zhitongblog/solomd/blob/main/web/public/themes/index.json"
            target="_blank"
            rel="noopener"
          >{{ t('themes.publishHintLink') }}</a>
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tm__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1100;
}
.tm {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  width: min(960px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
}
.tm__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}
.tm__header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.tm__header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tm__refresh {
  font-size: 12px;
  border: 1px solid var(--border);
  padding: 4px 10px;
  border-radius: 4px;
}
.tm__close {
  font-size: 20px;
  line-height: 1;
  padding: 0 6px;
  color: var(--text-muted);
}
.tm__filterbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.tm__filterlabel {
  color: var(--text-muted);
  margin-right: 4px;
}
.tm__chip {
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 11px;
  cursor: pointer;
  text-transform: capitalize;
}
.tm__chip--active {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}
.tm__body {
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
}
.tm__placeholder,
.tm__error {
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
  margin: 28px 0;
}
.tm__error {
  color: var(--danger, #d64545);
}
.tm__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
@media (max-width: 760px) {
  .tm__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 480px) {
  .tm__grid { grid-template-columns: 1fr; }
}
.tm__card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tm__preview {
  position: relative;
  aspect-ratio: 3 / 2;
  background: var(--bg-hover);
  overflow: hidden;
}
.tm__preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.tm__preview-fallback {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, var(--bg-active), var(--bg-hover));
}
.tm__badge {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--accent);
  color: var(--accent-fg);
  font-weight: 600;
}
.tm__meta {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.tm__name {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.tm__author {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
}
.tm__desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
  flex: 1;
}
.tm__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.tm__tag {
  font-size: 10px;
  color: var(--text-faint);
}
.tm__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.tm__btn {
  font-size: 12px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
}
.tm__btn:hover:not(:disabled) {
  background: var(--bg-hover);
}
.tm__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.tm__btn--primary {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}
.tm__btn--primary:hover:not(:disabled) {
  filter: brightness(1.05);
  background: var(--accent);
}
.tm__btn--danger {
  color: var(--danger, #d64545);
}
.tm__footer {
  margin: 24px 0 8px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-faint);
  text-align: center;
}
.tm__footer a {
  color: var(--accent);
  text-decoration: underline;
}
</style>
