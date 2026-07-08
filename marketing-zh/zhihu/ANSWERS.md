# 知乎回答模板

## 目标问题

搜索并回答这些问题（长尾 SEO 效果好）：

1. "有哪些好用的 Markdown 编辑器？"
2. "Typora 有什么替代品？"
3. "有什么免费的 Markdown 编辑器推荐？"
4. "MarkText 停更了，有什么替代品？"
5. "轻量级的 Markdown 编辑器有哪些？"
6. "macOS 上有什么好用的 Markdown 编辑器？"
7. "写作软件有哪些推荐？"

---

## 回答模板 1：通用版

### 适用问题："有哪些好用的 Markdown 编辑器？"

```markdown
推荐一个我最近在用的：**SoloMD**

这是一个国人开发的开源 Markdown 编辑器，我觉得它最大的特点是**轻量**。

**为什么说轻量？**

- 安装包只有 15 MB（对比：Typora 80MB，Obsidian 250MB）
- 启动速度快，打开就能写
- 不需要账号，不联网，不收集数据

**我喜欢的几个功能：**

1. **所见即所得**：Markdown 标记符号（比如 `#`、`**`）在光标离开后会自动隐藏，看起来很干净
2. **GBK 自动识别**：打开老文件不乱码，这个对中文用户很友好
3. **一键清除 AI 格式**：从 ChatGPT 复制内容过来，那些 `[cite_start]` 和弯引号可以一键清掉
4. **KaTeX + Mermaid**：支持数学公式和流程图
5. **导出格式全**：HTML、PDF、Word 都支持

**技术栈**：Tauri 2 + Rust + Vue 3，所以体积小、启动快。

**价格**：免费，MIT 开源

**支持平台**：macOS / Windows / Linux

官网：https://solomd.app
GitHub：https://github.com/zhitongblog/solomd

---

如果你只是想找一个简单、快速、免费的 Markdown 编辑器，不需要 Obsidian 那种知识库功能，可以试试这个。
```

---

## 回答模板 2：Typora 替代版

### 适用问题："Typora 有什么替代品？" / "Typora 收费后用什么？"

```markdown
Typora 收费后我也找了很久替代品，试了一圈最后留下了 **SoloMD**。

**为什么选它？**

| 对比项 | SoloMD | Typora |
|--------|--------|--------|
| 价格 | 免费开源 | $14.99 |
| 安装包大小 | ~15 MB | ~80 MB |
| 所见即所得 | ✓ | ✓ |
| 数学公式 | ✓ (KaTeX) | ✓ |
| 流程图 | ✓ (Mermaid) | ✓ |
| GBK/Big5 编码 | ✓ | ✓ |
| 开源 | ✓ (MIT) | ✗ |

**SoloMD 额外的优点：**

1. 一键清除 AI 对话的格式垃圾（从 ChatGPT/Claude 复制内容很方便）
2. 简繁转换
3. 零遥测，完全离线

**SoloMD 的不足：**

1. 没有 Typora 的主题系统那么丰富
2. 表格编辑没有 Typora 方便（这个确实）
3. 项目比较新，可能有些小 bug

如果你主要需求是写文档、写博客，不需要太复杂的排版，SoloMD 完全够用，而且免费。

下载：https://solomd.app
```

---

## 回答模板 3：技术向

### 适用问题："有什么用 Rust 写的桌面应用？" / "Tauri 做的应用有哪些？"

```markdown
推荐一个我最近发现的：**SoloMD** —— 用 Tauri 2 + Rust 写的 Markdown 编辑器。

**技术栈：**
- 后端：Tauri 2（Rust）
- 前端：Vue 3 + TypeScript + Vite
- 编辑器：CodeMirror 6
- 编码检测：chardetng + encoding_rs

**为什么体积只有 15 MB？**

因为 Tauri 用的是系统自带的 WebView（macOS 是 WKWebView，Windows 是 WebView2），不像 Electron 要打包整个 Chromium。

**如果你想学习 Tauri 2 开发**，这个项目是个不错的参考：
- 代码结构清晰
- MIT 开源
- 有完整的 CI/CD 配置

GitHub：https://github.com/zhitongblog/solomd
```

---

## 发文章（可选）

### 标题
```
我用 Tauri 2 做了一个 15MB 的 Markdown 编辑器
```

### 文章结构

1. **引子**：为什么现在的编辑器都这么大？
2. **痛点**：Typora 收费、MarkText 停更、Obsidian 太重
3. **解决方案**：介绍 SoloMD
4. **技术实现**：Tauri 2 为什么能做到这么小
5. **功能展示**：截图 + 功能列表
6. **下载链接**

---

## 注意事项

1. **不要刷屏**：一天最多回答 2-3 个问题
2. **要有价值**：不要纯推广，要真正回答问题
3. **承认不足**：说一些 SoloMD 的缺点，显得客观
4. **配图**：知乎支持图片，放上截图和对比图

## 附带图片

- `og-image-zh.png` - 封面图
- `comparison-zh.png` - 对比表格图
