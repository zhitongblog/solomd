# V2EX 发帖指南

## 发帖节点

推荐节点（按优先级排序）：
1. **分享创造** (`/go/create`) - 最适合，专门分享自己做的东西
2. **程序员** (`/go/programmer`) - 如果强调技术实现
3. **macOS** (`/go/macos`) - 如果主推 Mac 版本
4. **分享发现** (`/go/share`) - 备选

## 标题

```
SoloMD：一个只有 15 MB 的 Markdown 编辑器，用 Tauri 2 + Rust 写的
```

或者更吸引眼球的版本：

```
受够了 200MB 的文本编辑器，所以自己做了一个 15MB 的
```

## 正文

```markdown
大家好，我做了一个 Markdown 编辑器叫 SoloMD，想来分享一下。

**为什么做这个？**

之前一直用 Typora，后来收费了。试了 MarkText，停更了。Obsidian 太重，我只是想写个文档，不需要知识图谱。VS Code 要开整个 IDE。

我就想要一个：
- 打开快
- 体积小
- 不联网
- 不要订阅

所以自己做了一个。

**SoloMD 有什么特点？**

1. **小** - 安装包只有 15 MB（Typora 80MB，Obsidian 250MB）
2. **快** - 用的是系统 WebView，不打包 Chromium
3. **所见即所得** - Markdown 标记符号在光标离开后自动隐藏
4. **中文友好** - GBK/Big5 自动识别、简繁转换、CJK 字数统计
5. **AI 友好** - 一键清除从 ChatGPT/Claude 复制过来的 `[cite_start]` 垃圾
6. **零遥测** - 不联网，不收集任何数据

**技术栈**

- Tauri 2（Rust 后端 + 系统 WebView）
- Vue 3 + TypeScript
- CodeMirror 6

**下载**

- 官网：https://solomd.app
- GitHub：https://github.com/zhitongblog/solomd
- 支持 macOS / Windows / Linux

MIT 开源，免费使用。

---

欢迎试用，有问题可以直接回复或者去 GitHub 提 issue。
```

## 发帖技巧

1. **时间**：工作日上午 9-11 点，或晚上 8-10 点
2. **回复**：及时回复每一条评论，V2EX 很看重互动
3. **不要**：
   - 不要求 star（会被喷）
   - 不要过度营销（会被移动到水深火热）
   - 不要和杠精争论

## 常见问题回复模板

### "为什么不用 VS Code？"
```
VS Code 确实强大，但我只是想打开一个 md 文件快速写点东西，不想启动整个 IDE。SoloMD 定位就是轻量记事本，不是 IDE。
```

### "为什么不用 Obsidian？"
```
Obsidian 是知识库管理工具，有双链、图谱这些功能。SoloMD 就是个编辑器，打开文件、写、保存、关闭。不同定位，不冲突。
```

### "Typora 不香吗？"
```
Typora 确实好用，但收费了。SoloMD 免费开源，MIT 协议。而且体积更小（15MB vs 80MB）。
```

### "Tauri 成熟吗？"
```
Tauri 2.0 已经正式发布了，我用下来挺稳定的。主要优势是用系统 WebView，不用打包 Chromium，所以体积小很多。当然跨平台会有一些小差异，但对于文本编辑器来说影响不大。
```

## 附带图片

- `og-image-zh.png` - 可以作为封面图
- `comparison-zh.png` - 对比图，可以在回复中使用
