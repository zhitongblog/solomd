<script setup lang="ts">
/**
 * GithubSyncSettings — v2.6 Settings → GitHub sync panel.
 *
 * Three states:
 *   1. No PAT          → "Connect with GitHub" + token input + help link
 *   2. PAT, not linked → repo picker + "Create new vault repo" button
 *   3. Linked          → status, auto-push toggle, auto-pull interval,
 *                        manual push/pull buttons, unlink, switch repo
 *
 * Lives inside SettingsPanel.vue under the AutoGit section so the
 * "version history → GitHub backup" story reads top-down.
 */
import { ref, computed, onMounted, watch } from 'vue';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useGithubSyncStore } from '../stores/githubSync';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

const sync = useGithubSyncStore();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const toasts = useToastsStore();
const { t } = useI18n();

const PAT_HELP_URL =
  'https://github.com/settings/tokens/new?scopes=repo&description=SoloMD%20sync';

const tokenInput = ref('');
const tokenSaving = ref(false);
const newRepoName = ref('');
const newRepoPrivate = ref(true);
const creatingRepo = ref(false);
const linking = ref(false);
const showAdvanced = ref(false);

// v2.6.3 — multi-provider + E2EE state
const providerChoice = ref<'github' | 'gitlab' | 'gitea' | 'custom'>('github');
const customUrl = ref('');
const enableE2ee = ref(false);
const passphraseInput = ref('');
const passphraseSaving = ref(false);
const decrypting = ref(false);
// v3.0 note: proxy URL UI lives in its own ProxySettings.vue card, sibling
// to this one in the Sync category. We don't store proxy state here anymore.

// v3.0 — upgrade-to-E2EE flow for an already-linked plaintext workspace.
// Shown only when sync.status.linked && !sync.status.encrypted.
const upgradePassphrase = ref('');
const upgradeConfirm = ref('');
const upgradeAcknowledged = ref(false);
const upgrading = ref(false);
const upgradeOpen = ref(false);

async function startE2eeUpgrade() {
  upgradeOpen.value = true;
}
function cancelE2eeUpgrade() {
  upgradeOpen.value = false;
  upgradePassphrase.value = '';
  upgradeConfirm.value = '';
  upgradeAcknowledged.value = false;
}
async function commitE2eeUpgrade() {
  if (!workspace.currentFolder) return;
  if (upgradePassphrase.value.length < 8) {
    toasts.warning(t('githubSync.upgradeShortPassphrase'));
    return;
  }
  if (upgradePassphrase.value !== upgradeConfirm.value) {
    toasts.warning(t('githubSync.upgradeMismatch'));
    return;
  }
  if (!upgradeAcknowledged.value) {
    toasts.warning(t('githubSync.upgradeNotAcknowledged'));
    return;
  }
  upgrading.value = true;
  try {
    await sync.enableEncryption(workspace.currentFolder, upgradePassphrase.value);
    toasts.success(t('githubSync.upgradeDoneToast'));
    cancelE2eeUpgrade();
  } catch (e) {
    toasts.error(`${t('githubSync.upgradeFailed')}: ${e}`);
  } finally {
    upgrading.value = false;
  }
}

onMounted(async () => {
  await sync.refreshHasToken();
  if (workspace.currentFolder) {
    await sync.refreshStatus(workspace.currentFolder);
  }
  if (sync.hasToken && !sync.isLinked) {
    await Promise.all([sync.refreshUser(), sync.listRepos().catch(() => {})]);
  }
});

watch(
  () => workspace.currentFolder,
  (f) => {
    void sync.refreshStatus(f);
  },
);

async function saveToken() {
  const tok = tokenInput.value.trim();
  if (!tok) return;
  tokenSaving.value = true;
  try {
    await sync.setToken(tok);
    tokenInput.value = '';
    toasts.success(t('githubSync.tokenSavedToast'));
    // Pre-load repos for the picker.
    await sync.listRepos().catch((e) => {
      toasts.error(`${t('githubSync.tokenInvalid')}: ${e}`);
      // The token is bad. Clear it so the user gets a clean retry.
      void sync.clearToken();
    });
  } catch (e) {
    toasts.error(String(e));
  } finally {
    tokenSaving.value = false;
  }
}

async function clearToken() {
  if (sync.status?.linked && workspace.currentFolder) {
    await sync.unlink(workspace.currentFolder).catch(() => {});
  }
  await sync.clearToken();
  toasts.info(t('githubSync.tokenClearedToast'));
}

async function refreshRepos() {
  try {
    await sync.listRepos();
  } catch (e) {
    toasts.error(String(e));
  }
}

async function createRepo() {
  const name = newRepoName.value.trim();
  if (!name) return;
  creatingRepo.value = true;
  try {
    const repo = await sync.createRepo(name, newRepoPrivate.value);
    toasts.success(t('githubSync.repoCreatedToast', { name: repo.full_name }));
    newRepoName.value = '';
    // Auto-link if a workspace is open.
    if (workspace.currentFolder) {
      await link(repo.clone_url);
    }
  } catch (e) {
    toasts.error(`${t('githubSync.repoCreateFailed')}: ${e}`);
  } finally {
    creatingRepo.value = false;
  }
}

async function link(remoteUrl: string) {
  if (!workspace.currentFolder) {
    toasts.warning(t('githubSync.noWorkspace'));
    return;
  }
  if (!settings.autoGitEnabled) {
    // GitHub sync only pushes commits — turning AutoGit on is a hard
    // prerequisite. Flip it on for the user instead of refusing.
    settings.toggleAutoGit();
  }
  linking.value = true;
  try {
    await sync.link(workspace.currentFolder, remoteUrl, {
      encrypted: enableE2ee.value,
      provider: providerChoice.value,
    });
    toasts.success(t('githubSync.linkedToast'));
  } catch (e) {
    toasts.error(`${t('githubSync.linkFailed')}: ${e}`);
  } finally {
    linking.value = false;
  }
}

async function linkCustom() {
  const url = customUrl.value.trim();
  if (!url) return;
  await link(url);
  customUrl.value = '';
}

async function savePassphrase() {
  if (!workspace.currentFolder) return;
  const pw = passphraseInput.value;
  if (!pw) return;
  passphraseSaving.value = true;
  try {
    await sync.setPassphrase(workspace.currentFolder, pw);
    passphraseInput.value = '';
    toasts.success(t('githubSync.passphraseSavedToast'));
  } catch (e) {
    toasts.error(`${t('githubSync.passphraseFailed')}: ${e}`);
  } finally {
    passphraseSaving.value = false;
  }
}

async function decryptNow() {
  if (!workspace.currentFolder) return;
  decrypting.value = true;
  try {
    await sync.decryptNow(workspace.currentFolder);
    toasts.success(t('githubSync.decryptedToast'));
    window.dispatchEvent(new CustomEvent('solomd:remote-pulled'));
  } catch (e) {
    toasts.error(`${t('githubSync.decryptFailed')}: ${e}`);
  } finally {
    decrypting.value = false;
  }
}

async function unlink() {
  if (!workspace.currentFolder) return;
  try {
    await sync.unlink(workspace.currentFolder);
    toasts.info(t('githubSync.unlinkedToast'));
  } catch (e) {
    toasts.error(String(e));
  }
}

async function pushNow() {
  if (!workspace.currentFolder) return;
  try {
    await sync.push(workspace.currentFolder);
    toasts.success(t('githubSync.pushedToast'));
  } catch (e) {
    toasts.error(`${t('githubSync.pushFailed')}: ${e}`);
  }
}

async function pullNow() {
  if (!workspace.currentFolder) return;
  try {
    const r = await sync.pull(workspace.currentFolder);
    if (r.kind === 'up_to_date') {
      toasts.info(t('githubSync.upToDate'));
    } else if (r.kind === 'conflicts') {
      toasts.warning(t('githubSync.pullConflicts', { n: String(r.conflicts.length) }));
    } else {
      toasts.success(t('githubSync.pulledToast'));
      window.dispatchEvent(new CustomEvent('solomd:remote-pulled'));
    }
  } catch (e) {
    toasts.error(`${t('githubSync.pullFailed')}: ${e}`);
  }
}

async function setAutoPush(checked: boolean) {
  if (!workspace.currentFolder || !sync.status?.linked) return;
  try {
    await sync.setConfig(
      workspace.currentFolder,
      checked,
      sync.status.auto_pull_minutes,
    );
    toasts.info(checked ? t('githubSync.autoPushOn') : t('githubSync.autoPushOff'));
  } catch (e) {
    toasts.error(String(e));
  }
}

async function setAutoPullMinutes(v: number) {
  if (!workspace.currentFolder || !sync.status?.linked) return;
  try {
    await sync.setConfig(
      workspace.currentFolder,
      sync.status.auto_push,
      Number.isFinite(v) && v >= 0 ? v : 0,
    );
  } catch (e) {
    toasts.error(String(e));
  }
}

function openPATHelp() {
  void openUrl(PAT_HELP_URL);
}

function fmtAgo(ts: number | null): string {
  if (!ts) return t('githubSync.never');
  const dt = Date.now() / 1000 - ts;
  if (dt < 60) return t('githubSync.agoSec', { n: String(Math.floor(dt)) });
  if (dt < 3600) return t('githubSync.agoMin', { n: String(Math.floor(dt / 60)) });
  if (dt < 86400) return t('githubSync.agoHour', { n: String(Math.floor(dt / 3600)) });
  return t('githubSync.agoDay', { n: String(Math.floor(dt / 86400)) });
}

const linkedRepoLabel = computed(() => {
  const url = sync.status?.remote_url ?? '';
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : url;
});
</script>

<template>
  <section class="ghs">
    <h3 class="ghs__heading">{{ t('githubSync.heading') }}</h3>
    <p class="ghs__intro">{{ t('githubSync.intro') }}</p>

    <!-- v3.0 — first-time-setup hint. macOS prompts the user once for
         the GitHub PAT and (if E2EE on) once for the encryption key.
         Both prompts have "Always Allow" — clicking it once silences
         all future runs. We surface this proactively so users don't
         think the prompts are spam. -->
    <div class="ghs-keychain-hint">
      <span class="ghs-keychain-hint__icon">🔑</span>
      <div>
        <strong>{{ t('githubSync.keychainHintTitle') }}</strong>
        <p>{{ t('githubSync.keychainHintBody') }}</p>
      </div>
    </div>

    <!-- ──────────────────────────────────────────────────────────────── -->
    <!-- State 1: no PAT — sign-in form                                   -->
    <!-- ──────────────────────────────────────────────────────────────── -->
    <div v-if="!sync.hasToken" class="ghs-card">
      <div class="ghs-card__title">{{ t('githubSync.signInTitle') }}</div>
      <p class="ghs-help">{{ t('githubSync.signInHint') }}</p>
      <div class="ghs-row">
        <input
          v-model="tokenInput"
          type="password"
          autocomplete="off"
          spellcheck="false"
          class="ghs-input ghs-input--mono"
          :placeholder="t('githubSync.tokenPlaceholder')"
        />
      </div>
      <div class="ghs-row">
        <button class="ghs-btn ghs-btn--primary" :disabled="tokenSaving || !tokenInput.trim()" @click="saveToken">
          {{ tokenSaving ? t('githubSync.tokenSaving') : t('githubSync.tokenSaveBtn') }}
        </button>
        <button class="ghs-btn" @click="openPATHelp">
          {{ t('githubSync.tokenGetBtn') }}
        </button>
      </div>
      <p class="ghs-fineprint">{{ t('githubSync.tokenScopeHint') }}</p>
    </div>

    <!-- ──────────────────────────────────────────────────────────────── -->
    <!-- State 2: PAT, no link — repo picker / create                     -->
    <!-- ──────────────────────────────────────────────────────────────── -->
    <div v-else-if="!sync.isLinked" class="ghs-card">
      <div class="ghs-card__title">
        {{ t('githubSync.signedInAs', { user: sync.user?.login ?? '…' }) }}
      </div>

      <p v-if="!workspace.currentFolder" class="ghs-help">
        {{ t('githubSync.openFolderFirst') }}
      </p>

      <template v-else>
        <p class="ghs-help">{{ t('githubSync.linkHint') }}</p>

        <!-- v2.6.3 — provider + E2EE toggle, applied to whichever link
             path the user chooses below. -->
        <div class="ghs-subblock">
          <div class="ghs-sub-title">{{ t('githubSync.providerTitle') }}</div>
          <div class="ghs-row">
            <select v-model="providerChoice" class="ghs-select">
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
              <option value="gitea">Gitea (self-hosted)</option>
              <option value="custom">{{ t('githubSync.customProvider') }}</option>
            </select>
          </div>
          <p v-if="providerChoice !== 'github'" class="ghs-help">
            {{ t('githubSync.nonGithubHint') }}
          </p>
          <label class="ghs-checkbox" style="margin-top: 6px;">
            <input v-model="enableE2ee" type="checkbox" />
            {{ t('githubSync.enableE2ee') }}
          </label>
          <p class="ghs-help">{{ t('githubSync.e2eeHint') }}</p>
        </div>

        <!-- Create new -->
        <div v-if="providerChoice === 'github'" class="ghs-subblock">
          <div class="ghs-sub-title">{{ t('githubSync.createNewTitle') }}</div>
          <div class="ghs-row">
            <input
              v-model="newRepoName"
              type="text"
              class="ghs-input"
              :placeholder="t('githubSync.newRepoPlaceholder')"
            />
          </div>
          <div class="ghs-row">
            <label class="ghs-checkbox">
              <input v-model="newRepoPrivate" type="checkbox" />
              {{ t('githubSync.privateRepo') }}
            </label>
          </div>
          <div class="ghs-row">
            <button
              class="ghs-btn ghs-btn--primary"
              :disabled="creatingRepo || !newRepoName.trim()"
              @click="createRepo"
            >
              {{ creatingRepo ? t('githubSync.creatingRepo') : t('githubSync.createAndLinkBtn') }}
            </button>
          </div>
        </div>

        <!-- Custom / GitLab / Gitea — paste a clone URL -->
        <div v-if="providerChoice !== 'github'" class="ghs-subblock">
          <div class="ghs-sub-title">{{ t('githubSync.pasteUrlTitle') }}</div>
          <div class="ghs-row">
            <input
              v-model="customUrl"
              type="text"
              class="ghs-input ghs-input--mono"
              :placeholder="providerChoice === 'gitlab'
                ? 'https://gitlab.com/owner/repo.git'
                : providerChoice === 'gitea'
                  ? 'https://gitea.example.org/owner/repo.git'
                  : 'https://git.example.org/owner/repo.git'"
            />
          </div>
          <div class="ghs-row">
            <button
              class="ghs-btn ghs-btn--primary"
              :disabled="linking || !customUrl.trim()"
              @click="linkCustom"
            >
              {{ t('githubSync.linkBtn') }}
            </button>
          </div>
        </div>

        <!-- Pick existing (GitHub only — repo list API is GitHub-shaped) -->
        <div v-if="providerChoice === 'github'" class="ghs-subblock">
          <div class="ghs-sub-title">{{ t('githubSync.pickExistingTitle') }}</div>
          <div v-if="sync.loading" class="ghs-help">{{ t('githubSync.loadingRepos') }}</div>
          <div v-else-if="!sync.repos.length" class="ghs-help">
            {{ t('githubSync.noReposFound') }}
            <button class="ghs-btn ghs-btn--small" @click="refreshRepos">{{ t('githubSync.refreshRepos') }}</button>
          </div>
          <ul v-else class="ghs-repolist">
            <li v-for="r in sync.repos" :key="r.full_name" class="ghs-repolist__item">
              <div class="ghs-repolist__meta">
                <span class="ghs-repolist__name">{{ r.full_name }}</span>
                <span v-if="r.private" class="ghs-repolist__pill">{{ t('githubSync.privateBadge') }}</span>
              </div>
              <button
                class="ghs-btn ghs-btn--small"
                :disabled="linking"
                @click="link(r.clone_url)"
              >
                {{ t('githubSync.linkBtn') }}
              </button>
            </li>
          </ul>
        </div>

        <div class="ghs-row">
          <button class="ghs-btn ghs-btn--ghost" @click="clearToken">
            {{ t('githubSync.signOutBtn') }}
          </button>
          <button class="ghs-btn ghs-btn--ghost" @click="refreshRepos">
            {{ t('githubSync.refreshRepos') }}
          </button>
        </div>
      </template>
    </div>

    <!-- ──────────────────────────────────────────────────────────────── -->
    <!-- State 3: linked — status + actions                               -->
    <!-- ──────────────────────────────────────────────────────────────── -->
    <div v-else class="ghs-card ghs-card--linked">
      <div class="ghs-card__title">
        {{ t('githubSync.linkedTitle', { repo: linkedRepoLabel }) }}
      </div>

      <div class="ghs-status">
        <div>
          <span class="ghs-dot" :class="sync.status?.dirty ? 'ghs-dot--warn' : 'ghs-dot--ok'"></span>
          <span v-if="sync.status?.dirty">{{ t('githubSync.statusDirty') }}</span>
          <span v-else>{{ t('githubSync.statusClean') }}</span>
        </div>
        <div v-if="(sync.status?.ahead ?? 0) > 0" class="ghs-status__pill">
          ↑ {{ sync.status?.ahead }} {{ t('githubSync.ahead') }}
        </div>
        <div v-if="(sync.status?.behind ?? 0) > 0" class="ghs-status__pill">
          ↓ {{ sync.status?.behind }} {{ t('githubSync.behind') }}
        </div>
        <div v-if="sync.hasConflicts" class="ghs-status__pill ghs-status__pill--err">
          ⚠ {{ sync.status?.conflicts.length }} {{ t('githubSync.conflictsBadge') }}
        </div>
      </div>

      <div class="ghs-timestamps">
        <div>{{ t('githubSync.lastPush') }}: {{ fmtAgo(sync.status?.last_push_at ?? null) }}</div>
        <div>{{ t('githubSync.lastPull') }}: {{ fmtAgo(sync.status?.last_pull_at ?? null) }}</div>
      </div>

      <div class="ghs-row">
        <button
          class="ghs-btn ghs-btn--primary"
          :disabled="sync.pushing || sync.pulling || sync.hasConflicts"
          @click="pushNow"
        >
          {{ sync.pushing ? t('githubSync.pushing') : t('githubSync.pushNow') }}
        </button>
        <button
          class="ghs-btn"
          :disabled="sync.pushing || sync.pulling"
          @click="pullNow"
        >
          {{ sync.pulling ? t('githubSync.pulling') : t('githubSync.pullNow') }}
        </button>
      </div>

      <!-- v3.0 — upgrade plaintext-linked workspace to E2EE. Closed-by-default
           card; clicking expands to passphrase + confirmation form.
           This matches the user mental model: "I'm linked already, I want
           to encrypt now" — no need to unlink + relink. -->
      <div v-if="!sync.status?.encrypted && !upgradeOpen" class="ghs-upgrade-row">
        <span class="ghs-upgrade-row__icon">🔒</span>
        <div class="ghs-upgrade-row__copy">
          <strong>{{ t('githubSync.upgradeRowTitle') }}</strong>
          <p>{{ t('githubSync.upgradeRowBody') }}</p>
        </div>
        <button class="ghs-btn" @click="startE2eeUpgrade">
          {{ t('githubSync.upgradeRowBtn') }}
        </button>
      </div>

      <div v-if="!sync.status?.encrypted && upgradeOpen" class="ghs-subblock ghs-upgrade-form">
        <div class="ghs-sub-title">{{ t('githubSync.upgradeFormTitle') }}</div>
        <p class="ghs-help">{{ t('githubSync.upgradeFormBody') }}</p>
        <div class="ghs-warn">⚠ {{ t('githubSync.upgradeForcePushWarning') }}</div>
        <div class="ghs-row">
          <input
            v-model="upgradePassphrase"
            type="password"
            autocomplete="new-password"
            class="ghs-input"
            :placeholder="t('githubSync.upgradePassphrasePlaceholder')"
          />
        </div>
        <div class="ghs-row">
          <input
            v-model="upgradeConfirm"
            type="password"
            autocomplete="new-password"
            class="ghs-input"
            :placeholder="t('githubSync.upgradeConfirmPlaceholder')"
          />
        </div>
        <label class="ghs-checkbox" style="margin-top: 4px;">
          <input v-model="upgradeAcknowledged" type="checkbox" />
          {{ t('githubSync.upgradeAcknowledge') }}
        </label>
        <div class="ghs-row" style="margin-top: 4px;">
          <button class="ghs-btn ghs-btn--ghost" :disabled="upgrading" @click="cancelE2eeUpgrade">
            {{ t('githubSync.upgradeCancelBtn') }}
          </button>
          <button
            class="ghs-btn ghs-btn--primary"
            :disabled="upgrading || !upgradePassphrase || !upgradeConfirm || !upgradeAcknowledged"
            @click="commitE2eeUpgrade"
          >
            {{ upgrading ? t('githubSync.upgradeRunning') : t('githubSync.upgradeCommitBtn') }}
          </button>
        </div>
      </div>

      <!-- v2.6.3 — E2EE passphrase prompt. Only visible when this
           workspace is linked WITH encryption on. -->
      <div v-if="sync.status?.encrypted" class="ghs-subblock">
        <div class="ghs-sub-title">{{ t('githubSync.e2eeSection') }}</div>
        <p class="ghs-help">{{ t('githubSync.e2eePromptHint') }}</p>
        <div class="ghs-row">
          <input
            v-model="passphraseInput"
            type="password"
            autocomplete="new-password"
            class="ghs-input"
            :placeholder="t('githubSync.passphrasePlaceholder')"
          />
        </div>
        <div class="ghs-row">
          <button
            class="ghs-btn ghs-btn--primary"
            :disabled="passphraseSaving || !passphraseInput"
            @click="savePassphrase"
          >
            {{ passphraseSaving ? t('githubSync.passphraseSaving') : t('githubSync.passphraseSaveBtn') }}
          </button>
          <button class="ghs-btn" :disabled="decrypting" @click="decryptNow">
            {{ decrypting ? t('githubSync.decrypting') : t('githubSync.decryptBtn') }}
          </button>
        </div>
      </div>

      <details class="ghs-details" :open="showAdvanced">
        <summary @click.prevent="showAdvanced = !showAdvanced">
          {{ t('githubSync.advanced') }}
        </summary>
        <div class="ghs-advanced">
          <label class="ghs-checkbox">
            <input
              type="checkbox"
              :checked="sync.status?.auto_push ?? false"
              @change="setAutoPush(($event.target as HTMLInputElement).checked)"
            />
            {{ t('githubSync.autoPushLabel') }}
          </label>
          <p class="ghs-help">{{ t('githubSync.autoPushHint') }}</p>

          <label class="ghs-row" style="align-items: center;">
            <span class="ghs-help" style="margin-right: 8px;">{{ t('githubSync.autoPullLabel') }}:</span>
            <select
              :value="String(sync.status?.auto_pull_minutes ?? 0)"
              @change="setAutoPullMinutes(parseInt(($event.target as HTMLSelectElement).value, 10))"
              class="ghs-select"
            >
              <option value="0">{{ t('githubSync.autoPullOff') }}</option>
              <option value="5">5 {{ t('githubSync.minutes') }}</option>
              <option value="15">15 {{ t('githubSync.minutes') }}</option>
              <option value="30">30 {{ t('githubSync.minutes') }}</option>
              <option value="60">60 {{ t('githubSync.minutes') }}</option>
            </select>
          </label>
          <p class="ghs-help">{{ t('githubSync.autoPullHint') }}</p>

          <div class="ghs-row" style="margin-top: 10px;">
            <button class="ghs-btn ghs-btn--ghost" @click="unlink">
              {{ t('githubSync.unlinkBtn') }}
            </button>
            <button class="ghs-btn ghs-btn--ghost" @click="clearToken">
              {{ t('githubSync.signOutBtn') }}
            </button>
          </div>
        </div>
      </details>
    </div>

    <p v-if="sync.lastError" class="ghs-error">{{ sync.lastError }}</p>
  </section>
</template>

<style scoped>
.ghs {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ghs__heading {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 18px 0 0;
}
.ghs__intro {
  font-size: 11px;
  color: var(--text-faint);
  margin: 0 0 4px;
  line-height: 1.5;
}
.ghs-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ghs-card--linked {
  border-color: var(--accent);
}
.ghs-card__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.ghs-sub-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  margin: 8px 0 4px;
}
.ghs-subblock {
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
.ghs-help {
  font-size: 11px;
  color: var(--text-faint);
  margin: 0;
  line-height: 1.5;
}
.ghs-fineprint {
  font-size: 10px;
  color: var(--text-faint);
  margin: 0;
  line-height: 1.5;
}
.ghs-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.ghs-input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  font: inherit;
  font-size: 12px;
}
.ghs-input--mono {
  font-family: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
}
.ghs-select {
  padding: 4px 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  font: inherit;
  font-size: 12px;
}
.ghs-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}
.ghs-btn {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  padding: 5px 10px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
.ghs-btn:hover:not(:disabled) {
  background: var(--bg-active, var(--bg-elev));
}
.ghs-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ghs-btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text, #000);
}
.ghs-btn--primary:hover:not(:disabled) {
  filter: brightness(1.05);
}
.ghs-btn--ghost {
  background: transparent;
  color: var(--text-muted);
}
.ghs-btn--small {
  padding: 3px 8px;
  font-size: 10px;
}
.ghs-status {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--text-muted);
}
.ghs-status > div {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ghs-status__pill {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 11px;
  color: var(--text-muted);
}
.ghs-status__pill--err {
  border-color: #d12;
  color: #d12;
}
.ghs-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.ghs-dot--ok {
  background: #22c55e;
}
.ghs-dot--warn {
  background: #f59e0b;
}
.ghs-timestamps {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 11px;
  color: var(--text-faint);
}
.ghs-details {
  margin-top: 4px;
}
.ghs-details summary {
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}
.ghs-details summary:hover {
  color: var(--text);
}
.ghs-advanced {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
}
.ghs-repolist {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.ghs-repolist__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.ghs-repolist__item:last-child {
  border-bottom: none;
}
.ghs-repolist__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ghs-repolist__name {
  color: var(--text);
  font-family: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ghs-repolist__pill {
  font-size: 9px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ghs-error {
  font-size: 10px;
  color: #d12;
  margin: 0;
  word-break: break-all;
}
.ghs-upgrade-row {
  display: flex;
  gap: 10px;
  align-items: center;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-radius: 6px;
  padding: 10px 12px;
  margin-top: 10px;
}
.ghs-upgrade-row__icon {
  font-size: 18px;
  line-height: 1;
}
.ghs-upgrade-row__copy {
  flex: 1;
  min-width: 0;
}
.ghs-upgrade-row__copy strong {
  display: block;
  font-size: 12px;
  color: var(--text);
  margin-bottom: 2px;
}
.ghs-upgrade-row__copy p {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}
.ghs-upgrade-form {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
  margin-top: 10px;
}
.ghs-warn {
  font-size: 11px;
  color: #b45309;
  background: rgba(245, 158, 11, 0.1);
  border-left: 3px solid #f59e0b;
  padding: 8px 10px;
  border-radius: 4px;
  line-height: 1.5;
  margin: 4px 0;
}
.ghs-keychain-hint {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 0 0 10px;
}
.ghs-keychain-hint__icon {
  font-size: 18px;
  line-height: 1;
}
.ghs-keychain-hint strong {
  display: block;
  font-size: 12px;
  color: var(--text);
  margin-bottom: 4px;
}
.ghs-keychain-hint p {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.6;
}
</style>
