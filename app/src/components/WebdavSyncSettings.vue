<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

export type SyncSubTab = 'git' | 'cloud_api' | 'local_vault' | 'webdav' | 'history';

const props = withDefaults(
  defineProps<{
    activeTab?: SyncSubTab;
    searching?: boolean;
    includeGitTab?: boolean;
  }>(),
  {
    activeTab: undefined,
    searching: false,
    includeGitTab: false,
  },
);

const emit = defineEmits<{
  (e: 'update:activeTab', val: SyncSubTab): void;
}>();

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

const internalSyncTab = ref<SyncSubTab>(
  settings.cloudApiToken || settings.cloudR2Endpoint
    ? 'cloud_api'
    : settings.cloudVaultDir
      ? 'local_vault'
      : settings.webdavUrl || settings.webdavEnabled
        ? 'webdav'
        : 'cloud_api',
);

const currentTab = computed<SyncSubTab>({
  get: () => props.activeTab ?? internalSyncTab.value,
  set: (val) => {
    internalSyncTab.value = val;
    emit('update:activeTab', val);
  },
});

// #525 — Passphrase + confirmation state for each sync mode.
// Only when both inputs match does the passphrase take effect.
const webdavPassInput = ref(settings.webdavPassphrase);
const webdavPassConfirm = ref(settings.webdavPassphrase);
const vaultPassInput = ref(settings.cloudVaultPassphrase);
const vaultPassConfirm = ref(settings.cloudVaultPassphrase);
const apiPassInput = ref(settings.cloudApiPassphrase);
const apiPassConfirm = ref(settings.cloudApiPassphrase);

const webdavPassMismatch = computed(
  () => Boolean(settings.webdavEncrypted && webdavPassInput.value !== webdavPassConfirm.value),
);
const vaultPassMismatch = computed(
  () => Boolean(settings.cloudVaultEncrypted && vaultPassInput.value !== vaultPassConfirm.value),
);
const apiPassMismatch = computed(
  () =>
    Boolean(
      (settings.cloudApiSyncMode === 'bundle' || settings.cloudApiEncrypted) &&
        apiPassInput.value !== apiPassConfirm.value,
    ),
);

function detectWebdavServerType(url: string): 'nutstore' | 'nextcloud' | 'alist' | 'custom' {
  const u = (url || '').trim();
  if (!u || u.includes('jianguoyun.com')) return 'nutstore';
  if (u.includes('remote.php/dav')) return 'nextcloud';
  if (u.includes(':5244/dav')) return 'alist';
  return 'custom';
}

const webdavServerType = ref<'nutstore' | 'nextcloud' | 'alist' | 'custom'>(
  detectWebdavServerType(settings.webdavUrl),
);

watch(
  () => settings.webdavUrl,
  (u) => {
    webdavServerType.value = detectWebdavServerType(u);
  },
);

function onWebdavServerTypeChange() {
  if (webdavServerType.value === 'nutstore') {
    applyPreset('https://dav.jianguoyun.com/dav');
  } else if (webdavServerType.value === 'nextcloud') {
    applyPreset('https://your-domain.com/remote.php/dav/files/USERNAME');
  } else if (webdavServerType.value === 'alist') {
    applyPreset('http://127.0.0.1:5244/dav');
  }
}

function syncSharedPassphrase() {
  const shared =
    (!apiPassMismatch.value && apiPassInput.value.trim()) ||
    (!vaultPassMismatch.value && vaultPassInput.value.trim()) ||
    (!webdavPassMismatch.value && webdavPassInput.value.trim()) ||
    settings.cloudApiPassphrase.trim() ||
    settings.cloudVaultPassphrase.trim() ||
    settings.webdavPassphrase.trim();
  if (!shared) return;
  if (!settings.cloudApiPassphrase && !apiPassInput.value && !apiPassConfirm.value) {
    settings.cloudApiPassphrase = shared;
    apiPassInput.value = shared;
    apiPassConfirm.value = shared;
  }
  if (!settings.cloudVaultPassphrase && !vaultPassInput.value && !vaultPassConfirm.value) {
    settings.cloudVaultPassphrase = shared;
    vaultPassInput.value = shared;
    vaultPassConfirm.value = shared;
  }
  if (!settings.webdavPassphrase && !webdavPassInput.value && !webdavPassConfirm.value) {
    settings.webdavPassphrase = shared;
    webdavPassInput.value = shared;
    webdavPassConfirm.value = shared;
  }
}

function onWebdavPassChange() {
  if (webdavPassInput.value === webdavPassConfirm.value) {
    settings.webdavPassphrase = webdavPassInput.value;
    saveConfig();
  }
}

function onVaultPassChange() {
  if (vaultPassInput.value === vaultPassConfirm.value) {
    settings.cloudVaultPassphrase = vaultPassInput.value;
    saveConfig();
  }
}

function onApiPassChange() {
  if (apiPassInput.value === apiPassConfirm.value) {
    settings.cloudApiPassphrase = apiPassInput.value;
    saveConfig();
  }
}

onMounted(async () => {
  webdavPassInput.value = settings.webdavPassphrase;
  webdavPassConfirm.value = settings.webdavPassphrase;
  vaultPassInput.value = settings.cloudVaultPassphrase;
  vaultPassConfirm.value = settings.cloudVaultPassphrase;
  apiPassInput.value = settings.cloudApiPassphrase;
  apiPassConfirm.value = settings.cloudApiPassphrase;
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

function validateApiPassphrase(): boolean {
  const needsPass = settings.cloudApiSyncMode === 'bundle' || settings.cloudApiEncrypted;
  if (!needsPass) return true;
  if (apiPassMismatch.value) {
    const msg =
      settings.language === 'zh'
        ? '加密口令与确认加密口令不一致，请修改一致后再执行同步'
        : 'Encryption passphrase and confirmation do not match';
    apiStatusText.value = msg;
    apiStatusKind.value = 'err';
    toasts.error(msg);
    return false;
  }
  settings.cloudApiPassphrase = apiPassInput.value;
  syncSharedPassphrase();
  if (!settings.cloudApiPassphrase.trim()) {
    const msg =
      settings.language === 'zh'
        ? '请先输入端到端加密口令并确认一致后再执行加密同步'
        : 'Please enter and confirm an encryption passphrase before syncing';
    apiStatusText.value = msg;
    apiStatusKind.value = 'err';
    toasts.warning(msg);
    return false;
  }
  settings.persist();
  return true;
}

async function pushCloudApi() {
  if (!workspace.currentFolder) {
    toasts.warning(t('menubar.openFolder'));
    return;
  }
  if (!validateApiPassphrase()) return;
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
  if (!validateApiPassphrase()) return;
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
  syncSharedPassphrase();
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

function validateWebdavPassphrase(): boolean {
  if (!settings.webdavEncrypted) return true;
  if (webdavPassMismatch.value) {
    const msg =
      settings.language === 'zh'
        ? '加密口令与确认加密口令不一致，请修改一致后再执行上传或下载'
        : 'Encryption passphrase and confirmation do not match';
    statusText.value = msg;
    statusKind.value = 'err';
    toasts.error(msg);
    return false;
  }
  settings.webdavPassphrase = webdavPassInput.value;
  syncSharedPassphrase();
  if (!settings.webdavPassphrase.trim()) {
    const msg =
      settings.language === 'zh'
        ? '请先输入加密口令并确认一致后再执行加密上传或下载'
        : 'Please enter and confirm an encryption passphrase first';
    statusText.value = msg;
    statusKind.value = 'err';
    toasts.warning(msg);
    return false;
  }
  settings.persist();
  return true;
}

async function pushWorkspace() {
  if (!workspace.currentFolder) {
    toasts.warning(t('menubar.openFolder'));
    return;
  }
  if (!validateWebdavPassphrase()) return;
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
  if (!validateWebdavPassphrase()) return;
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

function validateVaultPassphrase(): boolean {
  if (!settings.cloudVaultEncrypted) return true;
  if (vaultPassMismatch.value) {
    const msg =
      settings.language === 'zh'
        ? '加密口令与确认加密口令不一致，请修改一致后再执行同步'
        : 'Encryption passphrase and confirmation do not match';
    vaultStatusText.value = msg;
    vaultStatusKind.value = 'err';
    toasts.error(msg);
    return false;
  }
  settings.cloudVaultPassphrase = vaultPassInput.value;
  syncSharedPassphrase();
  if (!settings.cloudVaultPassphrase.trim()) {
    const msg =
      settings.language === 'zh'
        ? '请先输入网盘加密口令并确认一致后再执行加密同步'
        : 'Please enter and confirm a vault encryption passphrase first';
    vaultStatusText.value = msg;
    vaultStatusKind.value = 'err';
    toasts.warning(msg);
    return false;
  }
  settings.persist();
  return true;
}

async function pushCloudVault() {
  if (!workspace.currentFolder) {
    toasts.warning(t('menubar.openFolder'));
    return;
  }
  if (!validateVaultPassphrase()) return;
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
  if (!validateVaultPassphrase()) return;
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
    <nav v-if="!searching" class="webdav-sync__subnav" role="tablist" aria-label="Sync mode navigation">
      <button
        v-if="includeGitTab"
        type="button"
        role="tab"
        class="webdav-sync__subnav-tab"
        :class="{ 'webdav-sync__subnav-tab--active': currentTab === 'git' }"
        :aria-selected="currentTab === 'git'"
        @click="currentTab = 'git'"
      >
        {{
          settings.language === 'zh'
            ? '🔀 Git 同步 (GitHub/GitLab/Gitea)'
            : '🔀 Git Sync (GitHub/GitLab/Gitea)'
        }}
      </button>
      <button
        type="button"
        role="tab"
        class="webdav-sync__subnav-tab"
        :class="{ 'webdav-sync__subnav-tab--active': currentTab === 'cloud_api' }"
        :aria-selected="currentTab === 'cloud_api'"
        @click="currentTab = 'cloud_api'"
      >
        {{
          settings.language === 'zh'
            ? '☁️ 网盘直连 API (百度/阿里/OneDrive/R2)'
            : '☁️ Direct Cloud API (Baidu/Aliyun/OneDrive/R2)'
        }}
      </button>
      <button
        type="button"
        role="tab"
        class="webdav-sync__subnav-tab"
        :class="{ 'webdav-sync__subnav-tab--active': currentTab === 'local_vault' }"
        :aria-selected="currentTab === 'local_vault'"
        @click="currentTab = 'local_vault'"
      >
        {{
          settings.language === 'zh'
            ? '📂 本地网盘目录同步'
            : '📂 Local Cloud Drive Folder'
        }}
      </button>
      <button
        type="button"
        role="tab"
        class="webdav-sync__subnav-tab"
        :class="{ 'webdav-sync__subnav-tab--active': currentTab === 'webdav' }"
        :aria-selected="currentTab === 'webdav'"
        @click="currentTab = 'webdav'"
      >
        {{
          settings.language === 'zh'
            ? '🌐 WebDAV 同步 (坚果云/NAS/AList)'
            : '🌐 WebDAV (Nutstore/NAS/AList)'
        }}
      </button>
      <button
        type="button"
        role="tab"
        class="webdav-sync__subnav-tab"
        :class="{ 'webdav-sync__subnav-tab--active': currentTab === 'history' }"
        :aria-selected="currentTab === 'history'"
        @click="currentTab = 'history'"
      >
        {{
          settings.language === 'zh'
            ? '⏱️ 历史版本与快照策略'
            : '⏱️ Version History & Snapshots'
        }}
      </button>
    </nav>

    <!-- ==================== WebDAV 同步 (#525 布局优化) ==================== -->
    <div v-show="searching || currentTab === 'webdav'" class="webdav-sync__panel">
      <h4 class="settings__heading">
        {{ settings.language === 'zh' ? 'WebDAV 同步' : 'WebDAV Sync' }}
      </h4>
      <div class="webdav-sync__info-banner">
        <strong>{{ settings.language === 'zh' ? '说明：' : 'Note: ' }}</strong>
        {{
          settings.language === 'zh'
            ? '通过标准 WebDAV 协议同步当前笔记文件夹（支持坚果云、Nextcloud、群晖 NAS 以及通过 AList/OpenList 挂载的百度网盘、阿里云盘、夸克网盘、123云盘、OneDrive 等）。开启端到端加密后，网盘端仅存储 XChaCha20-Poly1305 密文。'
            : 'Sync your workspace folder over standard WebDAV (Nutstore, Nextcloud, Synology NAS, or AList/OpenList mounted cloud drives). When encryption is enabled, only XChaCha20-Poly1305 ciphertext is stored remotely.'
        }}
      </div>

      <div class="webdav-sync__check-grid">
        <label
          class="webdav-sync__check-item"
          :title="
            settings.language === 'zh'
              ? '1、该选项选中时，底下所有控件都有效；2、未选中时，底下所有控件都无效'
              : 'When checked, all WebDAV controls below are enabled; when unchecked, controls below are disabled.'
          "
        >
          <input
            v-model="settings.webdavEnabled"
            type="checkbox"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '启用 WebDAV 同步' : 'Enable WebDAV Sync' }}
          </span>
        </label>

        <label
          class="webdav-sync__check-item"
          :class="{ 'webdav-sync__check-item--disabled': !settings.webdavEnabled }"
          :title="
            settings.language === 'zh'
              ? '在 WebDAV 创建当前工作区专用子目录 (如 /SoloMD/<工作区名>/)'
              : 'Automatically create a dedicated subfolder for the current workspace (e.g. /SoloMD/<WorkspaceName>/)'
          "
        >
          <input
            v-model="settings.webdavAutoSubdir"
            type="checkbox"
            :disabled="!settings.webdavEnabled"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '创建工作区子目录' : 'Create Workspace Subfolder' }}
          </span>
        </label>

        <label
          class="webdav-sync__check-item"
          :class="{ 'webdav-sync__check-item--disabled': !settings.webdavEnabled }"
          :title="
            settings.language === 'zh'
              ? '加密上传到 WebDAV 服务器，下载时自动解密 (加解密算法：XChaCha20-Poly1305 + Argon2id)'
              : 'Encrypt files before uploading to WebDAV and decrypt automatically on download (XChaCha20-Poly1305 + Argon2id)'
          "
        >
          <input
            v-model="settings.webdavEncrypted"
            type="checkbox"
            :disabled="!settings.webdavEnabled"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '文件加密' : 'Encrypt Files' }}
          </span>
        </label>

        <label
          class="webdav-sync__check-item"
          :class="{ 'webdav-sync__check-item--disabled': !settings.webdavEnabled }"
          :title="
            settings.language === 'zh'
              ? '保持子目录结构，并将根目录散落文件自动分门别类 (笔记文档 / 图片素材 / 文献附件)'
              : 'Preserve subfolder structure and auto-categorize root files (Notes / Images / References)'
          "
        >
          <input
            v-model="settings.webdavCategorizeFiles"
            type="checkbox"
            :disabled="!settings.webdavEnabled"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '保持目录结构' : 'Keep Directory Structure' }}
          </span>
        </label>

        <label
          class="webdav-sync__check-item"
          :class="{ 'webdav-sync__check-item--disabled': !settings.webdavEnabled }"
          :title="
            settings.language === 'zh'
              ? '保存笔记时自动同步到 WebDAV 服务器'
              : 'Automatically sync to WebDAV server when saving notes'
          "
        >
          <input
            v-model="settings.webdavAutoSync"
            type="checkbox"
            :disabled="!settings.webdavEnabled"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '保存时自动同步' : 'Auto-sync on Save' }}
          </span>
        </label>
      </div>

      <fieldset class="webdav-sync__fieldset" :disabled="!settings.webdavEnabled">
        <div class="webdav-sync__server-row">
          <label class="webdav-sync__inline-label">
            <span>{{ settings.language === 'zh' ? '服务器类型：' : 'Server Type:' }}</span>
            <select
              v-model="webdavServerType"
              class="settings__input webdav-sync__server-select"
              @change="onWebdavServerTypeChange"
            >
              <option value="nutstore">坚果云 (Nutstore)</option>
              <option value="nextcloud">Nextcloud</option>
              <option value="alist">AList / OpenList</option>
              <option value="custom">{{ settings.language === 'zh' ? '自定义 WebDAV' : 'Custom WebDAV' }}</option>
            </select>
          </label>
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

          <template v-if="settings.webdavEncrypted">
            <label class="webdav-sync__field">
              <span>{{ settings.language === 'zh' ? '加密口令' : 'Encryption Passphrase' }}</span>
              <input
                v-model="webdavPassInput"
                type="password"
                class="settings__input"
                :class="{ 'webdav-sync__input--error': webdavPassMismatch }"
                :placeholder="settings.language === 'zh' ? '输入加密口令…' : 'Enter encryption passphrase…'"
                autocomplete="new-password"
                @input="onWebdavPassChange"
                @change="onWebdavPassChange"
              />
            </label>

            <label class="webdav-sync__field">
              <span>{{ settings.language === 'zh' ? '确认加密口令' : 'Confirm Encryption Passphrase' }}</span>
              <input
                v-model="webdavPassConfirm"
                type="password"
                class="settings__input"
                :class="{ 'webdav-sync__input--error': webdavPassMismatch }"
                :placeholder="settings.language === 'zh' ? '再次输入加密口令以确认…' : 'Re-enter passphrase to confirm…'"
                autocomplete="new-password"
                @input="onWebdavPassChange"
                @change="onWebdavPassChange"
              />
            </label>
          </template>
        </div>

        <p v-if="webdavPassMismatch" class="webdav-sync__mismatch-warn">
          {{
            settings.language === 'zh'
              ? '⚠️ 两次输入的加密口令不一致！只有两个密码一致时，密码设置才生效。'
              : '⚠️ Passphrases do not match! Both fields must match for the passphrase to take effect.'
          }}
        </p>

        <div v-if="settings.webdavEncrypted" class="webdav-sync__warning-box">
          <strong>{{ settings.language === 'zh' ? '警告：' : 'Warning:' }}</strong>
          <ol>
            <li>
              {{
                settings.language === 'zh'
                  ? '请牢记加密口令，口令丢失将导致笔记无法解密，造成数据丢失！'
                  : 'Please remember your encryption passphrase. Losing it will make encrypted notes unrecoverable!'
              }}
            </li>
            <li>
              {{
                settings.language === 'zh'
                  ? '本软件仅提供加解密功能和上传下载服务，由于口令管理不善或网盘操作不当导致数据丢失，本人不承担任何责任，本软件也无法提供恢复操作，请谨慎使用！'
                  : 'This software only provides local encryption/decryption and upload/download transport. Lost passphrases cannot be recovered — please use with care!'
              }}
            </li>
          </ol>
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
                : (settings.language === 'zh' ? '测试 WebDAV 连接' : 'Test WebDAV Connection')
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
                : (settings.language === 'zh' ? '上传到 WebDAV 服务器' : 'Upload to WebDAV Server')
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
                : (settings.language === 'zh' ? '从 WebDAV 服务器下载' : 'Download from WebDAV Server')
            }}
          </button>
        </div>
      </fieldset>

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
    </div>

    <!-- ==================== 本地网盘同步目录 (#525 布局优化) ==================== -->
    <div v-show="searching || currentTab === 'local_vault'" class="webdav-sync__panel">
      <h4 class="settings__heading">
        {{
          settings.language === 'zh'
            ? '个人网盘同步目录 (百度网盘 / 阿里云盘 / 夸克 / OneDrive / iCloud)'
            : 'Personal Cloud Drive Local Sync Folder'
        }}
      </h4>
      <div class="webdav-sync__info-banner">
        <strong>{{ settings.language === 'zh' ? '说明：' : 'Note: ' }}</strong>
        {{
          settings.language === 'zh'
            ? '无需申请开放平台 Key：直接选择本机网盘客户端同步盘目录。SoloMD 会自动在网盘下创建当前工作区专用目录，将笔记与图片分门别类存放，并同步版本历史快照（可选明文存放或开启 .enc 端到端加密）。'
            : 'No API key required: select your local cloud drive client folder. SoloMD creates a dedicated workspace folder, categorizes your files, and syncs version snapshots with optional XChaCha20-Poly1305 encryption.'
        }}
      </div>

      <div v-if="detectedCloudDirs.length > 0" class="webdav-sync__presets">
        <span class="webdav-sync__preset-label">
          {{ settings.language === 'zh' ? '✨ 检测到本机网盘目录（点击填入）：' : '✨ Detected Local Cloud Drives:' }}
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

      <div class="webdav-sync__check-grid">
        <label
          class="webdav-sync__check-item"
          :title="
            settings.language === 'zh'
              ? '在本地网盘目录下创建当前工作区专用子目录 (如 SoloMD/<工作区名>/)'
              : 'Create a dedicated subfolder for the current workspace (e.g. SoloMD/<WorkspaceName>/)'
          "
        >
          <input
            v-model="settings.cloudVaultAutoSubdir"
            type="checkbox"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '创建工作区子目录' : 'Create Workspace Subfolder' }}
          </span>
        </label>

        <label
          class="webdav-sync__check-item"
          :title="
            settings.language === 'zh'
              ? '保持子目录结构，并将根目录散落文件自动分门别类 (笔记文档 / 图片素材 / 文献附件)'
              : 'Preserve subfolder structure and auto-categorize root files (Notes / Images / References)'
          "
        >
          <input
            v-model="settings.cloudVaultCategorizeFiles"
            type="checkbox"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '保持目录结构' : 'Keep Directory Structure' }}
          </span>
        </label>

        <label
          class="webdav-sync__check-item"
          :title="
            settings.language === 'zh'
              ? '对同步文件启用端到端加密 (.enc)，下载时自动解密 (加解密算法：XChaCha20-Poly1305 + Argon2id)；关闭则存放明文 .md'
              : 'Encrypt synced files (.enc) with XChaCha20-Poly1305 + Argon2id; uncheck to keep plaintext .md'
          "
        >
          <input
            v-model="settings.cloudVaultEncrypted"
            type="checkbox"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '文件加密' : 'Encrypt Files' }}
          </span>
        </label>

        <label
          class="webdav-sync__check-item"
          :title="
            settings.language === 'zh'
              ? '保存笔记时自动同步到该网盘专用目录'
              : 'Automatically sync to the local cloud drive folder when saving notes'
          "
        >
          <input
            v-model="settings.cloudVaultAutoSync"
            type="checkbox"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '保存时自动同步' : 'Auto-sync on Save' }}
          </span>
        </label>
      </div>

      <div class="webdav-sync__grid">
        <label class="webdav-sync__field" style="grid-column: 1 / -1;">
          <span>
            {{ settings.language === 'zh' ? '个人网盘本地同步目录' : 'Cloud Drive Sync Folder' }}
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

        <template v-if="settings.cloudVaultEncrypted">
          <label class="webdav-sync__field">
            <span>{{ settings.language === 'zh' ? '加密口令' : 'Encryption Passphrase' }}</span>
            <input
              v-model="vaultPassInput"
              type="password"
              class="settings__input"
              :class="{ 'webdav-sync__input--error': vaultPassMismatch }"
              :placeholder="settings.language === 'zh' ? '输入加密口令…' : 'Enter encryption passphrase…'"
              autocomplete="new-password"
              @input="onVaultPassChange"
              @change="onVaultPassChange"
            />
          </label>

          <label class="webdav-sync__field">
            <span>{{ settings.language === 'zh' ? '确认加密口令' : 'Confirm Encryption Passphrase' }}</span>
            <input
              v-model="vaultPassConfirm"
              type="password"
              class="settings__input"
              :class="{ 'webdav-sync__input--error': vaultPassMismatch }"
              :placeholder="settings.language === 'zh' ? '再次输入加密口令以确认…' : 'Re-enter passphrase to confirm…'"
              autocomplete="new-password"
              @input="onVaultPassChange"
              @change="onVaultPassChange"
            />
          </label>
        </template>
      </div>

      <p v-if="vaultPassMismatch" class="webdav-sync__mismatch-warn">
        {{
          settings.language === 'zh'
            ? '⚠️ 两次输入的加密口令不一致！只有两个密码一致时，密码设置才生效。'
            : '⚠️ Passphrases do not match! Both fields must match for the passphrase to take effect.'
        }}
      </p>

      <div v-if="settings.cloudVaultEncrypted" class="webdav-sync__warning-box">
        <strong>{{ settings.language === 'zh' ? '警告：' : 'Warning:' }}</strong>
        <ol>
          <li>
            {{
              settings.language === 'zh'
                ? '请牢记加密口令，口令丢失将导致笔记无法解密，造成数据丢失！'
                : 'Please remember your encryption passphrase. Losing it will make encrypted notes unrecoverable!'
            }}
          </li>
          <li>
            {{
              settings.language === 'zh'
                ? '本软件仅提供加解密功能和上传下载服务，由于口令管理不善或网盘操作不当导致数据丢失，本人不承担任何责任，本软件也无法提供恢复操作，请谨慎使用！'
                : 'This software only provides local encryption/decryption and sync transport. Lost passphrases cannot be recovered — please use with care!'
            }}
          </li>
        </ol>
      </div>

      <div class="webdav-sync__actions">
        <button
          type="button"
          class="settings__btn-secondary"
          :disabled="vaultPushing || !settings.cloudVaultDir"
          @click="pushCloudVault"
        >
          {{
            vaultPushing
              ? (settings.language === 'zh' ? '正在同步到网盘目录…' : 'Syncing…')
              : (settings.language === 'zh' ? '上传到网盘同步目录' : 'Sync to Cloud Folder')
          }}
        </button>
        <button
          type="button"
          class="settings__btn-secondary"
          :disabled="vaultPulling || !settings.cloudVaultDir"
          @click="pullCloudVault"
        >
          {{
            vaultPulling
              ? (settings.language === 'zh' ? '正在从网盘拉取…' : 'Pulling…')
              : (settings.language === 'zh' ? '从网盘同步目录还原' : 'Restore from Cloud Folder')
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
    </div>

    <!-- ==================== 网盘直连 API (#525 布局优化) ==================== -->
    <div v-show="searching || currentTab === 'cloud_api'" class="webdav-sync__panel">
      <h4 class="settings__heading">
        {{
          settings.language === 'zh'
            ? '网盘开放平台 & 对象存储直连 API (百度网盘 / 阿里云盘 / OneDrive / Google Drive / Dropbox / R2)'
            : 'Direct Cloud Drive & Object Storage API'
        }}
      </h4>
      <div class="webdav-sync__info-banner">
        <strong>{{ settings.language === 'zh' ? '说明：' : 'Note: ' }}</strong>
        {{
          settings.language === 'zh'
            ? '免安装网盘桌面客户端：支持百度网盘、阿里云盘、OneDrive、Dropbox、Google Drive「一键免申请 Key 浏览器授权登录」，以及 Cloudflare R2 (S3) 对象存储直连；支持单文件 .enc 端到端加密或全库打包加密。'
            : 'Sync directly without installing a desktop client: supports 1-click keyless browser OAuth for Baidu Netdisk, Aliyun Drive, OneDrive, Dropbox, and Google Drive, plus Cloudflare R2 (S3) storage.'
        }}
      </div>

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

      <div v-if="settings.cloudApiSyncMode === 'folder'" class="webdav-sync__check-grid">
        <label
          class="webdav-sync__check-item"
          :title="
            settings.language === 'zh'
              ? '自动按工作区名称在网盘建立专用子目录 (如 /apps/SoloMD/<工作区名>/)'
              : 'Auto-create dedicated workspace directory (e.g. /apps/SoloMD/<WorkspaceName>/)'
          "
        >
          <input
            v-model="settings.cloudApiAutoSubdir"
            type="checkbox"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '创建工作区子目录' : 'Create Workspace Subfolder' }}
          </span>
        </label>

        <label
          class="webdav-sync__check-item"
          :title="
            settings.language === 'zh'
              ? '保持本地子文件夹分类，并将根目录散落文件自动归类到「笔记文档 / 图片素材 / 文献附件」'
              : 'Keep subfolder tree and auto-categorize root files into Notes / Images / References'
          "
        >
          <input
            v-model="settings.cloudApiCategorizeFiles"
            type="checkbox"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '保持目录结构' : 'Keep Directory Structure' }}
          </span>
        </label>

        <label
          class="webdav-sync__check-item"
          :title="
            settings.language === 'zh'
              ? '对单文件启用 .enc 加密上传，下载时自动解密 (XChaCha20-Poly1305 + Argon2id)；关闭则保持明文 .md'
              : 'Encrypt individual files (.enc) before uploading and decrypt automatically on download'
          "
        >
          <input
            v-model="settings.cloudApiEncrypted"
            type="checkbox"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '文件加密' : 'Encrypt Files' }}
          </span>
        </label>

        <label
          class="webdav-sync__check-item"
          :title="
            settings.language === 'zh'
              ? '保存笔记时自动通过网盘 API 增量同步'
              : 'Automatically sync via Cloud Drive API when saving notes'
          "
        >
          <input
            v-model="settings.cloudApiAutoSync"
            type="checkbox"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '保存时自动同步' : 'Auto-sync on Save' }}
          </span>
        </label>
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
              placeholder="https://<account_id>.r2.cloudflarestorage.com"
              @change="saveConfig"
            />
          </label>

          <label class="webdav-sync__field">
            <span>
              {{ settings.language === 'zh' ? 'R2 存储桶名称 (Bucket Name)' : 'R2 Bucket Name' }}
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
          <span
            :title="
              settings.language === 'zh'
                ? '支持直接粘贴浏览器授权跳转后的整段网址 URL，会自动提取 Token'
                : 'Paste token or the full redirect URL after browser login — auto-extracted'
            "
          >
            {{
              settings.language === 'zh'
                ? '授权凭证 Access Token (支持直接粘贴授权后跳转网址)'
                : 'Access Token (or paste full redirect URL)'
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
            {{ settings.language === 'zh' ? '网盘远程根目录' : 'Remote Base Directory' }}
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
            {{ settings.language === 'zh' ? '网盘同步存储方式' : 'Cloud Sync Storage Mode' }}
          </span>
          <select
            v-model="settings.cloudApiSyncMode"
            class="settings__input"
            @change="saveConfig"
          >
            <option value="folder">
              {{
                settings.language === 'zh'
                  ? '📂 专用目录逐文件增量同步 (推荐)'
                  : '📂 Dedicated Folder Multi-file Sync (Recommended)'
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

        <template v-if="settings.cloudApiSyncMode === 'bundle' || settings.cloudApiEncrypted">
          <label class="webdav-sync__field">
            <span>{{ settings.language === 'zh' ? '加密口令' : 'Encryption Passphrase' }}</span>
            <input
              v-model="apiPassInput"
              type="password"
              class="settings__input"
              :class="{ 'webdav-sync__input--error': apiPassMismatch }"
              :placeholder="settings.language === 'zh' ? '输入加密口令…' : 'Enter encryption passphrase…'"
              autocomplete="new-password"
              @input="onApiPassChange"
              @change="onApiPassChange"
            />
          </label>

          <label class="webdav-sync__field">
            <span>{{ settings.language === 'zh' ? '确认加密口令' : 'Confirm Encryption Passphrase' }}</span>
            <input
              v-model="apiPassConfirm"
              type="password"
              class="settings__input"
              :class="{ 'webdav-sync__input--error': apiPassMismatch }"
              :placeholder="settings.language === 'zh' ? '再次输入加密口令以确认…' : 'Re-enter passphrase to confirm…'"
              autocomplete="new-password"
              @input="onApiPassChange"
              @change="onApiPassChange"
            />
          </label>
        </template>
      </div>

      <p v-if="apiPassMismatch" class="webdav-sync__mismatch-warn">
        {{
          settings.language === 'zh'
            ? '⚠️ 两次输入的加密口令不一致！只有两个密码一致时，密码设置才生效。'
            : '⚠️ Passphrases do not match! Both fields must match for the passphrase to take effect.'
        }}
      </p>

      <div
        v-if="settings.cloudApiSyncMode === 'bundle' || settings.cloudApiEncrypted"
        class="webdav-sync__warning-box"
      >
        <strong>{{ settings.language === 'zh' ? '警告：' : 'Warning:' }}</strong>
        <ol>
          <li>
            {{
              settings.language === 'zh'
                ? '请牢记加密口令，口令丢失将导致笔记无法解密，造成数据丢失！'
                : 'Please remember your encryption passphrase. Losing it will make encrypted notes unrecoverable!'
            }}
          </li>
          <li>
            {{
              settings.language === 'zh'
                ? '本软件仅提供加解密功能和上传下载服务，由于口令管理不善或网盘操作不当导致数据丢失，本人不承担任何责任，本软件也无法提供恢复操作，请谨慎使用！'
                : 'This software only provides local encryption/decryption and upload/download transport. Lost passphrases cannot be recovered — please use with care!'
            }}
          </li>
        </ol>
      </div>

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

      <div class="webdav-sync__actions">
        <button
          type="button"
          class="settings__btn-secondary"
          :disabled="apiPushing || !getEffectiveApiToken()"
          @click="pushCloudApi"
        >
          {{
            apiPushing
              ? (settings.language === 'zh' ? '正在上传到网盘…' : 'Uploading…')
              : (settings.language === 'zh' ? '上传到网盘服务器' : 'Upload to Cloud Drive')
          }}
        </button>
        <button
          type="button"
          class="settings__btn-secondary"
          :disabled="apiPulling || !getEffectiveApiToken()"
          @click="pullCloudApi"
        >
          {{
            apiPulling
              ? (settings.language === 'zh' ? '正在从网盘下载…' : 'Downloading…')
              : (settings.language === 'zh' ? '从网盘服务器下载' : 'Download from Cloud Drive')
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
    </div>

    <!-- ==================== 历史版本与快照策略 ==================== -->
    <div v-show="searching || currentTab === 'history'" class="webdav-sync__panel">
      <h4 class="settings__heading">
        {{
          settings.language === 'zh'
            ? '⏱️ 跨平台版本历史管理与云端版本归档 (.solomd-sync/versions)'
            : '⏱️ Cross-Platform Version History & Cloud Version Archiving'
        }}
      </h4>
      <div class="webdav-sync__info-banner">
        <strong>{{ settings.language === 'zh' ? '说明：' : 'Note: ' }}</strong>
        {{
          settings.language === 'zh'
            ? '每次保存笔记或网盘同步覆盖前，自动在工作区 .solomd-sync/versions/ 及网盘端归档历史快照（按 SHA-256 自动去重）。不依赖本地 Git，在桌面端与移动端均可随时通过右侧「历史版本」面板查看行级差异 (Diff) 并一键回滚恢复。'
            : 'Automatically archives deduplicated file snapshots into .solomd-sync/versions/ on save and before cloud sync overwrites. Works across desktop and mobile without requiring Git.'
        }}
      </div>

      <div class="webdav-sync__check-grid">
        <label
          class="webdav-sync__check-item"
          :title="
            settings.language === 'zh'
              ? '每次保存笔记或网盘同步覆盖前自动留存历史版本快照'
              : 'Automatically save version snapshots on save and before sync overwrites'
          "
        >
          <input
            v-model="settings.autoSnapshotOnSave"
            type="checkbox"
            @change="saveConfig"
          />
          <span class="webdav-sync__check-label">
            {{ settings.language === 'zh' ? '自动留存历史快照' : 'Auto-save Version Snapshots' }}
          </span>
        </label>
      </div>

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
    </div>
  </section>
</template>

<style scoped>
.webdav-sync {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.webdav-sync__subnav {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.webdav-sync__subnav-tab {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated, rgba(127, 127, 127, 0.06));
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}
.webdav-sync__subnav-tab:hover {
  color: var(--text);
  border-color: var(--accent);
}
.webdav-sync__subnav-tab--active {
  color: var(--accent);
  border-color: var(--accent);
  background: rgba(59, 130, 246, 0.08);
  font-weight: 600;
}
.webdav-sync__panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.webdav-sync__info-banner {
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.28);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
}
.webdav-sync__check-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(160px, 1fr));
  gap: 8px 16px;
  padding: 4px 0;
}
.webdav-sync__check-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}
.webdav-sync__check-item--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.webdav-sync__check-label {
  border-bottom: 1px dashed var(--text-faint, rgba(127, 127, 127, 0.4));
  padding-bottom: 1px;
}
.webdav-sync__fieldset {
  border: none;
  margin: 0;
  padding: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.webdav-sync__fieldset:disabled {
  opacity: 0.5;
}
.webdav-sync__server-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.webdav-sync__inline-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}
.webdav-sync__server-select {
  min-width: 200px;
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
  grid-template-columns: repeat(2, minmax(200px, 1fr));
  gap: 10px;
}
@media (max-width: 640px) {
  .webdav-sync__check-grid,
  .webdav-sync__grid {
    grid-template-columns: 1fr;
  }
}
.webdav-sync__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}
.webdav-sync__input--error {
  border-color: #e5534b !important;
  box-shadow: 0 0 0 1px rgba(229, 83, 75, 0.28) !important;
  background: rgba(229, 83, 75, 0.05) !important;
}
.webdav-sync__mismatch-warn {
  margin: -2px 0 0;
  font-size: 12px;
  font-weight: 500;
  color: #e5534b;
}
.webdav-sync__warning-box {
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(229, 83, 75, 0.12);
  border: 1px solid rgba(229, 83, 75, 0.35);
  color: #d13830;
  font-size: 12px;
  line-height: 1.55;
}
.webdav-sync__warning-box ol {
  margin: 4px 0 0;
  padding-left: 18px;
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
