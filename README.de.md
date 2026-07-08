# SoloMD

> Der Editor, in dem Agents leben.

[![Latest release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/zhitongblog/solomd/total)](https://github.com/zhitongblog/solomd/releases)
[![Website](https://img.shields.io/badge/website-solomd.app-ff9f40.svg)](https://solomd.app)

🌐 **[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Nederlands](README.nl.md) · [Türkçe](README.tr.md) · [Svenska](README.sv.md) · [Українська](README.uk.md)**

[**v4.0 herunterladen**](https://github.com/zhitongblog/solomd/releases/latest) · [**Launch-Beitrag**](https://solomd.app/blog/v4-0-0-agent-native-author/) · [**Webseite**](https://solomd.app) · [**Sicherheit**](https://solomd.app/security)

![SoloMD Editor](web/public/demo/solomd-demo.svg)

Ihre Notizen leben in einem Ordner. **SoloMD ist der Editor darüber — mit einer erstklassigen Agent-Oberfläche im Editor und dem MCP-Endpunkt, den Claude Code / Cursor von außen ansteuern können.** Dieselben `.md`-Dateien. Mit Ihrem Vault chatten. Recipes planen, die laufen, wenn Sie nicht an der Tastatur sind. Denselben Vault an jeden MCP-Client übergeben.

Gebaut auf Tauri 2 + Vue 3 + CodeMirror 6. Universal macOS dmg ~32 MB. Kostenlos, MIT, kein Abonnement, keine SoloMD-gehosteten Server. Ihre Notizen, AI-Schlüssel, Embeddings-Index und Git-Verlauf bleiben alle auf Ihrer Maschine.

## Drei Hälften eines Produkts

**Der Editor.** WYSIWYG-Live-Bearbeitung (Typora-Stil), Tabs + geteilte Bereiche, KaTeX + Mermaid, Bild-Einfügen in `_assets/`, Slideshow-Modus (`⌘⌥P`), Vim-Modus, Hunspell + CJK-Korrektur, semantische Suche (`⌘⇧F`), Wikilinks + Backlinks, Pandoc-Export. CJK-Kodierungen (GBK / Big5 / Shift-JIS) automatisch erkannt.

**Der Endpunkt.** Eine gebündelte `solomd-mcp`-Binary stellt denselben Vault jedem MCP-Client zur Verfügung — 13 Tools standardmäßig, einschließlich 5 SoloMD-eigene (`autogit_log`, `autogit_diff`, `autogit_rollback`, `sync_status`, `share_url`), die kein anderer Markdown-Server hat. v4.0 fügt `--workspace path1 --workspace path2` Federation hinzu — eine MCP-Sitzung, viele Vaults. Plus ein `solomd agent <prompt>` CLI, das an Claude Code / Codex CLI mit vorverdrahtetem MCP übergibt.

**Die Agent-Oberfläche (v4.0).** Rechtsseitiges Agent-Panel: gestreamtes chat-with-vault, `[[wikilink]]`-Zitate, Tool-Call-Karten inline, **Einfügen** / **Kopieren**-Schaltflächen lassen die Antwort in die aktive Notiz fallen. Plus deklarative **Recipes** als YAML in `<workspace>/.solomd/agents/*.yml` — `cron` / `on-save` / `on-commit` / `on-tag-add` / manuelle Auslöser. **Jede Agent-Schreibaktion landet auf einem eigenen AutoGit-Branch, den Sie akzeptieren oder ablehnen** bevor er `main` berührt; write-cap Standard 5; verweigert den Start, wenn der Arbeitsbaum dirty ist; wiederholbarer `trace.jsonl` pro Lauf mit `read_agent_trace`-MCP-Tool.

| Funktion | |
|---|---|
| **Agent-Panel** *(v4.0)* | Gestreamtes chat-with-vault auf gleicher Ebene wie Outline / Backlinks / Tags / History. Tool-Call-Karten klappen inline auf; Antwort Insert / Copy in den aktiven Editor; Lauf-Verlauf bleibt als reines Markdown unter `.solomd/agent-runs/` erhalten. |
| **Geplante Recipes** *(v4.0)* | YAML-Jobs in Ihrem Vault. AutoGit-Branch-Sandbox + accept/reject-UI vor Merge. Pro Lauf write-cap (Standard 5, Maximum 50). 11-Recipe-Kochbuch im Tree. |
| **Wiederholbarer Trace** *(v4.0)* | `trace.jsonl` pro Schritt (`prompt` / `model_call` / `tool_call` / `tool_result` / `git_commit`). Replay-from-step spult zurück und führt erneut aus. |
| **Workspace-Federation** *(v4.0)* | `solomd-mcp --workspace path1 --workspace path2`. Eine Claude-Desktop-Sitzung, viele Vaults. MCP-Profil-UI in Einstellungen → Integrationen. |
| **Ollama erstklassig** *(v4.0)* | Auto-Erkennung unter `localhost:11434`. Drei Modell-Presets (`qwen2.5:1.5b/7b/14b`). `provider: local` Recipe-Alias für Cloud-kostenfreie autonome Schleifen. |
| **AI-Umschreibung, BYOK** | 14 Provider — OpenAI · Claude · Gemini · DeepSeek · Qwen · GLM · Kimi · Doubao · SiliconFlow · OpenRouter · Mistral · Groq · xAI · Ollama. Direkte Vendor-Aufrufe. Schlüssel im OS-Schlüsselbund. |
| **GitHub-gestützte Sync** | Vault zu privatem GitHub-Repo bei jedem Speichern pushen. Optionale E2EE (Argon2id + XChaCha20-Poly1305). GitLab / Gitea / jede HTTPS-git-URL funktioniert auch. |
| **AutoGit pro Notiz** | Jedes `⌘S` ist ein Commit in einem lokalen `.git` im Workspace. libgit2 mitgeliefert, kein System-git nötig. Nie automatisch gepusht. |
| **MCP-Server gebündelt** | `solomd-mcp` ist in der Installation enthalten. 13 Tools (8 generisch + 5 SoloMD-eigene). Nur stdio, kein Netzwerkport. Standardmäßig Nur-Lese; `--allow-write` Opt-in. |
| **REST-API** *(v4.0)* | Localhost only, Token-Auth. Gleiche Oberfläche wie MCP für Clients, die noch kein MCP sprechen — Alfred / Raycast / n8n / eigene Skripte. |
| **BYOK-Kostenmesser** *(v4.0)* | Pro-Provider laufender Token-Verbrauchszähler, Opt-in. Einstellungen → Integrationen. |
| **Cloud-Ordner-Modus** | Wenn Ihr Vault in `~/Library/Mobile Documents/...` oder `~/Dropbox/...` liegt, erkennt SoloMD das und fügt geräteübergreifende Sitzungswiederherstellung hinzu — das OS macht bereits die Datei-Sync. |
| **Öffentliches Nur-Lese-Sharing** | Befehlspalette → `solomd.app/share/?repo=...&path=...`-Link kopieren. Rendert jede Datei in Ihrem öffentlichen GitHub-Repo, kein SoloMD-Konto zum Ansehen nötig. |

## Verwendung

Nach Installation von SoloMD auf macOS / Linux:

**1. Mit Ihrem Vault chatten.** Rechtsseitiges Agent-Panel öffnen (⌘⇧P → "View: Toggle Agent Panel" wenn versteckt). Gestreamtes Multi-Turn gegen Ihre Notizen; Tool-Call-Karten zeigen jeden Lese-/Schreibvorgang inline. Antwort zu lang? **Einfügen** lässt sie an der Cursor-Position in die aktive Notiz fallen (ersetzt Auswahl); **Kopieren** in die Zwischenablage.

**2. Ein Recipe planen.** Einstellungen → Recipes → Kochbuch durchsuchen. 11 Starter bereit: Wochenrückblick, tägliche Zusammenfassung, TODO-Extraktion, Übersetzungsdurchgang, Zitatsbereinigung, CJK-Korrektur-Agent, Link-Verfall-Detektor, Frontmatter-Normalisierer, Outline-zu-Blog, Refactor-Durchgang, wöchentliche Tag-Triage. Eines installieren, Prompt bearbeiten, ausführen.

**3. Denselben Vault von einem anderen LLM-Client ansteuern.** One-Shot:

```bash
# MCP-Konfigurations-Snippet für Ihren AI-Client ausgeben.
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

In Claude Desktop / Cursor / etc. einfügen. Für Multi-Vault-Federation `--workspace` wiederholen:

```json
"args": [
  "--workspace", "/Users/me/Documents/SoloMD",
  "--workspace", "/Users/me/Documents/work-notes"
]
```

**4. Oder einen Prompt direkt an claude / codex CLI übergeben:**

```bash
solomd agent "schreibe diese Woche von Tagesnotizen in einen Wochenrückblick um und committe ihn"
```

Pfad-Traversal abgesichert. Kein Netzwerkport. Das LLM sieht nur, worauf Sie den Workspace zeigen.

## Installation

Neueste Version: [**v4.0.0**](https://github.com/zhitongblog/solomd/releases/latest).

### macOS — Universal dmg (Apple Silicon + Intel, signiert + notarisiert)

```bash
brew install --cask zhitongblog/solomd/solomd
```

Oder dmg direkt herunterladen:

```
https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_universal.dmg
```

Oder One-Liner-Shell-Installation:

```bash
curl -fsSL https://solomd.app/install.sh | bash
```

### Windows — x64

- [`SoloMD_4.0.0_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64_en-US.msi)
- [`SoloMD_4.0.0_x64-setup.exe`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-setup.exe) (NSIS)
- [`SoloMD_4.0.0_x64-portable.zip`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-portable.zip) — kein Installer

```powershell
irm https://solomd.app/install.ps1 | iex
```

```powershell
winget install solomd
```

### Linux — x86_64 + aarch64

- `.AppImage` (universell), `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL) — beide Architekturen von [der Releases-Seite](https://github.com/zhitongblog/solomd/releases/latest).
- Arch-Benutzer: [`solomd-bin`](https://aur.archlinux.org/packages/solomd-bin) auf AUR.

### iPad

[App Store](https://apps.apple.com/app/solomd/id6762498874) — gleiche Engine, native iPad-UI.

## Datenschutz & Sicherheit

Rein clientseitig. Ihre `.md`-Dateien bleiben im Ordner, den Sie gewählt haben. API-Schlüssel leben im OS-Schlüsselbund (macOS Keychain / Windows Credential Manager / Linux libsecret), niemals im `localStorage` oder einer Konfigurationsdatei. AI-Anfragen gehen direkt von Ihrer Maschine zum gewählten Provider — kein SoloMD-Relay. RAG-Embeddings und das AutoGit-Repo sind nur lokal. Der MCP-Server spricht stdio, öffnet niemals einen Netzwerkport. Die gesamte Codebasis ist MIT und prüfbar.

**Agent-Sicherheitsleitplanken (v4.0).** Jeder Recipe-Lauf startet auf einem eigenen AutoGit-Branch — Ihr `main` bleibt unberührt, bis Sie auf dem Diff Akzeptieren klicken. Pro Lauf write-cap (Standard 5, hartes Maximum 50) verhindert ausser Kontrolle geratene Schleifen. Recipe-Runner verweigert den Start, wenn der Arbeitsbaum dirty ist (kein Agent-Commit wird Ihre WIP einsammeln). Pfad-Traversal-Wächter weisen `..`-Segmente und absolute Pfade vorab in jedem Tauri-/MCP-/REST-Endpunkt zurück, der einen vom Benutzer gelieferten Pfad annimmt.

E2EE-Sync verwendet Argon2id (RFC9106-Standardparameter) → XChaCha20-Poly1305 mit deterministischen Nonces und Pfad-als-AAD. Klartext bleibt auf Ihren Geräten; das Remote sieht nur Chiffretext. Fehlgeschlagenes `sync.json`-Parsing ist fail-closed — verweigert Push, anstatt zu Klartext zu degradieren (ein v3.0.x-Audit-Fix).

Vollständiges Writeup: <https://solomd.app/security>.

## Aus Quellen bauen

Voraussetzungen: Rust (stable), Node 18+, pnpm.

```bash
git clone https://github.com/zhitongblog/solomd.git
cd solomd/app
pnpm install
pnpm tauri dev      # dev mit Hot Reload
pnpm tauri build    # Release-Artefakte → src-tauri/target/release/bundle/
```

Linux benötigt zusätzlich `libdbus-1-dev` für das Schlüsselbund-Backend.

Der MCP-Server ist eine separate Crate unter `mcp-server/`; das Dev-MCP-Harness für End-to-End-Tests lebt unter `dev-mcp/`. End-to-End-Test-Einstiegspunkt: `scripts/v4-self-test.sh` (mit `--with-release --with-ollama --with-ui` für volle Abdeckung ausführen).

## Beitragen

Issues und PRs willkommen — [eines öffnen](https://github.com/zhitongblog/solomd/issues). Für ein Gefühl der Richtung siehe [`docs/roadmap.md`](docs/roadmap.md). Das v4.0-Build-Log ist unter [solomd.app/blog/v4-0-0-how-we-built-it/](https://solomd.app/blog/v4-0-0-how-we-built-it/) — dort beginnen, wenn Sie die Engineering-Prinzipien verstehen wollen, bevor Sie einen PR senden.

## Kontakt

Ein Maintainer, zwei Eingangstüren. Asynchron auf [GitHub Discussions](https://github.com/zhitongblog/solomd/discussions). Echtzeit-Chat:

- **Telegram (international):** [@SOLOMDAPP](https://t.me/SOLOMDAPP) — Release-Ankündigungen + Chat
- **WeChat (中文):** Scannen, um mich hinzuzufügen — Notiz "SoloMD"

## Lizenz & Credits

[MIT](LICENSE) © 2026 xiangdong li. SoloMD steht auf Tauri 2, Vue 3, CodeMirror 6, markdown-it, KaTeX, Mermaid, libgit2, Pandoc, Hunspell, `keyring-rs` und `rmcp`. Sponsoren auf [GitHub Sponsors](https://github.com/sponsors/zhitongblog) oder über [solomd.app/#sponsor](https://solomd.app/#sponsor).
