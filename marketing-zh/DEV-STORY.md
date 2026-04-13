# SoloMD 开发故事：从痛点到产品

> 一个独立开发者用 Tauri 2 + Vue 3 打造 15MB Markdown 编辑器的完整历程

---

## 起因：三款编辑器的遗憾

故事要从 2023 年说起。

那时候我日常写作用的是 Typora —— 一款几乎完美的 Markdown 编辑器。所见即所得、界面简洁、响应迅速。直到有一天，它开始收费了。

$14.99，说实话不贵。但作为一个开发者，我开始想：这么一个「简单」的编辑器，我能不能自己做一个？

于是我开始调研替代品：

- **MarkText**：开源免费，功能也不错。但项目已经两年没更新了，GitHub 上积压了 1000+ 个 issue。
- **Obsidian**：功能强大到可怕，插件生态繁荣。但 250MB 的安装包？对于一个文本编辑器来说，这太重了。
- **VS Code + 插件**：能用，但总觉得用 IDE 写散文有点杀鸡用牛刀。

我想要的很简单：

```
✓ 轻量（<20MB）
✓ 所见即所得（不要分屏预览）
✓ 中文友好（GBK 编码、字数统计）
✓ 免费开源
```

找了一圈，没有完全符合的。

好，那就自己做。

---

## 技术选型：为什么是 Tauri 2？

### Electron 的问题

做跨平台桌面应用，Electron 是最主流的选择。VS Code、Slack、Discord、Notion 都在用。

但 Electron 有一个众所周知的问题：**打包体积太大**。

原因很简单：每个 Electron 应用都要打包一份完整的 Chromium 浏览器。这意味着你写一个「Hello World」，打包出来也有 100MB+。

对于一个文本编辑器，我接受不了这个体积。

### Tauri 的思路

Tauri 的核心思路是：**不打包浏览器，用操作系统自带的 WebView**。

| 平台 | WebView 引擎 |
|------|-------------|
| macOS | WKWebView (Safari) |
| Windows | WebView2 (Edge Chromium) |
| Linux | WebKitGTK |

这样一来，应用本身只需要打包业务代码，体积就能控制在几 MB 到十几 MB。

### 为什么选 Tauri 2 而不是 1.x？

我开始做 SoloMD 的时候，Tauri 2 刚好发布正式版（2024 年底）。相比 1.x：

1. **插件系统重构**：更模块化，按需引入
2. **API 更清晰**：命令系统、事件系统都重新设计了
3. **支持移动端**：虽然我暂时不需要，但未来有扩展空间
4. **性能提升**：启动速度更快

没有历史包袱，直接用最新版。

### 前端技术栈

```
框架：Vue 3 + TypeScript
构建：Vite
状态管理：Pinia
编辑器内核：CodeMirror 6
Markdown 渲染：markdown-it
数学公式：KaTeX
流程图：Mermaid
```

Vue 3 是个人偏好。`<script setup>` 语法写起来很舒服，Pinia 状态管理也足够简单。

编辑器内核选了 CodeMirror 6，这是整个项目最重要的技术决策，后面会详细说。

---

## 核心功能实现

### 1. 所见即所得：隐藏 Markdown 标记

这是 SoloMD 的核心功能，也是技术上最有挑战的部分。

**需求**：用户输入 `**粗体**`，在光标离开这一行后，只显示「**粗体**」效果，隐藏 `**` 符号。光标回到这一行时，再显示原始的 Markdown 语法。

**为什么选 CodeMirror 6？**

我对比了几个编辑器内核：

| 方案 | 优点 | 缺点 |
|------|------|------|
| Monaco | VS Code 同款，功能强大 | 太重，加载需要几秒 |
| ProseMirror | 灵活，适合富文本 | 对纯 Markdown 支持一般 |
| CodeMirror 6 | 轻量，扩展性极好 | 文档相对较少 |

CodeMirror 6 的扩展系统设计得非常优雅。它有一个 `Decoration` 的概念，可以在不修改原始文本的情况下，给特定范围添加视觉效果（隐藏、替换、高亮等）。

**实现思路**：

```typescript
// 简化版核心逻辑
const livePreviewPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet) {
      this.decorations = this.buildDecorations(update.view)
    }
  }

  buildDecorations(view: EditorView) {
    const builder = new RangeSetBuilder<Decoration>()
    const cursorLine = view.state.doc.lineAt(
      view.state.selection.main.head
    ).number

    // 遍历语法树
    syntaxTree(view.state).iterate({
      enter: (node) => {
        const line = view.state.doc.lineAt(node.from).number

        // 非当前行的标记符号，添加「隐藏」装饰
        if (line !== cursorLine && isMarkdownMarker(node)) {
          builder.add(node.from, node.to, hideDecoration)
        }
      }
    })

    return builder.finish()
  }
})
```

**踩坑记录**：

1. **性能问题**：最初每次按键都重新遍历整个语法树，大文件会卡顿。优化后改为只处理可见区域 + 增量更新。

2. **光标跳动**：隐藏标记符号会改变文本宽度，导致光标位置跳动。解决方案是用 CSS `visibility: hidden` 而不是 `display: none`，保持占位。

3. **嵌套语法**：`**_粗斜体_**` 这种嵌套情况，需要正确处理 AST 节点的层级关系。

### 2. 多编码支持：不只是 UTF-8

中文用户有一个普遍痛点：**老文件的编码问题**。

十年前保存的 txt 文件，很可能是 GBK 编码。用现在的编辑器打开，一片乱码。

大多数现代编辑器默认 UTF-8，对其他编码的支持要么没有，要么很弱。

**解决方案**：在 Rust 后端做编码检测和转换。

```rust
use chardetng::EncodingDetector;
use encoding_rs::Encoding;

pub fn detect_encoding(bytes: &[u8]) -> &'static Encoding {
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    detector.guess(None, true)
}

pub fn read_file_with_encoding(path: &str) -> Result<(String, String)> {
    let bytes = std::fs::read(path)?;
    let encoding = detect_encoding(&bytes);
    let (content, _, _) = encoding.decode(&bytes);
    Ok((content.into_owned(), encoding.name().to_string()))
}
```

- **chardetng**：Mozilla 的编码检测库，准确率很高
- **encoding_rs**：同样来自 Mozilla，负责实际的编码转换

前端只需要处理 UTF-8 字符串，编码转换完全在 Rust 层完成。保存时也会转回原编码，不会破坏文件。

**支持的编码**：UTF-8、GBK、GB2312、Big5、Shift_JIS、EUC-KR 等。

### 3. 清除 AI 格式：现代痛点的现代解法

这个功能是后来加的，源于我自己的日常使用痛点。

每天用 ChatGPT/Claude 写东西，复制到其他地方时总会带上一堆垃圾：

- `[cite_start]`、`[cite: xxx]`、`[citation:xxx]` 各种引用标记
- `"` `"` `'` `'` 弯引号（中文排版可以，但代码里会出问题）
- `​`（零宽空格）、`‌`（零宽非连接符）等不可见字符
- ` `（不间断空格）等特殊空格

手动删太痛苦了，于是做了个一键清理功能。

```typescript
// 清除 AI 生成内容中的各种格式问题
export function cleanAiArtifacts(text: string): string {
  return text
    // 移除各种引用标记（支持多种格式）
    .replace(/\[cite[^\]]*\]/gi, '')
    .replace(/\[citation[^\]]*\]/gi, '')
    .replace(/\[cite_start\]/gi, '')
    .replace(/\[cite_end\]/gi, '')
    .replace(/【\d+†[^】]*】/g, '')  // 中文格式的引用

    // 替换弯引号为直引号
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")

    // 移除零宽字符
    .replace(/[\u200B-\u200D\uFEFF]/g, '')

    // 统一各种特殊空格为普通空格
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')

    // 清理多余空行
    .replace(/\n{3,}/g, '\n\n')
}
```

这个功能实现简单，但解决的是真实痛点。发布后收到不少正面反馈。

---

## 踩坑记录

### 1. 跨平台 WebView 差异

Tauri 宣传「Write once, run everywhere」，但实际上不同平台的 WebView 还是有差异。

**字体渲染**：macOS 的字体渲染明显比 Windows 好看。这个没办法，是系统层面的差异。

**CSS 滚动条**：`::-webkit-scrollbar` 在三个平台上表现都不一样。macOS 默认隐藏，Windows 始终显示，Linux 有些发行版甚至不支持这个伪元素。

**解决方案**：针对不同平台写条件样式。

```css
/* Windows 专用滚动条样式 */
@media screen and (-webkit-min-device-pixel-ratio: 0)
  and (min-resolution: 0.001dpcm) {
  ::-webkit-scrollbar {
    width: 8px;
  }
}
```

**拖拽事件**：文件拖拽到窗口的事件处理，三个平台的行为略有不同，需要分别适配。

### 2. Windows 代码签名

Windows 上如果没有代码签名，用户下载运行时会看到「Windows 已保护你的电脑」的全屏警告，非常吓人。

**解决方案有两个**：

1. 买 EV（Extended Validation）代码签名证书。问题是太贵，$400+/年，对于免费开源项目来说负担很重。

2. 等下载量积累，让 Windows SmartScreen 自动建立信任。

目前 SoloMD 选择的是方案 2。在 README 里说明了这个情况，避免用户被吓到。

### 3. 打包体积优化

即使用了 Tauri，体积优化也需要注意：

**Rust 端**：

```toml
# Cargo.toml
[profile.release]
strip = true       # 移除调试符号
lto = true         # 链接时优化
codegen-units = 1  # 单线程编译，更好的优化
opt-level = "z"    # 优化体积
```

**前端**：

- 按需引入组件库
- Tree-shaking 移除未使用代码
- 图片资源压缩

**最终体积**：

| 平台 | 安装包大小 |
|------|-----------|
| macOS (Apple Silicon) | 8.5 MB |
| macOS (Intel) | 9.2 MB |
| Windows | 15 MB |
| Linux (AppImage) | 12 MB |

对比 Obsidian 的 250MB，我觉得还是很满意的。

### 4. 自动更新

Tauri 有内置的自动更新机制，但配置起来比较繁琐：

1. 需要一个服务器托管更新信息
2. 需要对更新包签名
3. Windows 和 macOS 的更新包格式不同

最终我用 GitHub Releases + 一个简单的 JSON 文件实现了自动更新。

---

## 产品思考

### 做减法比做加法难

刚开始做的时候，脑子里有很多「好想法」：

- 要不要加云同步？
- 要不要支持插件系统？
- 要不要做实时协作？
- 要不要加 AI 写作助手？

后来一一砍掉了。

**云同步**：牵扯到账号系统、服务器成本、数据安全。而且大多数人已经有自己的同步方案（iCloud、OneDrive、Git）。

**插件系统**：开发成本高，维护成本更高。做不好就是灾难。

**实时协作**：这是另一个产品了。

**AI 写作**：噱头大于实用。

最终 SoloMD 的定位是：**一个人，一个文件，专心写作**。

名字「Solo」就是这个意思。

### 开源但不一定社区驱动

我把 SoloMD 开源了（MIT 协议），但并没有期望建立一个活跃的贡献者社区。

原因很现实：维护开源社区需要大量时间和精力，而我这只是个 side project。

开源的目的更多是：

1. **透明**：用户可以确认软件没有恶意行为
2. **学习**：其他开发者可以参考实现
3. **长期存续**：万一我不维护了，代码还在那里

### 小而美 vs 大而全

互联网时代有一种倾向：产品要么做成平台，要么死。

但我觉得「小而美」的产品是有价值的。不是每个人都需要 Notion 那样的全能工具。有时候，一个只做一件事、把这件事做好的工具，反而更让人安心。

SoloMD 可能永远不会有 Obsidian 那样的生态，但对于「只是想安静写点东西」的人来说，也许刚刚好。

---

## 数据与反馈

发布一个月后的数据：

- GitHub Stars: 100+
- 下载量: 500+
- 日活用户: 50+（通过 opt-in 的匿名统计）

收到的主要反馈：

**正面**：
- 「终于有一个不臃肿的 Markdown 编辑器了」
- 「GBK 自动识别太棒了，十年前的笔记终于能打开了」
- 「清除 AI 格式是刚需」

**改进建议**：
- 希望支持 Vim 模式
- 希望支持更多主题
- 希望有 iOS/Android 版本

---

## 下一步计划

1. **Vim 模式**：已经在做了，CodeMirror 6 有现成的扩展
2. **更多主题**：计划支持导入自定义 CSS
3. **移动端**：Tauri 2 支持移动端，但需要重新设计交互

---

## 写在最后

做 SoloMD 的过程，让我对「独立开发」有了新的理解。

不需要融资，不需要团队，一个人用业余时间也能做出有用的产品。关键是找到真实的痛点，然后用最简单的方式解决它。

如果你也在考虑做独立开发，我的建议是：**从自己的痛点出发，先做一个自己愿意用的东西**。

项目地址：[github.com/zhitongblog/solomd](https://github.com/zhitongblog/solomd)

官网：[solomd.app](https://solomd.app)

欢迎试用，有问题随时反馈。

---

*作者：xiangdong li*
*首发于：[填写发布平台]*
*协议：本文采用 CC BY-NC-SA 4.0 协议*
