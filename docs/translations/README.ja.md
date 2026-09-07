# SoloMD

> Agent が住みつくエディタ。

[![Latest release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/zhitongblog/solomd/total)](https://github.com/zhitongblog/solomd/releases)
[![Website](https://img.shields.io/badge/website-solomd.app-ff9f40.svg)](https://solomd.app)

🌐 **[English](README.md) · [中文](README.zh.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Nederlands](README.nl.md) · [Türkçe](README.tr.md) · [Svenska](README.sv.md) · [Українська](README.uk.md)**

[**v4.0 をダウンロード**](https://github.com/zhitongblog/solomd/releases/latest) · [**ローンチ記事**](https://solomd.app/ja/blog/) · [**ウェブサイト**](https://solomd.app/ja/) · [**セキュリティ**](https://solomd.app/ja/security/)

![SoloMD エディタ](web/public/demo/solomd-demo.svg)

あなたのメモはひとつのフォルダ。**SoloMD はその上のエディタ — エディタ内に一等公民の Agent サーフェス、外部からは Claude Code / Cursor が呼び出せる MCP エンドポイント。** 同じ `.md` ファイル。vault と対話。キーボード前にいない時に走る Recipe。同じ vault を任意の MCP クライアントに渡せる。

Tauri 2 + Vue 3 + CodeMirror 6 で構築。Mac universal dmg は約 32 MB。無料、MIT、サブスクなし、SoloMD ホストのサーバーなし。メモも、AI キーも、埋め込みインデックスも、git 履歴もすべてあなたのマシンに残ります。

## ひとつの製品の 3 つの半分

**エディタ。** WYSIWYG ライブ編集（Typora 風）、タブ + 分割ペイン、KaTeX + Mermaid、画像を `_assets/` に貼り付け、スライドショーモード（`⌘⌥P`）、Vim モード、Hunspell + CJK 校正、セマンティック検索（`⌘⇧F`）、wikilinks + backlinks、Pandoc エクスポート。CJK エンコーディング（GBK / Big5 / Shift-JIS）の自動判別。

**エンドポイント。** 同梱の `solomd-mcp` バイナリが同じ vault を任意の MCP クライアントに公開 — 標準で 13 ツール、うち 5 個は SoloMD 独自（`autogit_log`、`autogit_diff`、`autogit_rollback`、`sync_status`、`share_url`）で他の markdown サーバーにはない。v4.0 では `--workspace path1 --workspace path2` の federation を追加 — 1 つの MCP セッションで複数 vault。さらに `solomd agent <prompt>` CLI で Claude Code / Codex CLI に MCP 接続済みでハンドオフ。

**Agent サーフェス（v4.0）。** 右サイド Agent パネル: ストリーミング chat-with-vault、`[[wikilink]]` 引用、ツール呼び出しカードがインラインで展開、**挿入** / **コピー** ボタンで返信を現在のノートに反映。さらに `<workspace>/.solomd/agents/*.yml` の YAML として宣言的 **Recipe** — `cron` / `on-save` / `on-commit` / `on-tag-add` / 手動トリガー。**各 agent 書き込みは専用 AutoGit ブランチに着地**、accept / reject してから `main` に触れます; write-cap デフォルト 5; ワーキングツリーが汚れている時は実行拒否; 各実行で `trace.jsonl` リプレイ可能、`read_agent_trace` MCP ツール付き。

| 機能 | |
|---|---|
| **Agent パネル** *(v4.0)* | Outline / Backlinks / Tags / History と同列の chat-with-vault ストリーミング。ツールカードがインライン展開; 返信を Insert / Copy で現在のエディタへ; 実行履歴は `.solomd/agent-runs/` にプレーン markdown で保存。 |
| **定時 Recipe** *(v4.0)* | vault 内の YAML ジョブ。AutoGit ブランチサンドボックス + accept/reject UI でマージ前審査。実行ごとの write-cap（デフォルト 5、ハード上限 50）。11 Recipe クックブックを同梱。 |
| **リプレイ可能な trace** *(v4.0)* | ステップごとの `trace.jsonl`（`prompt` / `model_call` / `tool_call` / `tool_result` / `git_commit`）。ステップから再生で巻き戻して再実行。 |
| **Workspace federation** *(v4.0)* | `solomd-mcp --workspace path1 --workspace path2`。1 Claude Desktop セッションで複数 vault。設定 → 統合に MCP プロファイル UI。 |
| **Ollama 一等公民** *(v4.0)* | `localhost:11434` を自動検出。3 つのモデルプリセット（`qwen2.5:1.5b/7b/14b`）。`provider: local` Recipe エイリアスでクラウド料金ゼロの自動ループ。 |
| **AI 書き換え、BYOK** | 14 Provider — OpenAI · Claude · Gemini · DeepSeek · Qwen · GLM · Kimi · Doubao · SiliconFlow · OpenRouter · Mistral · Groq · xAI · Ollama。ベンダー直接コール。キーは OS キーチェーンに。 |
| **GitHub バックの同期** | vault を保存ごとにプライベート GitHub リポジトリに push。任意の E2EE（Argon2id + XChaCha20-Poly1305）。GitLab / Gitea / 任意 HTTPS git URL も動作。 |
| **AutoGit per ノート** | 各 `⌘S` がワークスペース内ローカル `.git` のコミット。libgit2 同梱、システム git 不要。自動 push なし。 |
| **MCP サーバー同梱** | `solomd-mcp` がインストールに同梱。13 ツール（汎用 8 + SoloMD 独自 5）。stdio のみ、ネットワークポートなし。デフォルト読み取り専用; `--allow-write` でオプトイン。 |
| **REST API** *(v4.0)* | localhost のみ、トークン認証。MCP と同じサーフェス、まだ MCP を話さないクライアント向け — Alfred / Raycast / n8n / 自作スクリプト。 |
| **BYOK コストメーター** *(v4.0)* | Provider ごとの累積トークン使用量カウンター、オプトイン。設定 → 統合。 |
| **クラウドフォルダモード** | vault が `~/Library/Mobile Documents/...` や `~/Dropbox/...` 配下なら、SoloMD が検出してクロスデバイスのセッション復元を追加 — ファイル同期は OS が既に行います。 |
| **公開読み取り専用シェア** | コマンドパレット → `solomd.app/share/?repo=...&path=...` リンクをコピー。公開 GitHub リポジトリのファイルをレンダリング、SoloMD アカウント不要。 |

## 使い方

macOS / Linux に SoloMD をインストール後:

**1. vault と対話。** 右サイドの Agent パネルを開く（隠れていれば ⌘⇧P → 「View: Toggle Agent Panel」）。ノートに対するストリーミングのマルチターン; ツールカードが各読み書きをインライン表示。返信が長すぎる？ **挿入** で現在のノートのカーソル位置に（選択範囲があれば置換）; **コピー** でクリップボードへ。

**2. Recipe をスケジュール。** 設定 → Recipes → クックブック閲覧。11 のスターター: 週次レビュー、日次サマリー、TODO 抽出、翻訳パス、引用清理、CJK 校正 agent、リンク腐敗検出、frontmatter 正規化、アウトライン → ブログ、リファクタパス、週次タグトリアージ。1 つインストール、prompt 編集、実行。

**3. 同じ vault を別の LLM クライアントから操作。** ワンショット:

```bash
# AI クライアント用の MCP 設定スニペットを表示。
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

Claude Desktop / Cursor 等に貼り付け。複数 vault federation には `--workspace` を繰り返し:

```json
"args": [
  "--workspace", "/Users/me/Documents/SoloMD",
  "--workspace", "/Users/me/Documents/work-notes"
]
```

**4. または claude / codex CLI に直接 prompt を渡す:**

```bash
solomd agent "今週の日報を週次レビューに書き直してコミットして"
```

パストラバーサル ガード済み。ネットワークポートなし。LLM はワークスペースで指定したものしか見えません。

## インストール

最新リリース: [**v4.0.0**](https://github.com/zhitongblog/solomd/releases/latest).

### macOS — universal dmg（Apple Silicon + Intel、署名 + notarize 済み）

```bash
brew install --cask zhitongblog/solomd/solomd
```

または dmg を直接ダウンロード:

```
https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_universal.dmg
```

または 1 行シェルインストール:

```bash
curl -fsSL https://solomd.app/install.sh | bash
```

### Windows — x64

- [`SoloMD_4.0.0_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64_en-US.msi)
- [`SoloMD_4.0.0_x64-setup.exe`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-setup.exe) (NSIS)
- [`SoloMD_4.0.0_x64-portable.zip`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-portable.zip) — インストーラなし

```powershell
irm https://solomd.app/install.ps1 | iex
```

```powershell
winget install solomd
```

### Linux — x86_64 + aarch64

- `.AppImage`（ユニバーサル）、`.deb`（Debian/Ubuntu）、`.rpm`（Fedora/RHEL） — 両アーキテクチャを [リリースページ](https://github.com/zhitongblog/solomd/releases/latest) から。
- Arch ユーザー: AUR の [`solomd-bin`](https://aur.archlinux.org/packages/solomd-bin)。

### iPad

[App Store](https://apps.apple.com/app/solomd/id6762498874) — 同じエンジン、ネイティブ iPad UI。

## プライバシー & セキュリティ

純粋にクライアントサイド。`.md` ファイルは選んだフォルダに残ります。API キーは OS キーチェーン（macOS Keychain / Windows Credential Manager / Linux libsecret）に、`localStorage` や設定ファイルには絶対に書かれません。AI リクエストはあなたのマシンから選んだ Provider に直接 — SoloMD リレーなし。RAG 埋め込みと AutoGit リポジトリはローカルのみ。MCP サーバーは stdio で話し、ネットワークポートを開きません。コードベース全体は MIT で監査可能。

**Agent 安全レール（v4.0）。** 各 Recipe 実行は専用 AutoGit ブランチで開始 — diff で Accept をクリックするまで `main` は不変。実行ごとの write-cap（デフォルト 5、ハード上限 50）が暴走ループを防止。Recipe ランナーはワーキングツリーが汚れている時は実行拒否（agent コミットがあなたの WIP を巻き込みません）。パストラバーサル ガードは `..` セグメントと絶対パスを、ユーザー入力パスを受ける各 Tauri / MCP / REST エンドポイントで先頭から拒否。

E2EE 同期は Argon2id（RFC9106 デフォルトパラメータ） → XChaCha20-Poly1305、決定論的 nonce、パスを AAD として使用。平文はあなたのデバイスに残り、リモートには暗号文のみ。`sync.json` パース失敗は fail-closed — 平文降格よりも push 拒否（v3.0.x 監査での修正）。

詳細: <https://solomd.app/ja/security/>。

## ソースからビルド

前提: Rust（stable）、Node 18+、pnpm。

```bash
git clone https://github.com/zhitongblog/solomd.git
cd solomd/app
pnpm install
pnpm tauri dev      # ホットリロード付き dev
pnpm tauri build    # リリース成果物 → src-tauri/target/release/bundle/
```

Linux ではキーチェーンバックエンド用に `libdbus-1-dev` も必要。

MCP サーバーは `mcp-server/` の別 crate; エンドツーエンドテスト用の dev MCP harness は `dev-mcp/` に。エンドツーエンドテストエントリポイント: `scripts/v4-self-test.sh`（`--with-release --with-ollama --with-ui` で完全カバレッジ）。

## コントリビュート

Issue や PR を歓迎 — [開いてください](https://github.com/zhitongblog/solomd/issues)。方向性は [`docs/roadmap.md`](docs/roadmap.md) を参照。v4.0 のビルドログは [solomd.app/blog/v4-0-0-how-we-built-it/](https://solomd.app/blog/v4-0-0-how-we-built-it/) に — PR を送る前にエンジニアリング原則を理解したいならそこから。

## お問い合わせ

メンテナは 1 人、入り口は 2 つ。非同期は [GitHub Discussions](https://github.com/zhitongblog/solomd/discussions)。リアルタイムチャット:

- **Telegram（国際）:** [@SOLOMDAPP](https://t.me/SOLOMDAPP) — リリース告知 + チャット
- **WeChat（中文）:** スキャンで友達追加 — 「SoloMD」と書いてください

## ライセンス & クレジット

[MIT](LICENSE) © 2026 xiangdong li。SoloMD は Tauri 2、Vue 3、CodeMirror 6、markdown-it、KaTeX、Mermaid、libgit2、Pandoc、Hunspell、`keyring-rs`、`rmcp` の上に立っています。[GitHub Sponsors](https://github.com/sponsors/zhitongblog) または [solomd.app/#sponsor](https://solomd.app/#sponsor) で後援を。
