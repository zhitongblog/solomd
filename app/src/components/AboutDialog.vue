<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { DsModal } from '../ui';
import BrandMark from './BrandMark.vue';
import Icons from './Icons.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const VERSION = ref('…');
onMounted(async () => {
  try {
    VERSION.value = await getVersion();
  } catch {
    VERSION.value = '2.5.0';
  }
});

// Sponsor nicknames, fetched from the site so a new name shows up without an
// app release. Silent on failure (offline, blocked): the section just stays
// hidden. Fetched once per session, only when the dialog is first opened.
const sponsors = ref<string[]>([]);
const promoters = ref<string[]>([]);
const testers = ref<string[]>([]);
let sponsorsLoaded = false;
async function loadSponsors() {
  if (sponsorsLoaded) return;
  sponsorsLoaded = true;
  try {
    const res = await fetch('https://solomd.app/sponsors.json', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const data = await res.json();
    const names = (list: unknown) =>
      (Array.isArray(list) ? list : [])
        .map((s: { name?: unknown }) => (typeof s?.name === 'string' ? s.name.trim() : ''))
        .filter((n: string) => n.length > 0 && n.length <= 40)
        .slice(0, 200);
    sponsors.value = names(data?.sponsors);
    // People who wrote about SoloMD or recommended it (solomd.app/promote).
    promoters.value = names(data?.promoters);
    // People who test SoloMD carefully and send detailed bug reports.
    testers.value = names(data?.testers);
  } catch {
    /* offline or blocked — nothing to show */
  }
}
watch(() => props.open, (o) => { if (o) loadSponsors(); }, { immediate: true });

const links = {
  website: 'https://solomd.app',
  github: 'https://github.com/zhitongblog/solomd',
  // Update/version-history surfaces point at solomd.app, not GitHub: the
  // site serves mainland users (Cloudflare edge + Gitee mirror links) where
  // github.com often doesn't resolve. Same policy as the update toast (#154).
  releases: 'https://solomd.app/whats-new',
  sponsor: 'https://solomd.app/#sponsor',
  promote: 'https://solomd.app/promote',
};

// NOTE: this function intentionally is NOT named `open` because that
// collides with the `open` prop and the template would shadow it.
async function visit(url: string) {
  try {
    await openUrl(url);
  } catch (e) {
    console.error('failed to open url', e);
  }
}
</script>

<template>
  <DsModal
    :model-value="open"
    width="440px"
    @update:model-value="emit('close')"
  >
    <!-- Empty header slot keeps DsModal's × close button without a title bar,
         since the About content is centered branding rather than a labelled
         form. -->
    <template #header><span class="about__hdr" aria-label="About SoloMD"></span></template>

    <div class="about">
      <div class="about__brand">
        <BrandMark class="brand" :size="64" label="SoloMD" />
      </div>

      <h2 class="about__name">SoloMD</h2>
      <div class="about__version">v{{ VERSION }}</div>

      <p class="about__tagline">
        One file. One window. Just write.<br />
        <span class="about__tagline-zh">一个文件,一个窗口,专心写作。</span>
      </p>

      <p class="about__desc">
        A lightweight, cross-platform Markdown + plain text editor.<br />
        <span class="about__desc-zh">一款轻量、跨平台的 Markdown 与纯文本编辑器。</span>
      </p>

      <div class="about__links">
        <button class="about__link" @click="visit(links.website)">
          <Icons class="about__link-icon" name="globe" :size="16" />
          <div>
            <div class="about__link-title">Website / 官网</div>
            <div class="about__link-url">solomd.app</div>
          </div>
          <Icons class="about__link-chev" name="chevron-right" :size="14" />
        </button>
        <button class="about__link" @click="visit(links.github)">
          <Icons class="about__link-icon" name="star" :size="16" />
          <div>
            <div class="about__link-title">Star on GitHub / 去 GitHub 点 Star</div>
            <div class="about__link-url">zhitongblog/solomd</div>
          </div>
          <Icons class="about__link-chev" name="chevron-right" :size="14" />
        </button>
        <button class="about__link" @click="visit(links.releases)">
          <Icons class="about__link-icon" name="sparkle" :size="16" />
          <div>
            <div class="about__link-title">What's New / 更新日志</div>
            <div class="about__link-url">solomd.app/whats-new</div>
          </div>
          <Icons class="about__link-chev" name="chevron-right" :size="14" />
        </button>
        <button class="about__link" @click="visit(links.sponsor)">
          <Icons class="about__link-icon" name="heart" :size="16" />
          <div>
            <div class="about__link-title">Sponsor / 赞助</div>
            <div class="about__link-url">GitHub · Alipay · WeChat</div>
          </div>
          <Icons class="about__link-chev" name="chevron-right" :size="14" />
        </button>
      </div>

      <div v-if="sponsors.length" class="about__sponsors">
        <div class="about__sponsors-title">Thanks to our sponsors / 感谢赞助者</div>
        <div class="about__sponsors-names">{{ sponsors.join(' · ') }}</div>
      </div>
      <div v-if="testers.length" class="about__sponsors">
        <div class="about__sponsors-title">Thanks to our testers / 感谢测试者</div>
        <div class="about__sponsors-names">{{ testers.join(' · ') }}</div>
      </div>
      <div v-if="promoters.length" class="about__sponsors">
        <div class="about__sponsors-title">Thanks to our promoters / 感谢推广者</div>
        <div class="about__sponsors-names">{{ promoters.join(' · ') }}</div>
      </div>
      <button class="about__promote" @click="visit(links.promote)">
        Help spread the word / 帮忙推广 SoloMD
      </button>

      <div class="about__footer">
        © 2026 xiangdong li · MIT License<br />
        Tauri 2 · Vue 3 · CodeMirror 6 · Rust
      </div>
    </div>
  </DsModal>
</template>

<style scoped>
/* 5.0 About: centred brand block, then the links as one System-Settings
   style group card (rows split by hairlines, chevron on the right). */
.about {
  text-align: center;
}
.about__hdr {
  flex: 1;
}
.about__brand {
  display: flex;
  justify-content: center;
  margin-top: -8px;
  margin-bottom: 4px;
}
.brand {
  width: 64px;
  height: 64px;
  border-radius: 14px;
}

.about__name {
  margin: 12px 0 2px;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--text);
}
.about__version {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
  margin-bottom: 14px;
}
.about__tagline {
  font-size: 13px;
  color: var(--text);
  margin: 0 0 6px;
  line-height: 1.6;
}
.about__tagline-zh {
  color: var(--text-2);
}
.about__desc {
  font-size: 12px;
  color: var(--text-2);
  margin: 0 0 20px;
  line-height: 1.6;
}
.about__desc-zh {
  color: var(--text-3);
}

.about__links {
  display: flex;
  flex-direction: column;
  margin-bottom: 18px;
  background: var(--bg-elev);
  border-radius: var(--r-lg);
  overflow: hidden;
  text-align: left;
}
.about__link {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 6px 12px;
  background: transparent;
  border: 0;
  border-radius: 0;
  cursor: default;
  text-align: left;
  color: var(--text);
  font: inherit;
}
.about__link + .about__link {
  box-shadow: inset 0 var(--hair-w) 0 var(--hairline);
}
.about__link:hover {
  background: var(--fill-1);
}
.about__link:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-ring);
}
.about__link > div {
  flex: 1;
  min-width: 0;
}
.about__link-icon {
  flex-shrink: 0;
  color: var(--accent-text);
}
.about__link-chev {
  flex-shrink: 0;
  color: var(--text-3);
}
.about__link-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.about__link-url {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 1px;
}

.about__sponsors {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
}
.about__sponsors-title {
  color: var(--text-3);
  margin-bottom: 2px;
}
.about__sponsors-names {
  color: var(--text-2);
}
.about__footer {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.7;
}

.about__promote {
  margin: 2px auto 12px;
  height: 28px;
  padding: 0 12px;
  font: inherit;
  font-size: 12px;
  font-weight: 560;
  color: var(--accent-text);
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  cursor: default;
}
.about__promote:hover {
  background: var(--fill-1);
}
</style>
