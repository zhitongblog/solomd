# SoloMD 软件分发上架计划

> 版本：v0.1.8
> 更新日期：2026-04-13

---

## 安装包清单

### Windows
| 文件 | 大小 | SHA256 |
|------|------|--------|
| SoloMD_0.1.8_x64-setup.exe | 5.2 MB | `868a9351eaf52b3cb204037ba592204d887950172ea7a982449b51ee81dd9e62` |
| SoloMD_0.1.8_x64_en-US.msi | 6.3 MB | `be380effbfb6ab32ffb81f5f5d06d4b9d9f0c2c959cc62f5d31fbb62af1a2467` |

### macOS
| 文件 | 大小 | SHA256 |
|------|------|--------|
| SoloMD_0.1.8_universal.dmg | 13.1 MB | `76f277a80cd78c64939c9aaa5609c0af22e9daf68873ebaa6176611f0b62c0c5` |

### Linux
| 文件 | 大小 | SHA256 |
|------|------|--------|
| SoloMD_0.1.8_amd64.deb | 7.8 MB | `a3cd34178a0915322e10a2ca2e9b1046a573d10a46afdae02964f6d0b98f68ed` |
| SoloMD-0.1.8-1.x86_64.rpm | 7.8 MB | `3a7f306852259fcfd9986acfdac37bb0eed89749e7b4945dee6d85c7321bbb09` |
| SoloMD_0.1.8_amd64.AppImage | 81.6 MB | `3fc7ca85303c418c3819f732911738a8de0397190470408b7570ad1711d6e142` |

---

## 第一阶段：包管理器（优先级最高）

### 1. Homebrew Cask (macOS) ⭐⭐⭐
**预计耗时**：1-3 天审核

**步骤**：
1. Fork `homebrew/homebrew-cask`
2. 创建 `Casks/s/solomd.rb` 文件
3. 提交 PR

**文件位置**：`manifests/homebrew/solomd.rb`

**提交命令**：
```bash
# 方法一：直接 brew 命令（推荐）
brew tap homebrew/cask
brew create --cask https://github.com/zhitongblog/solomd/releases/download/v0.1.8/SoloMD_0.1.8_universal.dmg

# 方法二：手动 PR
gh repo fork homebrew/homebrew-cask --clone
cd homebrew-cask
cp /path/to/solomd.rb Casks/s/solomd.rb
git checkout -b add-solomd
git add . && git commit -m "Add SoloMD v0.1.8"
gh pr create --title "Add SoloMD v0.1.8" --body "New cask for SoloMD markdown editor"
```

---

### 2. Winget (Windows) ⭐⭐⭐
**预计耗时**：1-7 天审核

**步骤**：
1. Fork `microsoft/winget-pkgs`
2. 创建 manifest 文件夹结构
3. 提交 PR

**文件位置**：`manifests/winget/`

**提交命令**：
```bash
# 方法一：使用 wingetcreate 工具（推荐）
wingetcreate new https://github.com/zhitongblog/solomd/releases/download/v0.1.8/SoloMD_0.1.8_x64-setup.exe

# 方法二：手动 PR
gh repo fork microsoft/winget-pkgs --clone
cd winget-pkgs
mkdir -p manifests/z/zhitongblog/SoloMD/0.1.8
cp /path/to/manifests/* manifests/z/zhitongblog/SoloMD/0.1.8/
git checkout -b add-solomd-0.1.8
git add . && git commit -m "Add SoloMD version 0.1.8"
gh pr create
```

---

### 3. Scoop (Windows) ⭐⭐
**预计耗时**：1-3 天审核

**步骤**：
1. Fork `ScoopInstaller/Extras`
2. 添加 `bucket/solomd.json`
3. 提交 PR

**文件位置**：`manifests/scoop/solomd.json`

**提交命令**：
```bash
gh repo fork ScoopInstaller/Extras --clone
cd Extras
cp /path/to/solomd.json bucket/solomd.json
git checkout -b add-solomd
git add . && git commit -m "solomd: Add version 0.1.8"
gh pr create
```

---

### 4. Chocolatey (Windows) ⭐⭐
**预计耗时**：3-7 天审核（首次较慢）

**步骤**：
1. 注册 Chocolatey 账号：https://community.chocolatey.org/account/register
2. 获取 API Key
3. 打包并上传

**文件位置**：`manifests/chocolatey/`

**提交命令**：
```bash
cd manifests/chocolatey
choco pack
choco push solomd.0.1.8.nupkg --source https://push.chocolatey.org/ --api-key YOUR_API_KEY
```

---

## 第二阶段：软件下载站

### 5. SourceForge ⭐⭐
**费用**：免费
**网址**：https://sourceforge.net/

**步骤**：
1. 注册账号
2. 创建项目：https://sourceforge.net/create/
3. 上传安装包
4. 填写项目描述

**提交信息**：见 `submissions/sourceforge.md`

---

### 6. AlternativeTo ⭐⭐
**费用**：免费
**网址**：https://alternativeto.net/

**步骤**：
1. 搜索 "SoloMD"，如果不存在则添加
2. 添加软件：https://alternativeto.net/software/add/
3. 填写信息并关联到 Typora、Obsidian 等竞品

---

### 7. Softpedia ⭐
**费用**：免费
**网址**：https://www.softpedia.com/

**步骤**：
1. 提交软件：https://www.softpedia.com/get/submit.shtml
2. 等待编辑审核

---

### 8. MajorGeeks ⭐
**费用**：免费
**网址**：https://www.majorgeeks.com/

**步骤**：
1. 提交软件：https://www.majorgeeks.com/content/page/submit_your_software.html
2. 等待审核

---

## 第三阶段：Linux 包管理

### 9. Flathub ⭐⭐
**费用**：免费
**网址**：https://flathub.org/

**步骤**：
1. 创建 Flatpak manifest
2. 提交到 flathub/flathub 仓库

**注意**：需要将应用打包成 Flatpak 格式，工作量较大

---

### 10. Snap Store ⭐
**费用**：免费
**网址**：https://snapcraft.io/

**步骤**：
1. 创建 snapcraft.yaml
2. 使用 snapcraft 构建
3. 上传到 Snap Store

---

## 第四阶段：付费平台（可选）

### 11. Microsoft Store
**费用**：$19 一次性
**网址**：https://partner.microsoft.com/

**好处**：
- 提升可信度，减少 SmartScreen 警告
- 自动更新
- 更大曝光

**步骤**：
1. 注册 Microsoft Partner Center 账号
2. 支付 $19 注册费
3. 使用 MSIX 打包
4. 提交审核

---

### 12. Mac App Store
**费用**：$99/年
**网址**：https://developer.apple.com/

**注意**：
- 需要苹果开发者账号
- 应用需要沙盒化，可能需要改代码
- 审核严格

**建议**：优先级较低，暂时不做

---

## 第五阶段：中国平台

### 13. 小众软件投稿 ⭐⭐
**费用**：免费
**网址**：https://meta.appinn.net/

**步骤**：
1. 在论坛发帖介绍软件
2. 或发邮件到 hi@appinn.com

---

### 14. 异次元软件投稿 ⭐
**费用**：免费
**网址**：https://www.iplaysoft.com/

**步骤**：
1. 发邮件投稿

---

## 执行清单

### 本周必做
- [ ] 提交 Homebrew Cask PR
- [ ] 提交 Winget PR
- [ ] 注册 SourceForge 并上传
- [ ] 添加到 AlternativeTo

### 下周完成
- [ ] 提交 Scoop PR
- [ ] 注册 Chocolatey 并提交
- [ ] 提交 Softpedia
- [ ] 投稿小众软件

### 有时间再做
- [ ] Flathub
- [ ] Snap Store
- [ ] Microsoft Store ($19)

---

## 版本更新流程

每次发布新版本时：

1. **更新 manifests 文件**
   - 修改版本号
   - 更新 SHA256 哈希值
   - 更新下载链接

2. **提交更新 PR**
   - Homebrew: `brew bump-cask-pr solomd --version 0.1.9`
   - Winget: `wingetcreate update zhitongblog.SoloMD --version 0.1.9`
   - Scoop: 手动更新 JSON

3. **更新软件下载站**
   - SourceForge: 上传新文件
   - 其他站点自动抓取或等待编辑更新

---

## 联系信息

**软件名称**：SoloMD
**版本**：0.1.8
**官网**：https://solomd.app
**GitHub**：https://github.com/zhitongblog/solomd
**作者**：xiangdong li
**邮箱**：[填写]
**协议**：MIT
