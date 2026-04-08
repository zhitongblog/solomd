# SoloMD

> One file. One window. Just write.
> 一个文件，一个窗口，专心写作。

[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-orange.svg)](https://tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-42b883.svg)](https://vuejs.org)

A lightweight, cross-platform Markdown + plain text editor. Built with Tauri 2 + Vue 3 + CodeMirror 6.

一款轻量级的跨平台 Markdown 与纯文本编辑器。

---

## ✨ Features / 功能特性

### Core editing / 核心编辑
- 📝 **Live Preview** — Markdown 标记符号在光标离开行后自动隐藏，所见即所得
- 🎨 **Rich syntax styling** — 标题真大、粗体真粗、代码真等宽
- 🌗 **Light / Dark themes** — 跟随系统偏好
- 🔤 **Multi-encoding** — 自动识别 UTF-8 / UTF-16 / GBK / Big5
- 📑 **Tabs** — 多文件并存，脏标记
- 🌳 **File tree sidebar** — 浏览整个文件夹
- 🗺️ **Outline view** — Markdown 标题层级导航
- 🔍 **Global search** — 跨文件 ripgrep 风格搜索

### Markdown power / Markdown 增强
- 🧮 **KaTeX math** — `$E=mc^2$` / `$$\int$$`
- 📊 **Mermaid diagrams** — 流程图、序列图、甘特图
- 📋 **Task lists** — `- [ ]` 可点击 checkbox
- 🔖 **Footnotes** — `[^1]`
- 📑 **YAML front-matter** — 元数据自动渲染
- ✨ **Highlight** — `==高亮==`
- 13 种代码块语法高亮

### Editor super features / 编辑器进阶
- 🖼️ **Image paste / drag-drop** — 自动复制到 `_assets/`
- ✏️ **Spell check**
- 🎯 **Focus mode** — 非当前段变暗
- ⌨️ **Typewriter mode** — 光标始终居中
- 💾 **Session restore** — 防丢失自动保存
- 🌏 **Chinese power tools** — 简繁转换 / 拼音 / CJK 字数统计

### Export / 导出
- 📄 HTML (newsletter quality)
- 📑 PDF (direct, with KaTeX & Mermaid)
- 📘 Word (.docx) with tables
- 📋 Copy as HTML / Plain text / Markdown

### Cross-platform / 跨平台
- 🍎 macOS (universal: Apple Silicon + Intel)
- 🪟 Windows (x64)
- 🐧 Linux (x64: .deb / .AppImage / .rpm)
- 🌐 OS file association — 双击 .md / .txt 自动用 SoloMD 打开

---

## 🚀 Quick Start / 快速开始

### Install / 安装

Download the latest release for your platform from the [Releases page](https://github.com/zhitongblog/solomd/releases).

从 [Releases 页面](https://github.com/zhitongblog/solomd/releases) 下载对应平台的安装包。

#### macOS
Drag `SoloMD.app` to `/Applications`. The first launch may take a moment as macOS verifies the notarized signature.

将 `SoloMD.app` 拖入 `/Applications`。首次启动会稍慢一点（macOS 在校验签名）。

#### Windows
Until SoloMD's Microsoft SmartScreen reputation builds, you may see a blue **"Windows protected your PC"** dialog on first launch. To run anyway:

由于 SoloMD 还没有积累 Microsoft SmartScreen 信誉，**首次运行可能会看到蓝色的 "Windows 已保护你的电脑" 提示**。绕过方法：

1. Click **More info** / 点 **"更多信息"**
2. Click **Run anyway** / 点 **"仍要运行"**

This is a one-time prompt; subsequent launches won't show it. We're a small open-source project — if you'd rather not see this warning at all, please ⭐ the repo (more downloads → faster reputation building) or [sponsor a code-signing certificate](#-support--赞助).

只会出现一次。SoloMD 是个小型开源项目，等下载量上来 SmartScreen 就不再警告了。

#### Linux
- **`.AppImage`**: `chmod +x SoloMD-*.AppImage && ./SoloMD-*.AppImage`
- **`.deb`**: `sudo dpkg -i solomd_*.deb`
- **`.rpm`**: `sudo rpm -i solomd-*.rpm`

### Development / 本地开发

```bash
# Prerequisites: Rust, Node.js, pnpm
cd app
pnpm install
pnpm tauri dev
```

### Build / 构建

```bash
cd app
pnpm tauri build
# Output: src-tauri/target/release/bundle/
```

---

## ⌨️ Shortcuts / 快捷键

| Action | macOS | Win/Linux |
|---|---|---|
| New Markdown / 新建 .md | ⌘N | Ctrl+N |
| New Plain Text / 新建 .txt | ⌘⌥N | Ctrl+Alt+N |
| Open File / 打开 | ⌘O | Ctrl+O |
| Save / 保存 | ⌘S | Ctrl+S |
| Save As / 另存为 | ⌘⇧S | Ctrl+Shift+S |
| Close Tab / 关闭标签 | ⌘W | Ctrl+W |
| New Window / 新窗口 | ⌘⇧N | Ctrl+Shift+N |
| Command Palette / 命令面板 | ⌘⇧K | Ctrl+Shift+K |
| Global Search / 全局搜索 | ⌘⇧F | Ctrl+Shift+F |
| Toggle File Tree / 文件树 | ⌘B | Ctrl+B |
| Toggle Outline / 大纲 | ⌘⇧O | Ctrl+Shift+O |
| Cycle View Mode / 切换视图 | ⌘⇧P | Ctrl+Shift+P |
| Settings / 设置 | ⌘, | Ctrl+, |
| Markdown Help / 帮助 | F1 or ⌘/ | F1 or Ctrl+/ |

---

## 🛠️ Tech Stack

- **Framework**: [Tauri 2](https://tauri.app) (Rust backend, system webview)
- **Frontend**: Vue 3 + TypeScript + Pinia + Vite
- **Editor**: [CodeMirror 6](https://codemirror.net)
- **Markdown**: markdown-it + KaTeX + Mermaid
- **Encoding**: chardetng + encoding_rs
- **Total bundle**: ~10-15 MB installer

---

## 📜 License

[MIT](LICENSE) © 2026 xiangdong li

---

## 💖 Support / 赞助

If SoloMD helps your writing flow, consider sponsoring the development:

如果 SoloMD 让你的写作更高效，欢迎赞助开发者：

- 🌍 GitHub Sponsors: _coming soon_
- 🇨🇳 爱发电: _coming soon_

---

## 🤝 Contributing

PRs welcome! See [issues](https://github.com/zhitongblog/solomd/issues) or open a discussion.

欢迎 PR 和反馈。
