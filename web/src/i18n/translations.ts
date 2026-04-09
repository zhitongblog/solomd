export type Lang = 'en' | 'zh';

export const t = {
  en: {
    nav: {
      features: 'Features',
      download: 'Download',
      sponsor: 'Sponsor',
      github: 'GitHub →',
    },
    hero: {
      badge: 'v0.1.0 · MIT · Cross-platform',
      title1: 'One file. One window.',
      title2: 'Just write.',
      lead: 'A lightweight, distraction-free Markdown + plain text editor for macOS, Windows, and Linux. Built with Tauri 2 — under 15 MB installed.',
      ctaPrimary: 'Download SoloMD ↓',
      ctaSecondary: 'Star on GitHub ⭐',
      chips: ['📝 Live preview', '🖼 Image paste', '🧮 KaTeX', '📊 Mermaid', '🌏 中文 first-class', '📤 PDF / DOCX / HTML'],
    },
    features: {
      heading1: 'Everything you need.',
      heading2: "Nothing you don't.",
      lead: "SoloMD ships with the features serious writers want and skips the bloat that gets in the way.",
      items: [
        { icon: '✨', title: 'Live Preview', desc: 'Markdown markers fade away when you leave a line. Headings get bigger, bold gets bold — no toolbars in the way.' },
        { icon: '🎨', title: 'Rich syntax styling', desc: '13 code-block languages, KaTeX math, Mermaid diagrams, footnotes, YAML front-matter, ==highlight==.' },
        { icon: '🖼', title: 'Image paste & drag-drop', desc: 'Screenshot then ⌘V — image saves to _assets/ and inserts a markdown link automatically.' },
        { icon: '🌳', title: 'File tree + global search', desc: 'Open a folder, browse files, ripgrep-style search across every .md and .txt.' },
        { icon: '🌗', title: 'Light & dark themes', desc: 'Follows your system preference. Custom CSS theme support for power users.' },
        { icon: '🌏', title: 'Chinese first-class', desc: 'Auto encoding detection (UTF-8 / GBK / Big5), CJK word count, simplified ↔ traditional, pinyin export.' },
        { icon: '📤', title: 'Export anywhere', desc: 'PDF (with KaTeX & Mermaid), Word .docx, HTML, copy as rich HTML or plain text.' },
        { icon: '🎯', title: 'Focus & typewriter modes', desc: 'Dim non-active lines. Keep cursor centered. Long-form writing without distraction.' },
        { icon: '💾', title: 'Session restore', desc: 'Auto-save unsaved buffers every 500 ms. Crash recovery built in.' },
        { icon: '⌨️', title: 'Command palette', desc: '⌘⇧K to access every command. Native menu bar on macOS / Windows / Linux.' },
        { icon: '🔌', title: 'OS file association', desc: 'Double-click any .md or .txt file to open in SoloMD. Multi-window support.' },
        { icon: '🦀', title: 'Tiny & fast', desc: '~15 MB installer (vs Typora 70 MB / Obsidian 110 MB). Tauri 2 + Rust + Vue 3 + CodeMirror 6.' },
      ],
    },
    download: {
      heading: 'Download SoloMD',
      lead: 'Free and open source. MIT license. No account needed.',
      platforms: {
        macos: { name: 'macOS', note: 'Universal · Apple Silicon + Intel · Notarized', primary: 'Download .dmg' },
        windows: { name: 'Windows', note: 'x64 · Windows 10/11', primary: 'Download .msi', secondary: '.exe installer' },
        linux: { name: 'Linux', note: 'x64 · .AppImage / .deb / .rpm', primary: 'Download .AppImage', secondary: '.deb (Debian/Ubuntu)', tertiary: '.rpm (Fedora/RHEL)' },
      },
      notes: {
        macos: 'Drag SoloMD.app to /Applications. Notarized — no Gatekeeper warning.',
        windows: 'First launch may show "Windows protected your PC" → click More info → Run anyway (one-time, until reputation builds).',
        linux: 'chmod +x SoloMD-*.AppImage && ./SoloMD-*.AppImage for the AppImage.',
      },
      allReleases: 'Looking for older versions?',
      allReleasesLink: 'All releases →',
    },
    sponsor: {
      heading: 'Support SoloMD',
      lead: 'SoloMD is built and maintained by one developer in their free time. If it helps your writing, consider sponsoring — even a tiny amount keeps the project alive.',
      ghButton: '🌍 GitHub Sponsors',
      cnButton: '🇨🇳 爱发电',
      note: 'Sponsors get listed in the README and the in-app About dialog (with permission).',
    },
    footer: {
      legal: 'Released under the MIT License',
      stack: 'Made with Tauri 2 · Vue 3 · CodeMirror 6 · Rust',
    },
    langSwitch: '中文',
    langSwitchHref: '/zh/',
  },
  zh: {
    nav: {
      features: '功能',
      download: '下载',
      sponsor: '赞助',
      github: 'GitHub →',
    },
    hero: {
      badge: 'v0.1.0 · MIT 协议 · 跨平台',
      title1: '一个文件,一个窗口,',
      title2: '专心写作。',
      lead: '一款轻量、无干扰的 Markdown 与纯文本编辑器,支持 macOS / Windows / Linux 三平台。基于 Tauri 2 构建,安装包小于 15 MB。',
      ctaPrimary: '下载 SoloMD ↓',
      ctaSecondary: 'GitHub 点亮 ⭐',
      chips: ['📝 实时预览', '🖼 图片粘贴', '🧮 KaTeX 公式', '📊 Mermaid 图表', '🌏 中文一等公民', '📤 PDF / DOCX / HTML'],
    },
    features: {
      heading1: '该有的都有,',
      heading2: '不要的全都没有。',
      lead: 'SoloMD 集合了写作者真正需要的功能,跳过所有让人分心的多余设计。',
      items: [
        { icon: '✨', title: '实时预览', desc: '光标离开行后 Markdown 标记自动隐藏,标题真大,粗体真粗,无工具条干扰。' },
        { icon: '🎨', title: '富语法着色', desc: '13 种代码块语言、KaTeX 数学公式、Mermaid 图表、脚注、YAML front-matter、==高亮==。' },
        { icon: '🖼', title: '图片粘贴拖拽', desc: '截图后 ⌘V 直接粘贴,图片自动存到 _assets/ 文件夹,并插入 markdown 链接。' },
        { icon: '🌳', title: '文件树 + 全局搜索', desc: '打开文件夹,侧栏浏览文件,跨所有 .md / .txt 文件 ripgrep 风格搜索。' },
        { icon: '🌗', title: '明暗主题', desc: '跟随系统偏好。支持自定义 CSS 主题,高级用户可深度定制。' },
        { icon: '🌏', title: '中文一等公民', desc: '自动识别编码 (UTF-8 / GBK / Big5),CJK 字数统计,简繁转换,拼音导出。' },
        { icon: '📤', title: '一键导出', desc: 'PDF (含公式和图表)、Word .docx、HTML,复制为富文本或纯文本。' },
        { icon: '🎯', title: '焦点 + 打字机模式', desc: '非当前行变暗,光标始终居中,长文写作零干扰。' },
        { icon: '💾', title: '会话恢复', desc: '每 500 毫秒自动保存未保存内容,崩溃自动恢复,永不丢失。' },
        { icon: '⌨️', title: '命令面板', desc: '⌘⇧K 召唤所有命令。macOS / Windows / Linux 三平台原生菜单栏。' },
        { icon: '🔌', title: '系统文件关联', desc: '双击 .md / .txt 文件直接用 SoloMD 打开,支持多窗口。' },
        { icon: '🦀', title: '又小又快', desc: '约 15 MB 安装包 (对比 Typora 70 MB / Obsidian 110 MB),启动 < 1 秒。' },
      ],
    },
    download: {
      heading: '下载 SoloMD',
      lead: '完全免费开源。MIT 协议。无需注册任何账号。',
      platforms: {
        macos: { name: 'macOS', note: '通用版 · Apple Silicon + Intel · 已 Notarize', primary: '下载 .dmg' },
        windows: { name: 'Windows', note: 'x64 · Windows 10/11', primary: '下载 .msi', secondary: '.exe 安装程序' },
        linux: { name: 'Linux', note: 'x64 · .AppImage / .deb / .rpm', primary: '下载 .AppImage', secondary: '.deb (Debian/Ubuntu)', tertiary: '.rpm (Fedora/RHEL)' },
      },
      notes: {
        macos: '将 SoloMD.app 拖入 /Applications。已 notarized,无任何安全警告。',
        windows: '首次运行可能显示 "Windows 已保护你的电脑" → 点击 "更多信息" → "仍要运行" 即可。只此一次。',
        linux: 'AppImage 需先 chmod +x 然后直接运行;deb / rpm 用对应包管理器安装。',
      },
      allReleases: '想找历史版本?',
      allReleasesLink: '所有版本 →',
    },
    sponsor: {
      heading: '赞助 SoloMD',
      lead: 'SoloMD 由一位开发者在业余时间开发维护。如果它帮到了你的写作,欢迎赞助支持开发,哪怕是一杯咖啡的钱。',
      ghButton: '🌍 GitHub Sponsors',
      cnButton: '🇨🇳 爱发电',
      note: '赞助者将被列入 README 和 app 内的"关于"对话框 (需同意)。',
    },
    footer: {
      legal: '基于 MIT 协议开源',
      stack: '由 Tauri 2 · Vue 3 · CodeMirror 6 · Rust 构建',
    },
    langSwitch: 'English',
    langSwitchHref: '/',
  },
} as const;

export function getT(lang: Lang) {
  return t[lang];
}
