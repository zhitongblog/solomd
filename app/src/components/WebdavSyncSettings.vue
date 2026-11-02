<script setup lang="ts">
import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
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

const apiPushing = ref(false);
const apiPulling = ref(false);
const apiAuthLoading = ref(false);
const apiDeviceCode = ref('');
const apiUserCode = ref('');
const apiVerifyUrl = ref('');
const apiQrUrl = ref('');
const apiStatusText = ref('');
const apiStatusKind = ref<'ok' | 'err' | ''>('');

function selectApiProvider(p: 'baidu' | 'alipan' | 'onedrive' | 'dropbox') {
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
  settings.persist();
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
      accessToken: settings.cloudApiToken,
      remotePath: settings.cloudApiRemotePath || '/apps/SoloMD',
      passphrase: settings.cloudApiPassphrase,
    });
    apiStatusText.value = res.message;
    apiStatusKind.value = 'ok';
    toasts.success(res.message);
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
      accessToken: settings.cloudApiToken,
      remotePath: settings.cloudApiRemotePath || '/apps/SoloMD',
      passphrase: settings.cloudApiPassphrase,
    });
    apiStatusText.value = res.message;
    apiStatusKind.value = 'ok';
    toasts.success(res.message);
    window.dispatchEvent(new CustomEvent('solomd:remote-pulled'));
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
    });
    statusText.value = res.message;
    statusKind.value = 'ok';
    toasts.success(res.message);
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
    });
    statusText.value = res.message;
    statusKind.value = 'ok';
    toasts.success(res.message);
    window.dispatchEvent(new CustomEvent('solomd:remote-pulled'));
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
    });
    vaultStatusText.value = res.message;
    vaultStatusKind.value = 'ok';
    toasts.success(res.message);
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
    });
    vaultStatusText.value = res.message;
    vaultStatusKind.value = 'ok';
    toasts.success(res.message);
    window.dispatchEvent(new CustomEvent('solomd:remote-pulled'));
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
          ? '个人网盘同步目录 · 加密备份与多端同步 (百度网盘 / 阿里云盘 / 夸克 / OneDrive / iCloud)'
          : 'Personal Cloud Drive Folder · Encrypted Backup & Sync (Baidu / Aliyun / OneDrive / iCloud)'
      }}
    </h4>
    <p class="settings__hint">
      {{
        settings.language === 'zh'
          ? '无需配置服务器：直接选择您电脑上个人网盘客户端的本地同步盘目录（如百度网盘同步盘、阿里云盘备份盘、夸克网盘、OneDrive、iCloud Drive、坚果云等）。SoloMD 会使用 XChaCha20-Poly1305 + Argon2id 将笔记加密为 .enc 密文写入该网盘目录，既防止隐私泄露与网盘扫描误封，又能通过网盘客户端在多台设备间自动同步密文并一键解密还原。'
          : 'Select any local sync folder managed by your personal cloud drive client (Baidu Netdisk, Aliyun Drive, OneDrive, iCloud Drive, Dropbox, Nutstore). SoloMD encrypts every note with XChaCha20-Poly1305 (.enc) into that folder so your cloud provider only ever sees ciphertext, and any device sharing that cloud folder can decrypt & sync.'
      }}
    </p>

    <div class="webdav-sync__grid">
      <label class="webdav-sync__field" style="grid-column: 1 / -1;">
        <span>
          {{
            settings.language === 'zh'
              ? '个人网盘加密库目录 (Cloud Drive Encrypted Vault Folder)'
              : 'Cloud Drive Encrypted Vault Folder'
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
                ? '例如：D:\\BaiduNetdiskWorkspace\\SoloMD-Vault 或 ~/OneDrive/SoloMD-Vault'
                : 'e.g. ~/OneDrive/SoloMD-Vault or D:\\BaiduNetdisk\\SoloMD-Vault'
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

      <label class="webdav-sync__field" style="grid-column: 1 / -1;">
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
            ? '保存笔记时自动加密备份到该网盘目录'
            : 'Auto-encrypt & backup to cloud drive folder on save'
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
        :disabled="vaultPushing || !settings.cloudVaultDir || !settings.cloudVaultPassphrase"
        @click="pushCloudVault"
      >
        {{
          vaultPushing
            ? (settings.language === 'zh' ? '正在加密备份…' : 'Encrypting…')
            : (settings.language === 'zh' ? '🔒 加密备份到网盘目录 (Push)' : '🔒 Encrypt & Backup to Cloud Folder')
        }}
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="vaultPulling || !settings.cloudVaultDir || !settings.cloudVaultPassphrase"
        @click="pullCloudVault"
      >
        {{
          vaultPulling
            ? (settings.language === 'zh' ? '正在解密同步…' : 'Decrypting…')
            : (settings.language === 'zh' ? '🔓 从网盘目录解密多端同步 (Pull)' : '🔓 Decrypt & Sync from Cloud Folder')
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
          ? '网盘开放平台直连 API · 免客户端加密备份与同步 (百度网盘 / 阿里云盘 / OneDrive / Dropbox)'
          : 'Direct Cloud Drive OpenAPI · Clientless Encrypted Backup & Sync (Baidu / Aliyun / OneDrive / Dropbox)'
      }}
    </h4>
    <p class="settings__hint">
      {{
        settings.language === 'zh'
          ? '不依赖本地网盘同步客户端，也不需要搭建 WebDAV：直接通过官方开放平台 API 将整个笔记库压缩并用 Argon2id + XChaCha20-Poly1305 加密为单个密文包 (solomd-vault.enc) 上传至网盘（连文件名与目录结构也完全加密隐藏）。'
          : 'No local sync client or WebDAV server required: compresses and encrypts your entire workspace with Argon2id + XChaCha20-Poly1305 into a single zero-knowledge bundle (solomd-vault.enc, hiding even filenames) and syncs directly via the cloud provider OpenAPI.'
      }}
    </p>

    <div class="webdav-sync__presets">
      <span class="webdav-sync__preset-label">
        {{ settings.language === 'zh' ? '选择网盘平台：' : 'Cloud Provider:' }}
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
        :style="settings.cloudApiProvider === 'dropbox' ? 'border-color: var(--accent); color: var(--accent); font-weight: 600;' : ''"
        @click="selectApiProvider('dropbox')"
      >
        Dropbox
      </button>
    </div>

    <div class="webdav-sync__grid">
      <label class="webdav-sync__field" style="grid-column: 1 / -1;">
        <span>
          {{
            settings.language === 'zh'
              ? '开放平台 Access Token (可直接粘贴 Token，或使用下方扫码设备授权自动获取)'
              : 'OpenAPI Access Token (paste directly or use OAuth Device Code below)'
          }}
        </span>
        <input
          v-model="settings.cloudApiToken"
          type="password"
          class="settings__input"
          :placeholder="settings.language === 'zh' ? '粘贴网盘开放平台 Access Token…' : 'Paste Access Token…'"
          autocomplete="new-password"
          @change="saveConfig"
        />
      </label>

      <label
        v-if="settings.cloudApiProvider === 'baidu' || settings.cloudApiProvider === 'onedrive'"
        class="webdav-sync__field"
      >
        <span>
          {{
            settings.language === 'zh'
              ? '开放平台 AppKey / Client ID (选填，用于扫码授权)'
              : 'AppKey / Client ID (optional, for Device OAuth)'
          }}
        </span>
        <input
          v-model="settings.cloudApiClientId"
          type="text"
          class="settings__input"
          :placeholder="settings.cloudApiProvider === 'baidu' ? '百度网盘开放平台 AppKey' : 'Azure App Client ID'"
          @change="saveConfig"
        />
      </label>

      <label
        v-if="settings.cloudApiProvider === 'baidu'"
        class="webdav-sync__field"
      >
        <span>
          {{
            settings.language === 'zh'
              ? '开放平台 SecretKey (选填，用于扫码授权换取 Token)'
              : 'SecretKey (optional, for Baidu Device OAuth)'
          }}
        </span>
        <input
          v-model="settings.cloudApiClientSecret"
          type="password"
          class="settings__input"
          placeholder="百度网盘开放平台 SecretKey"
          autocomplete="new-password"
          @change="saveConfig"
        />
      </label>

      <label class="webdav-sync__field">
        <span>
          {{
            settings.language === 'zh'
              ? '网盘远程存储目录 (自动存放 solomd-vault.enc)'
              : 'Remote Directory Path (stores solomd-vault.enc)'
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
              ? '直连加密口令 (Passphrase — 本地高强度加密，多端输入相同口令即可解密)'
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

    <div
      v-if="settings.cloudApiProvider === 'baidu' || settings.cloudApiProvider === 'onedrive'"
      class="webdav-sync__actions"
    >
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="apiAuthLoading || !settings.cloudApiClientId"
        @click="startDeviceAuth"
      >
        {{
          settings.language === 'zh'
            ? '📲 获取扫码/设备授权码 (OAuth Device Code)'
            : '📲 Start OAuth Device Code Login'
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

    <label class="settings__row">
      <span>
        {{
          settings.language === 'zh'
            ? '保存笔记时自动通过网盘 API 加密上传备份'
            : 'Auto-encrypt & upload via Cloud Drive API on save'
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
        :disabled="apiPushing || !settings.cloudApiToken || !settings.cloudApiPassphrase"
        @click="pushCloudApi"
      >
        {{
          apiPushing
            ? (settings.language === 'zh' ? '正在打包加密上传…' : 'Encrypting & Uploading…')
            : (settings.language === 'zh' ? '🔒 API 直连加密上传到网盘 (Push)' : '🔒 Encrypt & Push via Cloud API')
        }}
      </button>
      <button
        type="button"
        class="settings__btn-secondary"
        :disabled="apiPulling || !settings.cloudApiToken || !settings.cloudApiPassphrase"
        @click="pullCloudApi"
      >
        {{
          apiPulling
            ? (settings.language === 'zh' ? '正在下载解密还原…' : 'Downloading & Decrypting…')
            : (settings.language === 'zh' ? '🔓 API 直连从网盘下载解密同步 (Pull)' : '🔓 Pull & Decrypt via Cloud API')
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
