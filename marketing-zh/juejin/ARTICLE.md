# 掘金文章

## 文章分类

- **前端** - 如果强调 Vue 3 / CodeMirror 6
- **Rust** - 如果强调 Tauri / Rust
- **开源** - 通用

---

## 标题

```
用 Tauri 2 + Vue 3 开发一个 15MB 的 Markdown 编辑器
```

或

```
从零开始：用 Rust 和 Tauri 2 打造轻量级桌面应用
```

---

## 正文

```markdown
# 用 Tauri 2 + Vue 3 开发一个 15MB 的 Markdown 编辑器

## 前言

最近用 Tauri 2 做了一个 Markdown 编辑器 —— SoloMD。安装包只有 15MB，比 Electron 应用小了将近 10 倍。

这篇文章分享一下开发过程中的技术选型和踩坑经验，希望对想尝试 Tauri 的同学有帮助。

项目地址：[github.com/zhitongblog/solomd](https://github.com/zhitongblog/solomd)

## 为什么选 Tauri？

### Electron 的问题

Electron 是目前最流行的跨平台桌面开发框架，VS Code、Slack、Discord 都在用。但它有一个众所周知的问题：**打包体积太大**。

每个 Electron 应用都要打包一份 Chromium，这就是 100MB 起步。对于一个文本编辑器来说，这太重了。

### Tauri 的方案

Tauri 的思路是：不打包浏览器，用操作系统自带的 WebView。

| 平台 | WebView |
|------|---------|
| macOS | WKWebView (Safari) |
| Windows | WebView2 (Edge) |
| Linux | WebKitGTK |

这样打包出来的应用就只有几 MB 到十几 MB。

### Tauri 2 vs Tauri 1

Tauri 2 在 2024 年正式发布，相比 1.x 版本有几个重要变化：

1. **支持移动端**（iOS/Android）
2. **插件系统重构**
3. **API 更加模块化**
4. **性能提升**

我是直接用的 Tauri 2，没有从 1.x 迁移的负担。

## 技术栈

```
前端：Vue 3 + TypeScript + Vite
编辑器：CodeMirror 6
Markdown：markdown-it + KaTeX + Mermaid
后端：Tauri 2 (Rust)
编码检测：chardetng + encoding_rs
```

### 为什么选 CodeMirror 6？

做编辑器，编辑器内核的选择很重要。我考虑过几个方案：

| 方案 | 优点 | 缺点 |
|------|------|------|
| Monaco | VS Code 同款，功能强大 | 太重，加载慢 |
| ProseMirror | 灵活，适合富文本 | 对 Markdown 支持一般 |
| CodeMirror 6 | 轻量，扩展性好 | 文档略少 |

最终选了 CodeMirror 6。它的扩展系统设计得很好，可以方便地实现「光标离开后隐藏 Markdown 标记」这样的功能。

### 为什么选 Vue 3？

纯粹是个人偏好。Vue 3 的 `<script setup>` 写起来很舒服，Pinia 状态管理也简单。

React 或 Svelte 也完全可以，Tauri 对前端框架没有限制。

## 核心功能实现

### 1. 所见即所得编辑

这是 SoloMD 的核心功能：Markdown 标记符号在光标离开当前行后自动隐藏。

实现思路：

1. 用 CodeMirror 的 Decoration 系统
2. 监听光标位置变化
3. 对非当前行的 Markdown 语法节点应用「隐藏」样式
4. 同时渲染对应的富文本效果

关键代码（简化版）：

```typescript
const hideMarkersPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet) {
      this.decorations = this.buildDecorations(update.view)
    }
  }

  buildDecorations(view: EditorView) {
    // 获取当前光标所在行
    const cursorLine = view.state.doc.lineAt(
      view.state.selection.main.head
    ).number

    // 遍历语法树，对非当前行的标记添加隐藏样式
    // ...
  }
})
```

### 2. 多编码支持

中文用户经常会遇到 GBK 编码的老文件。大多数编辑器默认 UTF-8，打开 GBK 文件就乱码。

解决方案是用 Rust 的 `chardetng` 库自动检测编码：

```rust
use chardetng::EncodingDetector;
use encoding_rs::Encoding;

pub fn detect_encoding(bytes: &[u8]) -> &'static Encoding {
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    detector.guess(None, true)
}
```

检测到编码后，用 `encoding_rs` 转换成 UTF-8 给前端用。保存时再转回原编码。

### 3. 清除 AI 格式

这个功能是为了解决从 ChatGPT/Claude 复制内容的痛点。AI 对话中经常有这些东西：

- `[cite_start]`、`[cite: xxx]` 引用标记
- 弯引号 `""''` 而不是直引号 `""`
- 零宽空格、零宽连接符
- 特殊的 Unicode 空格

实现就是一系列正则替换：

```typescript
function cleanAiArtifacts(text: string): string {
  return text
    // 移除引用标记
    .replace(/\[cite[^\]]*\]/gi, '')
    .replace(/\[cite_start\]/gi, '')
    // 替换弯引号
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    // 移除零宽字符
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // 统一空格
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
}
```

## 踩坑记录

### 1. WebView 差异

虽然 Tauri 声称「Write once, run everywhere」，但实际上不同平台的 WebView 还是有差异的。

**字体渲染**：macOS 的字体渲染比 Windows 好看，这个没办法。

**滚动条**：CSS 的 `::-webkit-scrollbar` 在 macOS 和 Windows 上表现不同，Linux 上有些甚至不生效。

**拖拽**：文件拖拽的事件处理在不同平台上略有差异，需要做适配。

### 2. 代码签名

Windows 上如果没有代码签名，用户第一次运行会看到「Windows 已保护你的电脑」警告。

解决方案：
1. 买 EV 代码签名证书（贵，$400+/年）
2. 或者等下载量上来，让 SmartScreen 自动信任

目前 SoloMD 选择的是方案 2。

### 3. 打包体积优化

即使用了 Tauri，打包体积也需要优化。几个技巧：

1. **Release 编译**：`--release` 会启用优化，体积更小
2. **Strip 符号**：在 Cargo.toml 里加 `strip = true`
3. **压缩**：Tauri 默认用 NSIS/DMG/AppImage，已经有压缩
4. **按需引入**：前端库按需引入，不要全量导入

## 总结

用 Tauri 2 开发桌面应用的体验总体是正面的：

**优点**：
- 打包体积小
- 启动速度快
- Rust 后端性能好
- 跨平台（包括移动端）

**缺点**：
- Rust 学习曲线陡峭
- WebView 兼容性需要关注
- 生态还在发展中

如果你也想尝试 Tauri，SoloMD 的代码完全开源，欢迎参考：

- GitHub：[github.com/zhitongblog/solomd](https://github.com/zhitongblog/solomd)
- 官网：[solomd.app](https://solomd.app)

---

有问题欢迎评论区交流！
```

---

## 标签

```
Tauri, Rust, Vue3, 前端, 开源, Markdown, 桌面开发
```

## 发布技巧

1. **代码高亮**：掘金支持代码块，用好它
2. **配图**：技术文章也要配图（架构图、截图）
3. **互动**：回复评论
4. **专栏**：可以投稿到相关专栏增加曝光

## 附带图片

- `og-image-zh.png`
- `comparison-zh.png`
- 产品截图
- 技术架构图（如果有的话）
