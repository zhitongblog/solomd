# SoloMD

> 一个 Markdown 编辑器，也是连接 LLM 的桥。

[![最新版本](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)
[![下载量](https://img.shields.io/github/downloads/zhitongblog/solomd/total)](https://github.com/zhitongblog/solomd/releases)
[![官网](https://img.shields.io/badge/官网-solomd.app-ff9f40.svg)](https://solomd.app/zh)

🌐 **[English README →](README.md)**

[**下载**](https://github.com/zhitongblog/solomd/releases/latest) · [**官网**](https://solomd.app/zh) · [**安全说明**](https://solomd.app/zh/security) · [**FAQ**](https://solomd.app/zh#faq)

![SoloMD 编辑器](web/public/demo/solomd-demo.svg)

你的笔记是一个文件夹。**SoloMD 既是上面的编辑器，也是 Claude Code / Codex CLI / Cursor 直接能驱动的 MCP 端点。** 同样的 `.md` 文件，两条入口。

基于 Tauri 2 + Vue 3 + CodeMirror 6 构建。Mac universal dmg ~32 MB。免费 / MIT / 无订阅 / 无 SoloMD 服务器。笔记、AI key、嵌入索引、git 历史，全部留在你自己的机器上。

## 同一份产品的两半

**编辑器。** WYSIWYG 实时编辑（Typora 风格）、标签 + 分屏、KaTeX + Mermaid 数学公式、图片粘贴到 `_assets/`、演讲模式（`⌘⌥P`）、Vim 模式、Hunspell + 中文校对、语义搜索（`⌘⇧F`）、wikilink + 反链、Pandoc 导出。CJK 编码（GBK / Big5 / Shift-JIS）自动识别。

**端点。** 自带 `solomd-mcp` 二进制，把同一个 vault 暴露给任意 MCP 客户端 —— 开箱 13 个工具，其中 5 个 SoloMD 独有（`autogit_log`、`autogit_diff`、`autogit_rollback`、`sync_status`、`share_url`），别家 markdown MCP 服务都没有。再加一个 `solomd agent <prompt>` 命令行，把任务直接交给 Claude Code / Codex CLI，MCP 已预先连好。

| 功能 | |
|---|---|
| **AI 改写，BYOK** | 14 个服务 —— OpenAI · Claude · Gemini · DeepSeek · 通义千问 · 智谱 GLM · Kimi · 豆包 · 硅基流动 · OpenRouter · Mistral · Groq · xAI · Ollama。Key 存在系统钥匙串里，直连厂商，不经我们手。 |
| **GitHub 同步** | 每次保存推到自己的 GitHub 私库，定时拉取。可选端到端加密（Argon2id + XChaCha20-Poly1305）。GitLab / Gitea / 任意 HTTPS git 地址也支持。 |
| **每篇笔记 AutoGit** | 每次 `⌘S` 在工作区里的本地 `.git` 写一次提交。libgit2 内嵌，不需要装系统 git。永不自动 push。 |
| **内置 MCP server** | `solomd-mcp` 跟随安装包发出，13 个工具（8 通用 + 5 SoloMD-only）。stdio 协议，不开网络端口。默认只读，`--allow-write` 显式开启写入。 |
| **云盘联动** | 工作区在 `~/Library/Mobile Documents/...` 或 `~/Dropbox/...` 里时，SoloMD 自动识别，并在此之上加一层跨设备会话恢复 —— 文件级同步交给系统。 |
| **公开只读分享** | 命令面板 → 复制 `solomd.app/share/?repo=...&path=...` 链接。任何人在浏览器里就能阅读你公库里这篇笔记，不用装 SoloMD。 |

## 从 LLM 这边用 SoloMD

macOS / Linux 装好 SoloMD 后：

```bash
# 一键打印 MCP 配置片段，粘到你的 AI 客户端配置里
solomd mcp-config
```

```json
{
  "mcpServers": {
    "solomd": {
      "command": "/Applications/SoloMD.app/Contents/Resources/solomd-mcp",
      "args": ["--workspace", "/Users/me/Documents/SoloMD"]
    }
  }
}
```

或者一句话直接跑 agent：

```bash
# 把 prompt 交给 PATH 上的 claude / codex（哪个都行），
# solomd-mcp 已预先接好，--allow-write 开启
solomd agent "把这周的 daily 整理成 weekly review，提交并推送"
```

路径穿越保护已加；不开网络端口；LLM 只能看到你指给它的工作区。

## 安装

最新版本：[v3.5.0](https://github.com/zhitongblog/solomd/releases/latest)。

### macOS — universal dmg（Apple Silicon + Intel，已公证）

```bash
brew install --cask zhitongblog/solomd/solomd
```

或直接下 dmg：

```
https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_3.5.0_universal.dmg
```

或 curl 一键安装：

```bash
curl -fsSL https://solomd.app/install.sh | bash
```

### Windows — x64

- [`SoloMD_3.5.0_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_3.5.0_x64_en-US.msi)
- [`SoloMD_3.5.0_x64-setup.exe`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_3.5.0_x64-setup.exe)（NSIS）
- [`SoloMD_3.5.0_x64-portable.zip`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_3.5.0_x64-portable.zip) — 免安装版

```powershell
irm https://solomd.app/install.ps1 | iex
```

### Linux — x86_64 + aarch64

- `.AppImage`（通用）、`.deb`（Debian/Ubuntu）、`.rpm`（Fedora/RHEL）—— 两种架构都在 [发布页](https://github.com/zhitongblog/solomd/releases/latest)。

### iPad

[App Store](https://apps.apple.com/app/solomd/id6762498874) —— 同一引擎，原生 iPad UI。

## 横向对比

| | SoloMD | Obsidian | Typora | Tolaria |
|---|---|---|---|---|
| 协议 | **MIT** | 私有协议（免费） | 付费（$14.99） | AGPL |
| 技术栈 | Tauri 2（Rust + WebView） | Electron | Electron | Tauri 2 |
| 平台 | macOS · Win · Linux · iPad | macOS · Win · Linux · iOS · Android | macOS · Win · Linux | macOS · Linux |
| 安装包 | ~32 MB（Mac）/ ~10 MB（Win） | ~120 MB | ~95 MB | ~25 MB |
| **MCP server** | **✅ 内置 13 工具，5 个独家** | ❌（社区插件） | ❌ | ✅ 通用 |
| **AI 改写内建** | **✅ 14 个 BYOK 服务** | 仅插件 | ❌ | 通过外部 MCP |
| GitHub 同步 | ✅ | ❌（Obsidian Sync $96/年） | ❌ | ❌ |
| 端到端加密 | ✅ 在你自己的库里 | ✅ 在 Obsidian 服务器上 | ❌ | ❌ |
| 本地语义搜索 | ✅ 默认关 | 仅插件 | ❌ | ❌ |
| 每篇笔记版本历史 | ✅ AutoGit | 仅插件 | ❌ | ✅ |
| CJK 编码（GBK / Big5） | ✅ 自动识别 | ❌ | ❌ | ❌ |

详细对比：[vs Obsidian](https://solomd.app/zh/compare/vs-obsidian) · [vs Typora](https://solomd.app/zh/compare/vs-typora) · [vs Tolaria](https://solomd.app/zh/compare/vs-tolaria) · [vs Marktext](https://solomd.app/zh/compare/vs-marktext)。

## 隐私与安全

纯客户端。你的 `.md` 文件留在你选的文件夹里。API key 存在系统钥匙串（macOS Keychain / Windows Credential Manager / Linux libsecret），**永远不进 localStorage 或配置文件**。AI 请求从你的机器直连厂商 —— 不经 SoloMD 中转。RAG 嵌入索引和 AutoGit 仓库都是本地。MCP server 走 stdio，不开网络端口。整个代码库 MIT 协议，可审计。

E2EE 同步用 Argon2id（RFC9106 默认参数）→ XChaCha20-Poly1305，确定性 nonce + path-as-AAD。明文留在你的设备上；远端只看到密文。`sync.json` 解析失败会**拒绝推送**，绝不降级到明文（v3.0.x 审计修过的一条）。

完整说明：<https://solomd.app/zh/security>。

## 从源码编译

依赖：Rust（stable）、Node 18+、pnpm。

```bash
git clone https://github.com/zhitongblog/solomd.git
cd solomd/app
pnpm install
pnpm tauri dev      # 热重载开发
pnpm tauri build    # 打 release 包 → src-tauri/target/release/bundle/
```

Linux 还需要 `libdbus-1-dev` 用于钥匙串后端。

MCP server 是独立 crate，在 `mcp-server/` 目录；端到端测试用的 dev MCP harness 在 `dev-mcp/`。

## 贡献

欢迎 Issue / PR —— [开一个](https://github.com/zhitongblog/solomd/issues)。方向参考 [`docs/roadmap.md`](docs/roadmap.md)。

## 联系

一个维护者，两个入口。异步：[GitHub Discussions](https://github.com/zhitongblog/solomd/discussions)。即时：

- **Telegram（国际）：** [@SOLOMDAPP](https://t.me/SOLOMDAPP) — 发版通知 + 闲聊
- **微信（中文）：** 扫码加我，备注 "SoloMD"

<a href="https://solomd.app/#contact"><img src="web/public/contact/wechat.jpg" alt="微信 — 智通" width="180" /></a>
&nbsp;&nbsp;
<a href="https://t.me/SOLOMDAPP"><img src="web/public/contact/telegram.jpg" alt="Telegram @SOLOMDAPP" width="180" /></a>

## License & 致谢

[MIT](LICENSE) © 2026 xiangdong li。SoloMD 站在 Tauri 2、Vue 3、CodeMirror 6、markdown-it、KaTeX、Mermaid、libgit2、Pandoc、Hunspell、`keyring-rs` 和 `rmcp` 的肩膀上。赞助：[GitHub Sponsors](https://github.com/sponsors/zhitongblog) 或 [solomd.app/#sponsor](https://solomd.app/#sponsor)。
