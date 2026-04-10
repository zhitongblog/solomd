<script setup lang="ts">
import { openUrl } from '@tauri-apps/plugin-opener';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

// Pulled from package.json at build time would be cleaner; for now we
// keep it in sync with tauri.conf.json's `version` field.
const VERSION = '0.1.1';

const links = {
  website: 'https://solomd.app',
  github: 'https://github.com/zhitongblog/solomd',
  releases: 'https://github.com/zhitongblog/solomd/releases',
  sponsor: 'https://solomd.app/#sponsor',
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
  <div v-if="open" class="about__backdrop" @click.self="emit('close')">
    <div class="about" role="dialog" aria-label="About SoloMD">
      <button class="about__close" @click="emit('close')" aria-label="Close">×</button>

      <div class="about__brand">
        <span class="brand"><span class="brand__h">#</span><span class="brand__md">MD</span></span>
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
          <span class="about__link-icon">🌐</span>
          <div>
            <div class="about__link-title">Website / 官网</div>
            <div class="about__link-url">solomd.app</div>
          </div>
        </button>
        <button class="about__link" @click="visit(links.github)">
          <span class="about__link-icon">⭐</span>
          <div>
            <div class="about__link-title">GitHub</div>
            <div class="about__link-url">zhitongblog/solomd</div>
          </div>
        </button>
        <button class="about__link" @click="visit(links.releases)">
          <span class="about__link-icon">📦</span>
          <div>
            <div class="about__link-title">Releases / 历史版本</div>
            <div class="about__link-url">github.com/.../releases</div>
          </div>
        </button>
        <button class="about__link" @click="visit(links.sponsor)">
          <span class="about__link-icon">❤️</span>
          <div>
            <div class="about__link-title">Sponsor / 赞助</div>
            <div class="about__link-url">GitHub · Alipay · WeChat</div>
          </div>
        </button>
      </div>

      <div class="about__footer">
        © 2026 xiangdong li · MIT License<br />
        Tauri 2 · Vue 3 · CodeMirror 6 · Rust
      </div>
    </div>
  </div>
</template>

<style scoped>
.about__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}
.about {
  background: var(--bg-elev);
  width: min(440px, 92vw);
  max-height: 90vh;
  border-radius: 14px;
  border: 1px solid var(--border);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
  padding: 28px 32px 24px;
  text-align: center;
  position: relative;
  overflow-y: auto;
}
.about__close {
  position: absolute;
  top: 12px;
  right: 14px;
  font-size: 22px;
  line-height: 1;
  padding: 4px 8px;
  color: var(--text-faint);
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 6px;
}
.about__close:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.about__brand {
  display: flex;
  justify-content: center;
  margin-bottom: 6px;
}
.brand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 14px;
  background: #000;
  font-family: var(--font-mono);
  font-weight: 800;
  font-size: 22px;
}
.brand__h { color: var(--accent); }
.brand__md { color: #ffffff; }

.about__name {
  margin: 14px 0 2px;
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
}
.about__version {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 14px;
}
.about__tagline {
  font-size: 13px;
  color: var(--text);
  margin: 0 0 6px;
  line-height: 1.6;
}
.about__tagline-zh {
  color: var(--text-muted);
}
.about__desc {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 22px;
  line-height: 1.6;
}
.about__desc-zh {
  color: var(--text-faint);
}

.about__links {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 22px;
}
.about__link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  color: var(--text);
  transition: all 0.15s;
  font: inherit;
}
.about__link:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}
.about__link-icon {
  font-size: 18px;
  flex-shrink: 0;
}
.about__link-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.about__link-url {
  font-size: 10px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  margin-top: 1px;
}

.about__footer {
  font-size: 10px;
  color: var(--text-faint);
  line-height: 1.7;
}
</style>
