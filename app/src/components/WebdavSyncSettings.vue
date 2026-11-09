<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const toasts = useToastsStore();
const { t } = useI18n();

const testing = ref(false);
const pushing = ref(false);
const pulling = ref(false);
const statusText = ref('');
const statusKind = ref<'ok' | 'err' | ''>('');

const vaultPushing = ref(false);
const vaultPulling = ref(false);
const vaultStatusText = ref('');
const vaultStatusKind = ref<'ok' | 'err' | ''>('');

interface DetectedCloudDir {
  provider: string;
  label: string;
  base_dir: string;
  suggested_vault_dir: string;
}
const detectedCloudDirs = ref<DetectedCloudDir[]>([]);

const apiPushing = ref(false);
const apiPulling = ref(false);
const apiAuthLoading = ref(false);
const apiDeviceCode = ref('');
const apiUserCode = ref('');
const apiVerifyUrl = ref('');
const apiQrUrl = ref('');
const apiQuickAuthInstructions = ref('');
const apiStatusText = ref('');
const apiStatusKind = ref<'ok' | 'err' | ''>('');

const pruningVersions = ref(false);

onMounted(async () => {
  try {
    detectedCloudDirs.value = await invoke<DetectedCloudDir[]>('cloud_vault_detect_local_dirs');
  } catch {
    detectedCloudDirs.value = [];
  }
});

function applyDetectedCloudDir(dir: string) {
  settings.cloudVaultDir = dir;
  settings.persist();
  toasts.success(
    settings.language === 'zh'
      ? `已填入网盘专用目录：${dir}`
      : `Selected cloud drive folder: ${dir}`,
  );
}

function parseTokenFromInput(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as { access_token?: string };
      if (typeof obj.access_token === 'string' && obj.access_token.trim()) {
        return obj.access_token.trim();
      }
    } catch {
      /* ignore */
    }
  }
  const idx = s.indexOf('access_token=');
  if (idx !== -1) {
    const after = s.slice(idx + 'access_token='.length);
    const match = after.match(/^([^&#\s"']+)/);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]).trim();
      } catch {
        return match[1].trim();
      }
    }
  }
  return s;
}

function onTokenInputChange() {
  const extracted = parseTokenFromInput(settings.cloudApiToken);
  if (extracted && extracted !== settings.cloudApiToken) {
    settings.cloudApiToken = extracted;
    apiQuickAuthInstructions.value = '';
    toasts.success(
      settings.language === 'zh'
        ? '已自动从回调链接中提取 Access Token！'
        : 'Automatically extracted Access Token from URL!',
    );
  }
  settings.persist();
}

function onTokenInputPaste() {
  window.setTimeout(onTokenInputChange, 20);
}

async function openQuickBrowserAuth() {
  try {
    const res = await invoke<{ auth_url: string; instructions: string }>(
      'cloud_api_build_quick_auth_url',
      {
        provider: settings.cloudApiProvider,
        clientId: settings.cloudApiClientId || null,
      },
    );
    apiQuickAuthInstructions.value = res.instructions;
    apiStatusText.value = res.instructions;
    apiStatusKind.value = 'ok';
    try {
      await openUrl(res.auth_url);
    } catch {
      window.open(res.auth_url, '_blank', 'noopener,noreferrer');
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    apiStatusText.value = msg;
    apiStatusKind.value = 'err';
    toasts.error(msg);
  }
}

async function pruneOldVersions() {
  if (!workspace.currentFolder) {
    toasts.warning(t('menubar.openFolder'));
    return;
  }
  pruningVersions.value = true;
  try {
    const count = await invoke<number>('sync_prune_file_versions', {
      workspace: workspace.currentFolder,
      filePath: null,
      keep: Math.max(1, settings.syncMaxVersions || 20),
    });
    toasts.success(
      settings.language === 'zh'
        ? `已按保留策略清理 ${count} 个旧版本快照`
        : `Pruned ${count} old version snapshots`,
    );
  } catch (e) {
    toasts.error(String(e));
  } finally {
    pruningVersions.value = false;
  }
}

function selectApiProvider(
  p: 'baidu' | 'alipan' | 'onedrive' | 'dropbox' | 'gdrive' | 'r2',
) {
  settings.cloudApiProvider = p;
  if (p === 'baidu' && (!settings.cloudApiRemotePath || settings.cloudApiRemotePath === '/SoloMD')) {
    settings.cloudApiRemotePath = '/apps/SoloMD';
  } else if (p !== 'baidu' && settings.cloudApiRemotePath === '/apps/SoloMD') {
    settings.cloudApiRemotePath = '/SoloMD';
  }
  apiDeviceCode.value = '';
  apiUserCode.value = '';
  apiVerifyUrl.value = '';
  apiQrUrl.value = '';
  apiQuickAuthInstructions.value = '';
  settings.persist();
}

function getEffectiveApiToken(): string {
  if (settings.cloudApiProvider === 'r2') {
    const endpoint = settings.cloudR2Endpoint.trim();
    const bucket = settings.cloudR2Bucket.trim();
    const accessKeyId = settings.cloudR2AccessKeyId.trim();
    const secretAccessKey = settings.cloudR2SecretAccessKey.trim();
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      return '';
    }
    return JSON.stringify({
      endpoint,
      bucket,
      access_key_id: accessKeyId,
      secret_access_key: secretAccessKey,
    });
  }
  return settings.cloudApiToken.trim();
}

async function startDeviceAuth() {
  apiAuthLoading.value = true;
  apiStatusText.value = '';
  try {
    const res = await invoke<{
      device_code: string;
      user_code: string;
      verification_url: string;
      qrcode_url?: string | null;
      message: string;
    }>('cloud_api_start_device_auth', {
      provider: settings.cloudApiProvider,
      clientId: settings.cloudApiClientId,
    });
    apiDeviceCode.value = res.device_code;
    apiUserCode.value = res.user_code;
    apiVerifyUrl.value = res.verification_url;
    apiQrUrl.value = res.qrcode_url || '';
    apiStatusText.value = res.message;
    apiStatusKind.value = 'ok';
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    apiStatusText.value = msg;
    apiStatusKind.value = 'err';
    toasts.error(msg);
  } finally {
    apiAuthLoading.value = false;
  }
}

async function pollDeviceAuth() {
  if (!apiDeviceCode.value) return;
  apiAuthLoading.value = true;
  try {
    const res = await invoke<{
      status: string;
      access_token?: string | null;
      message: string;
    }>('cloud_api_poll_device_auth', {
      provider: settings.cloudApiProvider,
      clientId: settings.cloudApiClientId,
      clientSecret: settings.cloudApiClientSecret,
      deviceCode: apiDeviceCode.value,
    });
    apiStatusText.value = res.message;
    if (res.status === 'ok' && res.access_token) {
      settings.cloudApiToken = res.access_token;
      settings.persist();
      apiStatusKind.value = 'ok';
      apiDeviceCode.value = '';
      toasts.success(res.message);
    } else {
      apiStatusKind.value = 'err';
      toasts.warning(res.message);
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    apiStatusText.value = msg;
    apiStatusKind.value = 'err';
    toasts.error(msg);
  } finally {
    apiAuthLoading.value = false;
  }
}

async function pushCloudApi() {
  if (!workspace.currentFolder) {
    toasts.warning(t('menubar.openFolder'));
    return;
  }
  apiPushing.value = true;
  apiStatusText.value = '';
  try {
    const res = await invoke<{ uploaded: number; message: string }>('cloud_api_push_workspace', {
      workspace: workspace.currentFolder,
      provider: settings.cloudApiProvider,
      accessToken: getEffectiveApiToken(),
      remotePath: settings.cloudApiRemotePath || '/SoloMD',
      passphrase: settings.cloudApiPassphrase,
      syncMode: settings.cloudApiSyncMode,
      encrypted: settings.cloudApiEncrypted,
      autoWorkspaceSubdir: settings.cloudApiAutoSubdir,
      categorizeFiles: settings.cloudApiCategorizeFiles,
      maxVersions: settings.syncMaxVersions,
    });
    apiStatusText.value = res.message;
    apiStatusKind.value = 'ok';
    toasts.success(res.message);
    window.dispatchEvent(new CustomEvent('solomd:snapshot-saved'));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    apiStatusText.value = msg;
    apiStatusKind.value = 'err';
    toasts.error(msg);
  } finally {
    apiPushing.value = false;
  }
}

async function pullCloudApi() {
  if (!workspace.currentFolder) {
    toasts.warning(t('menubar.openFolder'));
    return;
  }
  apiPulling.value = true;
  apiStatusText.value = '';
  try {
    const res = await invoke<{ downloaded: number; message: string }>('cloud_api_pull_workspace', {
      workspace: workspace.currentFolder,
      provider: settings.cloudApiProvider,
      accessToken: getEffectiveApiToken(),
      remotePath: settings.cloudApiRemotePath || '/SoloMD',
      passphrase: settings.cloudApiPassphrase,
      syncMode: settings.cloudApiSyncMode,
      encrypted: settings.cloudApiEncrypted,
      autoWorkspaceSubdir: settings.cloudApiAutoSubdir,
      categorizeFiles: settings.cloudApiCategorizeFiles,
      maxVersions: settings.syncMaxVersions,
    });
    apiStatusText.value = res.message;
    apiStatusKind.value = 'ok';
    toasts.success(res.message);
    window.dispatchEvent(new CustomEvent('solomd:remote-pulled'));
    window.dispatchEvent(new CustomEvent('solomd:snapshot-saved'));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    apiStatusText.value = msg;
    apiStatusKind.value = 'err';
    toasts.error(msg);
  } finally {
    apiPulling.value = false;
  }
}

function saveConfig() {
  settings.persist();
}

function applyPreset(url: string) {
  settings.webdavUrl = url;
  if (!settings.webdavRemotePath) {
    settings.webdavRemotePath = '/SoloMD';
  }
  settings.webdavEnabled = true;
  settings.persist();
}

async function testConnection() {
  testing.value = true;
  statusText.value = '';
  statusKind.value = '';
  try {
    const res = await invoke<string>('webdav_test_connection', {
      url: settings.webdavUrl,
      username: settings.webdavUsername,
      password: settings.webdavPassword,
      remotePath: settings.webdavRemotePath || '/SoloMD',
    });
    statusText.value = res;
    statusKind.value = 'ok';
    toasts.success(res);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    statusText.value = msg;
    statusKind.value = 'err';
    toasts.error(msg);
  } finally {
    testing.value = false;
  }
}

async function pushWorkspace() {
  if (!workspace.currentFolder) {
    toasts.warning(t('menubar.openFolder'));
    return;
  }
  pushing.value = true;
  statusText.value = '';
  try {
    const res = await invoke<{ uploaded: number; message: string }>('webdav_push_workspace', {
      workspace: workspace.currentFolder,
      url: settings.webdavUrl,
      username: settings.webdavUsername,
      password: settings.webdavPassword,
      remotePath: settings.webdavRemotePath || '/SoloMD',
      encrypted: settings.webdavEncrypted,
      passphrase: settings.webdavPassphrase,
      autoWorkspaceSubdir: settings.webdavAutoSubdir,
      categorizeFiles: settings.webdavCategorizeFiles,
      maxVersions: settings.syncMaxVersions,
    });
    statusText.value = res.message;
    statusKind.value = 'ok';
    toasts.success(res.message);
    window.dispatchEvent(new CustomEvent('solomd:snapshot-saved'));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    statusText.value = msg;
    statusKind.value = 'err';
    toasts.error(msg);
  } finally {
    pushing.value = false;
  }
}

async function pullWorkspace() {
  if (!workspace.currentFolder) {
    toasts.warning(t('menubar.openFolder'));
    return;
  }
  pulling.value = true;
  statusText.value = '';
  try {
    const res = await invoke<{ downloaded: number; message: string }>('webdav_pull_workspace', {
      workspace: workspace.currentFolder,
      url: settings.webdavUrl,
      username: settings.webdavUsername,
      password: settings.webdavPassword,
      remotePath: settings.webdavRemotePath || '/SoloMD',
      encrypted: settings.webdavEncrypted,
      passphrase: settings.webdavPassphrase,
      autoWorkspaceSubdir: settings.webdavAutoSubdir,
      categorizeFiles: settings.webdavCategorizeFiles,
      maxVersions: settings.syncMaxVersions,
    });
    statusText.value = res.message;
    statusKind.value = 'ok';
    toasts.success(res.message);
    window.dispatchEvent(new CustomEvent('solomd:remote-pulled'));
    window.dispatchEvent(new CustomEvent('solomd:snapshot-saved'));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    statusText.value = msg;
    statusKind.value = 'err';
    toasts.error(msg);
  } finally {
    pulling.value = false;
  }
}

async function pickCloudVaultDir() {
  try {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title:
        settings.language === 'zh'
          ? '选择个人网盘本地同步目录（如百度网盘/阿里云盘/OneDrive/坚果云文件夹）'
          : 'Select Personal Cloud Drive Local Sync Folder',
    });
    if (typeof picked === 'string' && picked.trim()) {
      settings.cloudVaultDir = picked.trim();
      settings.persist();
    }
  } catch (e) {
    toasts.error(String(e));
  }
}

async function pushCloudVault() {
  if (!workspace.currentFolder) {
    toasts.warning(t('menubar.openFolder'));
    return;
  }
  vaultPushing.value = true;
  vaultStatusText.value = '';
  try {
    const res = await invoke<{ uploaded: number; message: string }>('cloud_vault_push_workspace', {
      workspace: workspace.currentFolder,
      vaultDir: settings.cloudVaultDir,
      passphrase: settings.cloudVaultPassphrase,
      encrypted: settings.cloudVaultEncrypted,
      autoWorkspaceSubdir: settings.cloudVaultAutoSubdir,
      categorizeFiles: settings.cloudVaultCategorizeFiles,
      maxVersions: settings.syncMaxVersions,
    });
    vaultStatusText.value = res.message;
    vaultStatusKind.value = 'ok';
    toasts.success(res.message);
    window.dispatchEvent(new CustomEvent('solomd:snapshot-saved'));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    vaultStatusText.value = msg;
    vaultStatusKind.value = 'err';
    toasts.error(msg);
  } finally {
    vaultPushing.value = false;
  }
}

async function pullCloudVault() {
  if (!workspace.currentFolder) {
    toasts.warning(t('menubar.openFolder'));
    return;
  }
  vaultPulling.value = true;
  vaultStatusText.value = '';
  try {
    const res = await invoke<{ downloaded: number; message: string }>('cloud_vault_pull_workspace', {
      workspace: workspace.currentFolder,
      vaultDir: settings.cloudVaultDir,
      passphrase: settings.cloudVaultPassphrase,
      encrypted: settings.cloudVaultEncrypted,
      autoWorkspaceSubdir: settings.cloudVaultAutoSubdir,
      categorizeFiles: settings.cloudVaultCategorizeFiles,
      maxVersions: settings.syncMaxVersions,
    });
    vaultStatusText.value = res.message;
    vaultStatusKind.value = 'ok';
    toasts.success(res.message);
    window.dispatchEvent(new CustomEvent('solomd:remote-pulled'));
    window.dispatchEvent(new CustomEvent('solomd:snapshot-saved'));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    vaultStatusText.value = msg;
    vaultStatusKind.value = 'err';
    toasts.error(msg);
  } finally {
    vaultPulling.value = false;
  }
}
</script>

<template>
  <section class="settings__section webdav-sync">
    <h4 class="settings__heading">
      {{
        settings.language === 'zh'
          ? 'WebDAV 网盘同步与端到端加密 (坚果云 / Nextcloud / AList / NAS)'
          : 'WebDAV Sync & End-to-End Encryption (Nutstore / Nextcloud / AList / NAS)'
      }}
    </h4>
    <p class="settings__hint">
      {{
        settings.language === 'zh'
          ? '通过标准 WebDAV 协议同步当前笔记文件夹（支持坚果云、Nextcloud、群晖 NAS，以及通过 AList/OpenList 挂载的百度网盘、阿里云盘、夸克网盘、123云盘、OneDrive 等）。开启端到端加密后，网盘端仅存储 XChaCha20-Poly1305 密文。'
          : 'Sync your workspace folder over WebDAV (Nutstore, Nextcloud, Synology NAS, or AList/OpenList mounted cloud drives) with optional XChaCha20-Poly1305 end-to-end encryption.'
      }}
    </p>

    <label class="settings__row">
      <span>{{ settings.language === 'zh' ? '启用 WebDAV 同步' : 'Enable WebDAV Sync' }}</span>
      <input
        v-model="settings.webdavEnabled"
        type="checkbox"
        @change="saveConfig"
      />
    </label>

    <label class="settings__row">
      <span>
        {{
          settings.language === 'zh'
            ? '📂 自动在 WebDAV 创建当前工作区专用子目录 (如 /SoloMD/<工作区名>/)'
            : '📂 Automatically create dedicated workspace folder on WebDAV'
        }}
      </span>
      <input
        v-model="settings.webdavAutoSubdir"
        type="checkbox"
        @change="saveConfig"
      />
    </label>

    <label class="settings__row">
      <span>
        {{
          settings.language === 'zh'
            ? '🗂️ 保持子目录结构，并将根目录散落文件自动分门别类 (笔记文档/、图片素材/、文献附件/)'
            : '🗂️ Keep subfolder tree and auto-categorize root files on WebDAV'
        }}
      </span>
      <input
        v-model="settings.webdavCategorizeFiles"
        type="checkbox"
        @change="saveConfig"
      />
    </label>

    <label class="settings__row">
      <span>
        {{
          settings.language === 'zh'
            ? '🔒 端到端加密上传到 WebDAV (XChaCha20-Poly1305 + Argon2id)'
            : '🔒 End-to-End Encrypt files on WebDAV (XChaCha20-Poly1305)'
        }}
      </span>
      <input
        v-model="settings.webdavEncrypted"
        type="checkbox"
        @change="saveConfig"
      />
    </label>

    <label class="settings__row">
      <span>
        {{
          settings.language === 'zh'
            ? '保存笔记时自动同步到 WebDAV'
            : 'Auto-sync to WebDAV when saving notes'
        }}
      </span>
      <input
        v-model="settings.webdavAutoSync"
        type="checkbox"
        @change="saveConfig"
      />
    </label>

    <div class="webdav-sync__presets">
      <span class="webdav-sync__preset-label">
        {{ settings.language === 'zh' ? '快捷填入：' : 'Quick preset:' }}
      </span>
      <button
        type="button"
        class="settings__btn-secondary"
        @click="applyPreset('https://dav.jianguoyun.com/dav')"
      >
        坚果云 (Nutstore)
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        @click="applyPreset('https://your-domain.com/remote.php/dav/files/USERNAME')"
      >
        Nextcloud
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        @click="applyPreset('http://127.0.0.1:5244/dav')"
      >
        AList / OpenList (挂载百度/阿里/夸克网盘)
      </button>
    </div>

    <div class="webdav-sync__grid">
      <label class="webdav-sync__field">
        <span>{{ settings.language === 'zh' ? 'WebDAV 服务器地址 (URL)' : 'WebDAV Server URL' }}</span>
        <input
          v-model="settings.webdavUrl"
          type="url"
          class="settings__input"
          placeholder="https://dav.jianguoyun.com/dav"
          @change="saveConfig"
        />
      </label>

      <label class="webdav-sync__field">
        <span>{{ settings.language === 'zh' ? '远程同步目录' : 'Remote Folder Path' }}</span>
        <input
          v-model="settings.webdavRemotePath"
          type="text"
          class="settings__input"
          placeholder="/SoloMD"
          @change="saveConfig"
        />
      </label>

      <label class="webdav-sync__field">
        <span>{{ settings.language === 'zh' ? '账号 / 用户名' : 'Username' }}</span>
        <input
          v-model="settings.webdavUsername"
          type="text"
          class="settings__input"
          placeholder="user@example.com"
          autocomplete="off"
          @change="saveConfig"
        />
      </label>

      <label class="webdav-sync__field">
        <span>{{ settings.language === 'zh' ? '应用密码 / 授权码' : 'Password / App Password' }}</span>
        <input
          v-model="settings.webdavPassword"
          type="password"
          class="settings__input"
          placeholder="••••••••••••"
          autocomplete="new-password"
          @change="saveConfig"
        />
      </label>

      <label v-if="settings.webdavEncrypted" class="webdav-sync__field" style="grid-column: 1 / -1;">
        <span>
          {{
            settings.language === 'zh'
              ? '加密口令 (Passphrase — 多端同步请输入相同口令，切勿遗忘)'
              : 'Encryption Passphrase (enter the same passphrase on all devices)'
          }}
        </span>
        <input
          v-model="settings.webdavPassphrase"
          type="password"
          class="settings__input"
          :placeholder="settings.language === 'zh' ? '输入端到端加密口令…' : 'Enter encryption passphrase…'"
          autocomplete="new-password"
          @change="saveConfig"
        />
      </label>
    </div>

    <div class="webdav-sync__actions">
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="testing || !settings.webdavUrl"
        @click="testConnection"
      >
        {{
          testing
            ? (settings.language === 'zh' ? '连接测试中…' : 'Testing…')
            : (settings.language === 'zh' ? '测试 WebDAV 连接' : 'Test Connection')
        }}
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="pushing || !settings.webdavUrl"
        @click="pushWorkspace"
      >
        {{
          pushing
            ? (settings.language === 'zh' ? '上传中…' : 'Uploading…')
            : settings.webdavEncrypted
              ? (settings.language === 'zh' ? '🔒 加密上传到 WebDAV (Push)' : '🔒 Encrypt & Push to WebDAV')
              : (settings.language === 'zh' ? 'WebDAV 上传同步 (Push)' : 'WebDAV Push (Upload)')
        }}
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="pulling || !settings.webdavUrl"
        @click="pullWorkspace"
      >
        {{
          pulling
            ? (settings.language === 'zh' ? '下载中…' : 'Downloading…')
            : settings.webdavEncrypted
              ? (settings.language === 'zh' ? '🔓 从 WebDAV 解密拉取 (Pull)' : '🔓 Pull & Decrypt from WebDAV')
              : (settings.language === 'zh' ? 'WebDAV 下载同步 (Pull)' : 'WebDAV Pull (Download)')
        }}
      </button>
    </div>

    <p
      v-if="statusText"
      class="webdav-sync__status"
      :class="{
        'webdav-sync__status--ok': statusKind === 'ok',
        'webdav-sync__status--err': statusKind === 'err',
      }"
    >
      {{ statusText }}
    </p>

    <hr style="border: 0; border-top: 1px solid var(--border); margin: 14px 0 6px;" />

    <h4 class="settings__heading">
      {{
        settings.language === 'zh'
          ? '个人网盘同步目录 · 免 Key 专用文件夹分类同步 (百度网盘 / 阿里云盘 / 夸克 / OneDrive / iCloud)'
          : 'Personal Cloud Drive Folder · Keyless Dedicated Folder Sync (Baidu / Aliyun / OneDrive / iCloud)'
      }}
    </h4>
    <p class="settings__hint">
      {{
        settings.language === 'zh'
          ? '无需申请开放平台 Key：直接选择（或一键填入检测到的）本机网盘客户端同步盘目录。SoloMD 会自动在网盘下创建当前笔记库的专用目录，将笔记与图片分门别类存放到对应文件夹中，并同步版本历史快照（可选明文存放以便手机网盘直接查看，或开启 .enc 端到端加密）。'
          : 'No API key required: select your local cloud drive client folder. SoloMD automatically creates a dedicated workspace directory, organizes your notes and images into categorized folders, and syncs version history snapshots.'
      }}
    </p>

    <div v-if="detectedCloudDirs.length > 0" class="webdav-sync__presets">
      <span class="webdav-sync__preset-label">
        {{ settings.language === 'zh' ? '✨ 检测到本机网盘目录（点击一键填入）：' : '✨ Detected Local Cloud Drives:' }}
      </span>
      <button
        v-for="item in detectedCloudDirs"
        :key="item.base_dir"
        type="button"
        class="settings__btn-secondary"
        @click="applyDetectedCloudDir(item.suggested_vault_dir)"
      >
        {{ item.label }}
      </button>
    </div>

    <div class="webdav-sync__grid">
      <label class="webdav-sync__field" style="grid-column: 1 / -1;">
        <span>
          {{
            settings.language === 'zh'
              ? '个人网盘本地同步目录 (Cloud Drive Sync Folder)'
              : 'Cloud Drive Sync Folder'
          }}
        </span>
        <div style="display: flex; gap: 8px; align-items: center;">
          <input
            v-model="settings.cloudVaultDir"
            type="text"
            class="settings__input"
            style="flex: 1;"
            :placeholder="
              settings.language === 'zh'
                ? '例如：D:\\BaiduNetdiskWorkspace\\SoloMD 或 ~/OneDrive/SoloMD'
                : 'e.g. ~/OneDrive/SoloMD or D:\\BaiduNetdiskWorkspace\\SoloMD'
            "
            @change="saveConfig"
          />
          <button
            type="button"
            class="settings__btn-secondary"
            @click="pickCloudVaultDir"
          >
            {{ settings.language === 'zh' ? '选择目录…' : 'Browse…' }}
          </button>
        </div>
      </label>

      <label
        v-if="settings.cloudVaultEncrypted"
        class="webdav-sync__field"
        style="grid-column: 1 / -1;"
      >
        <span>
          {{
            settings.language === 'zh'
              ? '网盘加密口令 (Passphrase — 本地派生密钥，多台设备输入相同口令即可解密同步)'
              : 'Vault Encryption Passphrase (used to derive XChaCha20-Poly1305 key via Argon2id)'
          }}
        </span>
        <input
          v-model="settings.cloudVaultPassphrase"
          type="password"
          class="settings__input"
          :placeholder="settings.language === 'zh' ? '输入网盘加密口令…' : 'Enter vault encryption passphrase…'"
          autocomplete="new-password"
          @change="saveConfig"
        />
      </label>
    </div>

    <label class="settings__row">
      <span>
        {{
          settings.language === 'zh'
            ? '📂 自动在网盘创建当前工作区专用子目录 (如 SoloMD/<笔记库名>/)'
            : '📂 Automatically create dedicated workspace folder (e.g. SoloMD/<WorkspaceName>/)'
        }}
      </span>
      <input
        v-model="settings.cloudVaultAutoSubdir"
        type="checkbox"
        @change="saveConfig"
      />
    </label>

    <label class="settings__row">
      <span>
        {{
          settings.language === 'zh'
            ? '🗂️ 保持子目录结构，并将根目录散落文件自动分门别类 (笔记文档/、图片素材/、文献附件/)'
            : '🗂️ Preserve subfolders and auto-categorize root files (Notes / Images / References)'
        }}
      </span>
      <input
        v-model="settings.cloudVaultCategorizeFiles"
        type="checkbox"
        @change="saveConfig"
      />
    </label>

    <label class="settings__row">
      <span>
        {{
          settings.language === 'zh'
            ? '🔒 对同步文件启用端到端加密 (.enc) — 关闭则直接存放明文 .md，可在手机网盘 App 直接查看'
            : '🔒 Encrypt files (.enc) — uncheck to store plaintext .md for direct viewing in mobile cloud apps'
        }}
      </span>
      <input
        v-model="settings.cloudVaultEncrypted"
        type="checkbox"
        @change="saveConfig"
      />
    </label>

    <label class="settings__row">
      <span>
        {{
          settings.language === 'zh'
            ? '保存笔记时自动同步到该网盘专用目录'
            : 'Auto-sync to cloud drive folder on save'
        }}
      </span>
      <input
        v-model="settings.cloudVaultAutoSync"
        type="checkbox"
        @change="saveConfig"
      />
    </label>

    <div class="webdav-sync__actions">
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="vaultPushing || !settings.cloudVaultDir || (settings.cloudVaultEncrypted && !settings.cloudVaultPassphrase)"
        @click="pushCloudVault"
      >
        {{
          vaultPushing
            ? (settings.language === 'zh' ? '正在同步到网盘目录…' : 'Syncing…')
            : settings.cloudVaultEncrypted
              ? (settings.language === 'zh' ? '🔒 加密分类同步到网盘目录 (Push)' : '🔒 Encrypt & Sync to Cloud Folder')
              : (settings.language === 'zh' ? '📂 分类同步到网盘专用目录 (Push)' : '📂 Sync to Dedicated Cloud Folder')
        }}
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="vaultPulling || !settings.cloudVaultDir || (settings.cloudVaultEncrypted && !settings.cloudVaultPassphrase)"
        @click="pullCloudVault"
      >
        {{
          vaultPulling
            ? (settings.language === 'zh' ? '正在从网盘拉取…' : 'Pulling…')
            : (settings.language === 'zh' ? '📥 从网盘专用目录同步还原 (Pull)' : '📥 Pull & Restore from Cloud Folder')
        }}
      </button>
    </div>

    <p
      v-if="vaultStatusText"
      class="webdav-sync__status"
      :class="{
        'webdav-sync__status--ok': vaultStatusKind === 'ok',
        'webdav-sync__status--err': vaultStatusKind === 'err',
      }"
    >
      {{ vaultStatusText }}
    </p>

    <hr style="border: 0; border-top: 1px solid var(--border); margin: 14px 0 6px;" />

    <h4 class="settings__heading">
      {{
        settings.language === 'zh'
          ? '网盘开放平台 & 对象存储直连 API · 免客户端专用目录同步 (百度网盘 / 阿里云盘 / OneDrive / Dropbox / Google Drive / Cloudflare R2)'
          : 'Direct Cloud Drive & Object Storage API · Clientless Folder Sync (Baidu / Aliyun / OneDrive / Dropbox / Google Drive / Cloudflare R2)'
      }}
    </h4>
    <p class="settings__hint">
      {{
        settings.language === 'zh'
          ? '不安装网盘桌面客户端也可直接同步：支持百度网盘、阿里云盘、OneDrive、Dropbox、Google Drive「一键免申请 Key 浏览器授权登录」，以及 Cloudflare R2 (S3 兼容) 零出口流量直连；自动在云端创建工作区专用目录、将本地笔记与图片分门别类增量上传，并具备三路合并防冲突与历史版本快照归档。'
          : 'Sync directly without installing a desktop client: supports 1-click keyless browser OAuth for Baidu Netdisk, Aliyun Drive, OneDrive, Dropbox, and Google Drive, plus zero-egress Cloudflare R2 (S3) storage with dedicated workspace folders, categorized files, 3-way conflict protection, and version snapshots.'
      }}
    </p>

    <div class="webdav-sync__presets">
      <span class="webdav-sync__preset-label">
        {{ settings.language === 'zh' ? '选择云盘 / 对象存储：' : 'Cloud Provider:' }}
      </span>
      <button
        type="button"
        class="settings__btn-secondary"
        :style="settings.cloudApiProvider === 'baidu' ? 'border-color: var(--accent); color: var(--accent); font-weight: 600;' : ''"
        @click="selectApiProvider('baidu')"
      >
        百度网盘 (Baidu Netdisk)
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :style="settings.cloudApiProvider === 'alipan' ? 'border-color: var(--accent); color: var(--accent); font-weight: 600;' : ''"
        @click="selectApiProvider('alipan')"
      >
        阿里云盘 (Alipan)
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :style="settings.cloudApiProvider === 'onedrive' ? 'border-color: var(--accent); color: var(--accent); font-weight: 600;' : ''"
        @click="selectApiProvider('onedrive')"
      >
        Microsoft OneDrive
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :style="settings.cloudApiProvider === 'gdrive' ? 'border-color: var(--accent); color: var(--accent); font-weight: 600;' : ''"
        @click="selectApiProvider('gdrive')"
      >
        Google Drive
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :style="settings.cloudApiProvider === 'dropbox' ? 'border-color: var(--accent); color: var(--accent); font-weight: 600;' : ''"
        @click="selectApiProvider('dropbox')"
      >
        Dropbox
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :style="settings.cloudApiProvider === 'r2' ? 'border-color: var(--accent); color: var(--accent); font-weight: 600;' : ''"
        @click="selectApiProvider('r2')"
      >
        Cloudflare R2 (S3)
      </button>
    </div>

    <div
      v-if="settings.cloudApiProvider !== 'r2'"
      class="webdav-sync__actions"
    >
      <button
        type="button"
        class="settings__btn-secondary"
        style="border-color: var(--accent); color: var(--accent); font-weight: 600;"
        @click="openQuickBrowserAuth"
      >
        {{
          settings.language === 'zh'
            ? '🚀 免申请 Key · 一键打开浏览器授权登录'
            : '🚀 1-Click Keyless Browser Authorization'
        }}
      </button>
      <button
        v-if="
          settings.cloudApiProvider === 'baidu' ||
          settings.cloudApiProvider === 'onedrive' ||
          settings.cloudApiProvider === 'gdrive'
        "
        type="button"
        class="settings__btn-secondary"
        :disabled="apiAuthLoading"
        @click="startDeviceAuth"
      >
        {{
          settings.language === 'zh'
            ? '📲 获取设备授权码 (Device Code)'
            : '📲 Get Device Code'
        }}
      </button>
      <button
        v-if="apiDeviceCode"
        type="button"
        class="settings__btn-secondary"
        :disabled="apiAuthLoading"
        @click="pollDeviceAuth"
      >
        {{
          settings.language === 'zh'
            ? '✅ 我已扫码授权，点击获取 Access Token'
            : '✅ Complete Authorization & Fetch Token'
        }}
      </button>
    </div>

    <div
      v-if="apiQuickAuthInstructions"
      style="padding: 8px 10px; border-radius: 6px; background: var(--bg-elevated, rgba(127,127,127,0.08)); font-size: 12px; line-height: 1.6;"
    >
      💡 {{ apiQuickAuthInstructions }}
    </div>

    <div
      v-if="apiUserCode"
      style="padding: 8px 10px; border-radius: 6px; background: var(--bg-elevated, rgba(127,127,127,0.08)); font-size: 12px; line-height: 1.6;"
    >
      <div>
        {{ settings.language === 'zh' ? '授权码 (User Code)：' : 'User Code: ' }}
        <strong style="font-family: monospace; font-size: 14px; color: var(--accent);">{{ apiUserCode }}</strong>
      </div>
      <div v-if="apiVerifyUrl">
        {{ settings.language === 'zh' ? '授权网址：' : 'Verification URL: ' }}
        <a :href="apiVerifyUrl" target="_blank" rel="noopener noreferrer">{{ apiVerifyUrl }}</a>
      </div>
    </div>

    <div class="webdav-sync__grid">
      <template v-if="settings.cloudApiProvider === 'r2'">
        <label class="webdav-sync__field">
          <span>
            {{
              settings.language === 'zh'
                ? 'Cloudflare Account ID 或 S3 Endpoint 地址'
                : 'Cloudflare Account ID or S3 Endpoint URL'
            }}
          </span>
          <input
            v-model="settings.cloudR2Endpoint"
            type="text"
            class="settings__input"
            placeholder="https://<account_id>.r2.cloudflarestorage.com 或直接填 Account ID"
            @change="saveConfig"
          />
        </label>

        <label class="webdav-sync__field">
          <span>
            {{
              settings.language === 'zh'
                ? 'R2 存储桶名称 (Bucket Name)'
                : 'R2 Bucket Name'
            }}
          </span>
          <input
            v-model="settings.cloudR2Bucket"
            type="text"
            class="settings__input"
            placeholder="solomd-notes"
            @change="saveConfig"
          />
        </label>

        <label class="webdav-sync__field">
          <span>Access Key ID</span>
          <input
            v-model="settings.cloudR2AccessKeyId"
            type="text"
            class="settings__input"
            placeholder="R2 API Token Access Key ID"
            autocomplete="off"
            @change="saveConfig"
          />
        </label>

        <label class="webdav-sync__field">
          <span>Secret Access Key</span>
          <input
            v-model="settings.cloudR2SecretAccessKey"
            type="password"
            class="settings__input"
            placeholder="R2 API Token Secret Access Key"
            autocomplete="new-password"
            @change="saveConfig"
          />
        </label>
      </template>

      <label v-else class="webdav-sync__field" style="grid-column: 1 / -1;">
        <span>
          {{
            settings.language === 'zh'
              ? '授权凭证 Access Token（支持直接粘贴浏览器授权跳转后的整段网址 URL，会自动提取 Token）'
              : 'Access Token (paste token or the full redirect URL after browser login — auto-extracted)'
          }}
        </span>
        <input
          v-model="settings.cloudApiToken"
          type="password"
          class="settings__input"
          :placeholder="
            settings.language === 'zh'
              ? '粘贴授权后的浏览器网址 URL 或 Access Token…'
              : 'Paste redirect URL or Access Token…'
          "
          autocomplete="new-password"
          @change="onTokenInputChange"
          @paste="onTokenInputPaste"
        />
      </label>

      <label class="webdav-sync__field">
        <span>
          {{
            settings.language === 'zh'
              ? '网盘远程根目录 (自动在其下建立工作区专用目录)'
              : 'Remote Base Directory'
          }}
        </span>
        <input
          v-model="settings.cloudApiRemotePath"
          type="text"
          class="settings__input"
          :placeholder="settings.cloudApiProvider === 'baidu' ? '/apps/SoloMD' : '/SoloMD'"
          @change="saveConfig"
        />
      </label>

      <label class="webdav-sync__field">
        <span>
          {{
            settings.language === 'zh'
              ? '网盘同步存储方式'
              : 'Cloud Sync Storage Mode'
          }}
        </span>
        <select
          v-model="settings.cloudApiSyncMode"
          class="settings__input"
          @change="saveConfig"
        >
          <option value="folder">
            {{
              settings.language === 'zh'
                ? '📂 专用目录 + 文件夹分类逐文件增量同步 (推荐)'
                : '📂 Dedicated Folder + Categorized Multi-file Sync (Recommended)'
            }}
          </option>
          <option value="bundle">
            {{
              settings.language === 'zh'
                ? '📦 单文件全库打包加密 (solomd-vault.enc)'
                : '📦 Single Encrypted Archive Bundle (solomd-vault.enc)'
            }}
          </option>
        </select>
      </label>

      <label
        v-if="settings.cloudApiSyncMode === 'bundle' || settings.cloudApiEncrypted"
        class="webdav-sync__field"
        style="grid-column: 1 / -1;"
      >
        <span>
          {{
            settings.language === 'zh'
              ? '端到端加密口令 (Passphrase — 多端同步请输入相同口令)'
              : 'Encryption Passphrase (enter same passphrase on all devices)'
          }}
        </span>
        <input
          v-model="settings.cloudApiPassphrase"
          type="password"
          class="settings__input"
          :placeholder="settings.language === 'zh' ? '输入端到端加密口令…' : 'Enter encryption passphrase…'"
          autocomplete="new-password"
          @change="saveConfig"
        />
      </label>
    </div>

    <template v-if="settings.cloudApiSyncMode === 'folder'">
      <label class="settings__row">
        <span>
          {{
            settings.language === 'zh'
              ? '📂 自动按工作区名称在网盘建立专用目录 (如 /apps/SoloMD/<工作区名>/)'
              : '📂 Auto-create dedicated workspace directory (e.g. /apps/SoloMD/<WorkspaceName>/)'
          }}
        </span>
        <input
          v-model="settings.cloudApiAutoSubdir"
          type="checkbox"
          @change="saveConfig"
        />
      </label>

      <label class="settings__row">
        <span>
          {{
            settings.language === 'zh'
              ? '🗂️ 保持本地子文件夹分类，并将根目录散落文件自动归类到「笔记文档 / 图片素材 / 文献附件」'
              : '🗂️ Keep subfolder tree and auto-categorize root files into Notes / Images / References'
          }}
        </span>
        <input
          v-model="settings.cloudApiCategorizeFiles"
          type="checkbox"
          @change="saveConfig"
        />
      </label>

      <label class="settings__row">
        <span>
          {{
            settings.language === 'zh'
              ? '🔒 在分类目录中对单文件启用 .enc 加密（关闭则保持原格式 .md，可在百度网盘 App 直接阅读）'
              : '🔒 Encrypt individual files (.enc) inside categorized folders'
          }}
        </span>
        <input
          v-model="settings.cloudApiEncrypted"
          type="checkbox"
          @change="saveConfig"
        />
      </label>
    </template>

    <details style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
      <summary style="cursor: pointer; user-select: none;">
        {{
          settings.language === 'zh'
            ? '⚙️ 高级选项：使用自定义开放平台 AppKey / SecretKey（默认免填）'
            : '⚙️ Advanced: Custom OpenAPI AppKey / SecretKey (optional)'
        }}
      </summary>
      <div class="webdav-sync__grid" style="margin-top: 8px;">
        <label class="webdav-sync__field">
          <span>AppKey / Client ID</span>
          <input
            v-model="settings.cloudApiClientId"
            type="text"
            class="settings__input"
            :placeholder="settings.cloudApiProvider === 'baidu' ? '内置默认 AppKey（可留空）' : 'Client ID'"
            @change="saveConfig"
          />
        </label>
        <label v-if="settings.cloudApiProvider === 'baidu'" class="webdav-sync__field">
          <span>SecretKey</span>
          <input
            v-model="settings.cloudApiClientSecret"
            type="password"
            class="settings__input"
            placeholder="仅设备码轮询模式需要（浏览器一键授权免填）"
            autocomplete="new-password"
            @change="saveConfig"
          />
        </label>
      </div>
    </details>

    <label class="settings__row">
      <span>
        {{
          settings.language === 'zh'
            ? '保存笔记时自动通过网盘 API 增量同步'
            : 'Auto-sync via Cloud Drive API on save'
        }}
      </span>
      <input
        v-model="settings.cloudApiAutoSync"
        type="checkbox"
        @change="saveConfig"
      />
    </label>

    <div class="webdav-sync__actions">
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="
          apiPushing ||
          !getEffectiveApiToken() ||
          ((settings.cloudApiSyncMode === 'bundle' || settings.cloudApiEncrypted) &&
            !settings.cloudApiPassphrase)
        "
        @click="pushCloudApi"
      >
        {{
          apiPushing
            ? (settings.language === 'zh' ? '正在同步上传到网盘…' : 'Uploading…')
            : settings.cloudApiSyncMode === 'folder'
              ? (settings.language === 'zh' ? '📂 增量分类同步到云端专用目录 (Push)' : '📂 Incremental Folder Push via Cloud API')
              : (settings.language === 'zh' ? '🔒 打包加密上传到云端 (Push)' : '🔒 Bundle & Push via Cloud API')
        }}
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="
          apiPulling ||
          !getEffectiveApiToken() ||
          ((settings.cloudApiSyncMode === 'bundle' || settings.cloudApiEncrypted) &&
            !settings.cloudApiPassphrase)
        "
        @click="pullCloudApi"
      >
        {{
          apiPulling
            ? (settings.language === 'zh' ? '正在从网盘拉取同步…' : 'Downloading…')
            : (settings.language === 'zh' ? '📥 从网盘专用目录拉取同步 (Pull)' : '📥 Pull & Sync via Cloud API')
        }}
      </button>
    </div>

    <p
      v-if="apiStatusText"
      class="webdav-sync__status"
      :class="{
        'webdav-sync__status--ok': apiStatusKind === 'ok',
        'webdav-sync__status--err': apiStatusKind === 'err',
      }"
    >
      {{ apiStatusText }}
    </p>

    <hr style="border: 0; border-top: 1px solid var(--border); margin: 14px 0 6px;" />

    <h4 class="settings__heading">
      {{
        settings.language === 'zh'
          ? '⏱️ 跨平台版本历史管理与云端版本归档 (.solomd-sync/versions)'
          : '⏱️ Cross-Platform Version History & Cloud Version Archiving'
      }}
    </h4>
    <p class="settings__hint">
      {{
        settings.language === 'zh'
          ? '每次保存笔记或网盘同步覆盖前，自动在工作区 .solomd-sync/versions/ 及网盘端归档历史快照（按 SHA-256 自动去重）。不依赖本地 Git，在桌面端与移动端均可随时通过右侧「历史版本」面板查看行级差异 (Diff) 并一键回滚恢复。'
          : 'Automatically archives deduplicated file snapshots into .solomd-sync/versions/ on save and before cloud sync overwrites. Works across desktop and mobile without requiring Git.'
      }}
    </p>

    <label class="settings__row">
      <span>
        {{
          settings.language === 'zh'
            ? '保存与同步时自动留存历史版本快照'
            : 'Automatically save version snapshots on save & sync'
        }}
      </span>
      <input
        v-model="settings.autoSnapshotOnSave"
        type="checkbox"
        @change="saveConfig"
      />
    </label>

    <div class="webdav-sync__grid">
      <label class="webdav-sync__field">
        <span>
          {{
            settings.language === 'zh'
              ? '单篇笔记最大保留历史版本数 (超出自动清理最旧快照)'
              : 'Max Version Snapshots per File'
          }}
        </span>
        <select
          v-model.number="settings.syncMaxVersions"
          class="settings__input"
          @change="saveConfig"
        >
          <option :value="10">10 个版本</option>
          <option :value="20">20 个版本 (推荐)</option>
          <option :value="50">50 个版本</option>
          <option :value="100">100 个版本</option>
        </select>
      </label>
    </div>

    <div class="webdav-sync__actions">
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="pruningVersions"
        @click="pruneOldVersions"
      >
        {{
          pruningVersions
            ? (settings.language === 'zh' ? '正在清理…' : 'Pruning…')
            : (settings.language === 'zh' ? '🧹 立即按保留数量清理旧版本快照' : '🧹 Prune Old Snapshots Now')
        }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.webdav-sync {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.webdav-sync__presets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.webdav-sync__preset-label {
  font-size: 12px;
  color: var(--text-muted);
}
.webdav-sync__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
}
.webdav-sync__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}
.webdav-sync__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.webdav-sync__status {
  margin: 2px 0 0;
  font-size: 12px;
}
.webdav-sync__status--ok {
  color: var(--accent);
}
.webdav-sync__status--err {
  color: #e5534b;
}
</style>
