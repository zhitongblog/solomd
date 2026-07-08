# 块级实时预览完整测试

这份文档专门用来检查 Windows 原生输入框下的块级实时预览。当前正在编辑的块应该保持 Markdown 源码，其他块应该显示为预览效果。

## 1. 普通文字和中文输入

这一段用于测试连续中文输入、英文输入、数字输入和常见标点：中文，英文, number 12345, symbols ! ? : ; ( ) [ ]。

下一段没有复杂语法，主要看实时输入是否顺畅，光标是否稳定，标点是否需要按两次。你可以在这一段末尾继续输入搜狗拼音和微软拼音。

## 2. 强调和行内代码

这是一段包含 **粗体文字**、*斜体文字*、~~删除线~~、`inline code`、[链接](https://example.com) 的普通段落。

行内混排测试：中文 **bold** 中文 `code()` 中文 *italic* 中文。

## 3. 列表

- 第一项
- 第二项，包含 **粗体**
- 第三项，包含 `inline code`

1. 有序列表第一项
2. 有序列表第二项
3. 有序列表第三项

## 4. 任务列表

- [x] 已完成任务
- [ ] 未完成任务
- [ ] 输入法测试任务：在这里输入中文和标点

## 5. 引用块

> 这是一段引用内容。
> 第二行引用应该保持在同一个引用块中。
> 可以在引用块附近点击切换编辑块。

## 6. 表格

| 功能 | 预期结果 | 状态 |
| --- | --- | --- |
| 中文输入 | 候选词正常，提交正常 | 待测 |
| 标点输入 | 不需要按两次 | 待测 |
| 图片显示 | 稳定显示 | 待测 |
| 代码块 | 渲染为代码块 | 待测 |

## 7. 代码块

```ts
type PreviewCase = {
  title: string;
  inputMethod: 'sogou' | 'microsoft' | 'english';
  ok: boolean;
};

function updatePreview(caseItem: PreviewCase) {
  return `${caseItem.title}: ${caseItem.ok ? 'ok' : 'fail'}`;
}
```

```python
def render_block(markdown: str) -> str:
    """Test fenced code blocks in live preview."""
    return markdown.strip()
```

## 8. 本地图片

下面是一张普通英文文件名的本地 SVG 图片：

![Markdown support test](assets/markdown-support-test.svg)

下面是一张中文文件名的本地 SVG 图片，用来测试路径编码和稳定显示：

![中文图片](<assets/中文 图片.svg>)

## 9. HTML 和分隔线

<details>
<summary>展开测试</summary>

这里是 HTML details 内容。

</details>

---

## 10. 符号密集区

中文标点：，。、；：“”‘’（）【】《》！？——……￥

英文标点：, . ; : " ' ( ) [ ] { } < > ! ? - -- ... $ % & @ # ^

成对符号测试：() [] {} <> "" '' “ ” ‘ ’ ` ` ** ** __ __ ~~ ~~

Markdown 转义测试：\*不是斜体\* \#不是标题 \[不是链接\]\(url\) \`不是代码\`

容易误触发 Markdown 的符号：

- 星号：* ** ***
- 下划线：_ __ ___
- 反引号：` `` ```
- 波浪线：~ ~~ ~~~
- 井号：# ## ###
- 大于号：> >> >>>
- 竖线：| || |||

数学和单位符号：+ - × ÷ = ≠ ≈ ≤ ≥ ± ∞ √ π ℃ ° % ‰

连续输入测试：，，，，。。。。！！！！？？？？；；；；::::----____****~~~~

## 11. 数学和化学公式

行内数学公式：$E = mc^2$，$a^2 + b^2 = c^2$，$\alpha + \beta = \gamma$。

上下标和分数：$x_i^2 = \frac{a+b}{c+d}$，$\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$。

块级公式：

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

多行对齐公式：

$$
\begin{aligned}
f(x) &= ax^2 + bx + c \\
f'(x) &= 2ax + b
\end{aligned}
$$

矩阵公式：

$$
\begin{bmatrix}
1 & 2 \\
3 & 4
\end{bmatrix}
\begin{bmatrix}
x \\
y
\end{bmatrix}
=
\begin{bmatrix}
1x + 2y \\
3x + 4y
\end{bmatrix}
$$

化学式普通文本：H2O、CO2、NaCl、C6H12O6、Fe2O3。

化学式上下标写法：H~2~O、CO~2~、C~6~H~12~O~6~。

mhchem 风格行内公式：$\ce{H2O}$，$\ce{CO2}$，$\ce{Na+ + Cl- -> NaCl}$。

mhchem 风格块级反应式：

$$
\ce{2H2 + O2 -> 2H2O}
$$

$$
\ce{CH4 + 2O2 -> CO2 + 2H2O}
$$

$$
\ce{Fe^{3+} + SCN^- <=> FeSCN^{2+}}
$$

## 12. 连续无空行块测试
### 这个标题下一行紧接列表
- 无空行列表第一项
- 无空行列表第二项
#### 紧接另一个标题
这行文字紧接标题，用来测试没有空行时是否还能拆块预览。

## 13. 最后输入区

请在这里连续输入中文、英文和标点，观察当前块是否保持编辑状态，其他块是否保持预览状态。
