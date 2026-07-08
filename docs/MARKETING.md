# SoloMD 推广计划

## 目标用户画像

### Tier 1：最容易转化（痛点明确）

| 人群 | 为什么选 SoloMD | 去哪找他们 |
|---|---|---|
| **MarkText 难民** | MarkText 停更，找替代 | GitHub MarkText issues、Reddit r/markdown |
| **Typora 免费版怀念者** | Typora 2021 收费后大批流失 | 知乎"Typora 替代品"、V2EX |
| **AI 内容工作者** | 每天从 ChatGPT/Claude 复制，被 `[cite_start]` 折磨 | 即刻、Twitter AI 圈、小红书 AI 博主 |
| **中文技术博客作者** | Hugo/Hexo/Jekyll 写博客，需要本地 MD 编辑器 | V2EX、掘金、CSDN |

### Tier 2：需要教育但体量大

| 人群 | 卖点 | 渠道 |
|---|---|---|
| **隐私敏感用户** | 零网络、零遥测、文件不出本机 | Reddit r/privacy、少数派 |
| **轻量工具爱好者** | 15 MB vs 110 MB Obsidian | Hacker News、Reddit r/linux |
| **Tauri/Rust 开发者** | 想看 Tauri 2 真实项目 | Tauri Discord、Rust 社区 |
| **学生** | 免费 + KaTeX 数学 + 导出 PDF/DOCX 交作业 | 大学论坛、知乎 |

### 不要追的人

| 人群 | 为什么不追 |
|---|---|
| Obsidian 重度用户 | 他们要的是知识图谱不是编辑器 |
| Notion 用户 | 他们要的是云协作 |
| VS Code 用户 | 已经有 Markdown 扩展 |
| 企业采购 | 我们没有 admin/compliance 功能 |

---

## 推广路线图

### 第 1 周（零成本，立刻做）

| # | 行动 | 预计时间 | 预期效果 |
|---|---|---|---|
| 1 | **Hacker News "Show HN"** | 30 分钟写帖 | 如果上首页：500-2000 stars + 数千下载 |
| 2 | **V2EX 发帖** | 20 分钟 | 中文开发者圈第一波用户 |
| 3 | **Reddit r/markdown + r/opensource** | 15 分钟 | 国际用户 |
| 4 | **Product Hunt 提交** | 1 小时准备素材 | 产品圈曝光 |
| 5 | **GitHub Awesome 列表 PR** | 30 分钟 | 长期 SEO + 引流 |

### 第 1-2 周

| # | 行动 | 说明 |
|---|---|---|
| 6 | **写一篇"为什么我做了 SoloMD"** | 少数派 (sspai.com) / 掘金 / 微信公众号，讲故事比讲功能有效 10x |
| 7 | **小众软件 (appinn.com) 投稿** | 中国最大的软件发现平台之一 |
| 8 | **知乎回答** | "最好的免费 Markdown 编辑器" / "Typora 有什么替代品" 长尾 SEO |
| 9 | **Twitter/X 发布推文** | 英文 + #markdown #tauri #opensource |
| 10 | **即刻发帖** | 中文科技社区 |

### 第 1-3 月

| # | 行动 | 说明 |
|---|---|---|
| 11 | **录一个 2 分钟 demo 视频** | YouTube + Bilibili，视觉冲击力强 |
| 12 | **写对比文章** | "SoloMD vs Typora" / "SoloMD vs MarkText" / "SoloMD vs Obsidian" |
| 13 | **提交到包管理器** | Homebrew formula / AUR / winget / Scoop |
| 14 | **GitHub Discussions 开放** | 让用户交流 + 收集反馈 |

---

## 三个核心传播话术

### 话术 1：中文圈（V2EX / 知乎 / 少数派）

> **SoloMD：一个为中文用户设计的轻量 Markdown 编辑器**
>
> 安装包只有 15 MB（Typora 的 1/5），免费开源，MIT 协议。
>
> 三个别人没有的东西：
> 1. **GBK/Big5 自动识别** — 打开 20 年前的 .txt 不乱码
> 2. **CJK 字数统计 + 简繁转换** — 状态栏直接显示"字"数
> 3. **一键清除 AI 对话垃圾** — 粘贴 ChatGPT 内容不再有 `[cite_start]`
>
> 🍎 macOS 已 notarize | 🪟 Windows | 🐧 Linux
> 下载: https://solomd.app

### 话术 2：国际圈（Hacker News / Reddit）

> **Show HN: SoloMD — A 15 MB Markdown editor built with Tauri 2 + Rust**
>
> I wanted a Markdown editor that starts instantly, doesn't bundle Chromium, and doesn't require an account. SoloMD is what I ended up building.
>
> - Live preview (markers hide when you leave a line)
> - KaTeX, Mermaid, image paste, focus mode
> - Multi-encoding (auto-detects GBK/Big5/Shift_JIS)
> - "Clean AI Artifacts" — strips junk from ChatGPT/Gemini copy-paste
> - ~15 MB installed (vs Typora 70 MB / Obsidian 110 MB)
> - MIT licensed, no telemetry, fully offline
>
> https://solomd.app | https://github.com/zhitongblog/solomd

### 话术 3：AI 内容圈（即刻 / 小红书 / Twitter）

> **每天从 AI 对话框里复制内容？受够了 `[cite_start]` 和弯引号？**
>
> SoloMD 有个"一键清除 AI 格式"按钮——把 Gemini/ChatGPT/Perplexity 的引用标记、零宽空格、弯引号全部干掉，只留干净的文字。
>
> 免费的，15 MB，三平台。 https://solomd.app

---

## Awesome 列表投稿目标

提交 PR 到这些 GitHub Awesome 列表：

- [awesome-markdown](https://github.com/BubuAnab662/awesome-markdown) — Markdown 工具集合
- [awesome-tauri](https://github.com/nicehash/awesome-tauri) — Tauri 项目集合
- [awesome-rust](https://github.com/rust-unofficial/awesome-rust) — Rust 项目（Applications → Text editors）
- [awesome-vue](https://github.com/vuejs/awesome-vue) — Vue 项目（Desktop → Tauri）
- [awesome-opensource-apps](https://github.com/unicodeveloper/awesome-opensource-apps)
- [awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted) — 如果加上 WebDAV 同步的话

## 包管理器提交

| 包管理器 | 平台 | 提交方式 |
|---|---|---|
| **Homebrew Cask** | macOS | PR to homebrew-cask 仓库 |
| **AUR** | Arch Linux | 创建 PKGBUILD |
| **winget** | Windows | PR to winget-pkgs 仓库 |
| **Scoop** | Windows | 创建 bucket manifest |
| **Flatpak** | Linux 通用 | 创建 Flatpak manifest |
| **Snap** | Ubuntu | 创建 snapcraft.yaml |

---

## KPI 追踪

| 指标 | 第 1 周目标 | 第 1 月目标 | 第 3 月目标 |
|---|---|---|---|
| GitHub Stars | 100 | 500 | 2000 |
| 总下载量 | 500 | 2000 | 10000 |
| 日活用户 | 50 | 200 | 1000 |
| 赞助者数 | 0 | 5 | 20 |
| Hacker News 排名 | 首页 | — | — |
| Product Hunt 排名 | Top 10 当日 | — | — |

## 工具

- **下载量追踪**: GitHub Releases 自带统计（`gh api repos/zhitongblog/solomd/releases -q '.[].assets[].download_count'`）
- **网站分析**: Cloudflare Web Analytics（免费，已内置）
- **Star 历史**: https://star-history.com/#zhitongblog/solomd
- **社交监控**: 搜 "SoloMD" 在 Twitter / Reddit / HN / V2EX
