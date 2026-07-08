/**
 * Lightweight i18n for the clipper.
 *
 * Mirrors the desktop app's `t('clipper.foo')` lookup style — but loaded
 * synchronously from a hard-coded map so the popup paints without a flicker.
 */
import browser from 'webextension-polyfill';

import { loadSettings } from './storage.js';

type Dict = Record<string, string>;

const EN: Dict = {
  'clipper.popup.title': 'SoloMD Web Clipper',
  'clipper.popup.clipPage': 'Clip whole page',
  'clipper.popup.clipPageHint': 'Reader-extracted main content → Markdown',
  'clipper.popup.clipSelection': 'Clip selection',
  'clipper.popup.clipSelectionHint': 'Just the highlighted text',
  'clipper.popup.saveLink': 'Save link',
  'clipper.popup.saveLinkHint': 'Title + URL only — for read-later',
  'clipper.popup.openOptions': 'Settings',
  'clipper.popup.paired': 'Paired with SoloMD',
  'clipper.popup.unpaired': 'Not paired — click Settings to set it up',
  'clipper.popup.checking': 'Checking…',
  'clipper.popup.shortcut.selection': '⌘⇧S',
  'clipper.popup.shortcut.link': '⌘⇧L',

  'clipper.options.title': 'SoloMD Web Clipper · Settings',
  'clipper.options.heading': 'Pair with SoloMD',
  'clipper.options.intro':
    'In SoloMD, open Settings → Integrations → HTTP capture endpoint, toggle it on, and copy the bearer token here.',
  'clipper.options.endpoint': 'Endpoint URL',
  'clipper.options.endpointHint': 'Default: http://127.0.0.1:7777 (loopback only — never leaves your machine).',
  'clipper.options.token': 'Bearer token',
  'clipper.options.tokenHint': 'Paste the token from SoloMD Settings → Integrations.',
  'clipper.options.subfolder': 'Sub-folder (optional)',
  'clipper.options.subfolderHint': 'Relative to the workspace inbox. Leave blank to drop into the inbox root.',
  'clipper.options.notifyOnSuccess': 'Show a desktop notification when a capture lands.',
  'clipper.options.locale': 'Language',
  'clipper.options.localeAuto': 'Auto (browser default)',
  'clipper.options.localeEn': 'English',
  'clipper.options.localeZh': '中文 (Chinese)',
  'clipper.options.test': 'Test connection',
  'clipper.options.save': 'Save',
  'clipper.options.saved': 'Saved.',
  'clipper.options.testRunning': 'Testing…',
  'clipper.options.testOkPrefix': 'Connected — workspace: ',
  'clipper.options.testNoWorkspace': 'Connected, but no workspace folder is open in SoloMD.',
  'clipper.options.testFailPrefix': 'Failed: ',

  'clipper.toast.savedPrefix': 'Saved to SoloMD inbox: ',
  'clipper.toast.error.generic': 'Capture failed: ',
  'clipper.toast.error.notConfigured': 'Set up your endpoint URL + token first (open Settings).',
  'clipper.toast.error.endpointDown':
    'SoloMD capture endpoint is not running — open SoloMD and toggle it on in Settings → Integrations.',
  'clipper.toast.error.badToken': 'Wrong token — copy it again from SoloMD Settings → Integrations.',
  'clipper.toast.error.noWorkspace': 'No workspace folder open in SoloMD — open a folder first.',
  'clipper.toast.error.timeout': 'SoloMD did not respond within 10 seconds.',
  'clipper.toast.error.network': 'Network error — is SoloMD running?',

  'clipper.menu.clipPage': 'SoloMD: Clip whole page',
  'clipper.menu.clipSelection': 'SoloMD: Clip selection',
  'clipper.menu.saveLink': 'SoloMD: Save link',

  'clipper.frontmatter.captured': 'captured',
};

const ZH: Dict = {
  'clipper.popup.title': 'SoloMD 网页剪藏',
  'clipper.popup.clipPage': '剪藏整页',
  'clipper.popup.clipPageHint': '使用阅读模式提取正文 → Markdown',
  'clipper.popup.clipSelection': '剪藏选中内容',
  'clipper.popup.clipSelectionHint': '只剪藏当前选中的文字',
  'clipper.popup.saveLink': '仅保存链接',
  'clipper.popup.saveLinkHint': '只记录标题和链接 — 适合稍后阅读',
  'clipper.popup.openOptions': '设置',
  'clipper.popup.paired': '已与 SoloMD 配对',
  'clipper.popup.unpaired': '尚未配对 — 点击「设置」开始',
  'clipper.popup.checking': '正在检测…',
  'clipper.popup.shortcut.selection': '⌘⇧S',
  'clipper.popup.shortcut.link': '⌘⇧L',

  'clipper.options.title': 'SoloMD 网页剪藏 · 设置',
  'clipper.options.heading': '与 SoloMD 配对',
  'clipper.options.intro':
    '在 SoloMD 里打开「设置 → 集成 → HTTP 捕获端点」，启用它，然后把令牌粘贴到这里。',
  'clipper.options.endpoint': '端点地址',
  'clipper.options.endpointHint': '默认：http://127.0.0.1:7777（仅本机回环 — 数据不会离开你的电脑）。',
  'clipper.options.token': '令牌',
  'clipper.options.tokenHint': '从 SoloMD「设置 → 集成」复制粘贴过来。',
  'clipper.options.subfolder': '子文件夹（可选）',
  'clipper.options.subfolderHint': '相对于收件箱文件夹。留空则直接放在收件箱根目录。',
  'clipper.options.notifyOnSuccess': '剪藏成功时弹出桌面通知。',
  'clipper.options.locale': '语言',
  'clipper.options.localeAuto': '自动（跟随浏览器）',
  'clipper.options.localeEn': 'English',
  'clipper.options.localeZh': '中文',
  'clipper.options.test': '测试连接',
  'clipper.options.save': '保存',
  'clipper.options.saved': '已保存。',
  'clipper.options.testRunning': '正在测试…',
  'clipper.options.testOkPrefix': '已连接 — 工作区：',
  'clipper.options.testNoWorkspace': '已连接，但 SoloMD 还没打开任何工作区文件夹。',
  'clipper.options.testFailPrefix': '失败：',

  'clipper.toast.savedPrefix': '已保存到 SoloMD 收件箱：',
  'clipper.toast.error.generic': '剪藏失败：',
  'clipper.toast.error.notConfigured': '请先在「设置」里填写端点地址和令牌。',
  'clipper.toast.error.endpointDown':
    'SoloMD 捕获端点未运行 — 请打开 SoloMD，在「设置 → 集成」里启用它。',
  'clipper.toast.error.badToken': '令牌不正确 — 请从 SoloMD「设置 → 集成」重新复制。',
  'clipper.toast.error.noWorkspace': 'SoloMD 还没打开任何工作区文件夹 — 请先打开一个文件夹。',
  'clipper.toast.error.timeout': 'SoloMD 在 10 秒内没有响应。',
  'clipper.toast.error.network': '网络错误 — SoloMD 是否在运行？',

  'clipper.menu.clipPage': 'SoloMD：剪藏整页',
  'clipper.menu.clipSelection': 'SoloMD：剪藏选中内容',
  'clipper.menu.saveLink': 'SoloMD：保存链接',

  'clipper.frontmatter.captured': '剪藏于',
};

const DICTS: Record<string, Dict> = { en: EN, zh: ZH };

let activeDict: Dict = EN;

function pickLocale(prefer: 'auto' | 'en' | 'zh'): 'en' | 'zh' {
  if (prefer === 'en' || prefer === 'zh') return prefer;
  // browser.i18n.getUILanguage returns e.g. "zh-CN", "zh-TW", "en-US".
  let ui = 'en';
  try {
    ui = browser.i18n.getUILanguage() ?? 'en';
  } catch {
    /* options page in some browsers */
  }
  return ui.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * Initialise the active dictionary from settings + browser locale. Safe to
 * call multiple times (re-reads on each call). Call once early in each
 * extension entry point.
 */
export async function initI18n(): Promise<'en' | 'zh'> {
  try {
    const s = await loadSettings();
    const lang = pickLocale(s.locale);
    activeDict = DICTS[lang] ?? EN;
    return lang;
  } catch {
    activeDict = EN;
    return 'en';
  }
}

export function t(key: string, vars?: Record<string, string>): string {
  let out = activeDict[key] ?? EN[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, v);
    }
  }
  return out;
}
