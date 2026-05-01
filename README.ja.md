# SoloMD

> Markdown エディタであり、LLM への橋でもある。

[![Latest Release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)

🌐 **[English README →](README.md) · [中文 README →](README.zh.md)**

[**ダウンロード**](https://github.com/zhitongblog/solomd/releases/latest) · [**公式サイト**](https://solomd.app) · [**FAQ**](https://solomd.app#faq)

![SoloMD エディタ](web/public/demo/solomd-demo.svg)

あなたのメモはひとつのフォルダ。**SoloMD は、その上で動くエディタであり、Claude Code / Codex CLI / Cursor が直接呼び出せる MCP エンドポイントでもあります。** 同じ `.md` ファイルに、二つの入り口。

Tauri 2 + Vue 3 + CodeMirror 6 で構築。Mac universal dmg は約 32 MB。無料 / MIT / サブスクなし / SoloMD サーバー無し。メモも、AI キーも、埋め込みインデックスも、git 履歴も、すべてあなたのマシンに残ります。

## ひとつの製品の二つの面

**エディタ。** WYSIWYG ライブ編集（Typora 風）、タブ + 分割、KaTeX + Mermaid、画像を `_assets/` に貼り付け、プレゼンモード（`⌘⌥P`）、Vim モード、Hunspell + 中国語校正、セマンティック検索（`⌘⇧F`）、wikilink + バックリンク、Pandoc エクスポート。CJK エンコーディング（GBK / Big5 / Shift-JIS）の自動判別。

**エンドポイント。** 同梱の `solomd-mcp` バイナリが、同じ vault を任意の MCP クライアントに公開します — 13 個のツール（うち 5 個は SoloMD 独自：`autogit_log`、`autogit_diff`、`autogit_rollback`、`sync_status`、`share_url`）。さらに `solomd agent <prompt>` の CLI で、Claude Code / Codex CLI に MCP 接続済みのタスクをそのまま渡せます。

## v4.0：「Agent ネイティブ」執筆環境

外部 CLI ハンドオフではなく、**エディタの中で agent が動く** 設計です：

- **インライン Agent パネル** — 右サイドに agent との会話。引用が `[[note]]` リンクになります。
- **Recipes（定時 / 保存時 / コミット時 / タグ付け時）** — `.solomd/agents/*.yml` の宣言で、夜間バッチ的に動かせます。書き込みは AutoGit ブランチ上に隔離 → 受理 / 却下を UI で確認。
- **トレースビュー** — すべての run を `trace.jsonl` で完全可視化、ステップから replay も可能。
- **ワークスペース連邦** — `solomd-mcp --workspace … --workspace …` で複数 vault を一つの MCP セッションに。
- **Ollama ファーストクラス連携** — 自動検出、おすすめモデル `qwen2.5:1.5b` のワンクリック取得、ローカル LLM のための 3 プリセット。
- **公開 REST API** — Alfred / Raycast / n8n / シェルから、MCP を話さなくても同じ vault 操作が可能。
- **BYOK コストメーター** — provider ごとに累計トークン / コストを記録（オプトイン）。

詳細は `docs/agents.md`（Recipe を書くためのガイド）と `docs/roadmap.md` を参照してください。

## ライセンス

MIT。詳細は `LICENSE`。

---

このリポジトリの英語版 README に、機能一覧、対応プラットフォーム、ビルド手順などすべてが揃っています。日本語版はその要約として用意されています。
