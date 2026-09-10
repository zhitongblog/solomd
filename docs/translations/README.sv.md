# SoloMD

> Editorn där agenter bor.

[![Latest release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/zhitongblog/solomd/total)](https://github.com/zhitongblog/solomd/releases)
[![Website](https://img.shields.io/badge/website-solomd.app-ff9f40.svg)](https://solomd.app)

🌐 **[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Nederlands](README.nl.md) · [Türkçe](README.tr.md) · [Українська](README.uk.md)**

[**Ladda ner v4.0**](https://github.com/zhitongblog/solomd/releases/latest) · [**Lanseringsinlägg**](https://solomd.app/blog/v4-0-0-agent-native-author/) · [**Webbplats**](https://solomd.app) · [**Säkerhet**](https://solomd.app/security)

![SoloMD Editor](web/public/demo/solomd-demo.svg)

Dina anteckningar bor i en mapp. **SoloMD är editorn ovanpå — med en förstklassig agent-yta i editorn och MCP-slutpunkten som Claude Code / Cursor kan styra utifrån.** Samma `.md`-filer. Chatta med ditt valv. Schemalägg recipes som körs när du inte sitter vid tangentbordet. Lämna över samma valv till vilken MCP-klient som helst.

Byggd på Tauri 2 + Vue 3 + CodeMirror 6. Universell macOS-dmg ~32 MB. Gratis, MIT, ingen prenumeration, inga SoloMD-värdade servrar. Dina anteckningar, AI-nycklar, embeddings-index och Git-historik stannar alla på din maskin.

## Tre halvor av en produkt

**Editorn.** WYSIWYG live-redigering (Typora-stil), flikar + delade rutor, KaTeX + Mermaid, klistra in bilder i `_assets/`, bildspelsläge (`⌘⌥P`), Vim-läge, Hunspell + CJK-stavningskontroll, semantisk sökning (`⌘⇧F`), wikilänkar + bakåtlänkar, Pandoc-export. CJK-kodningar (GBK / Big5 / Shift-JIS) detekteras automatiskt.

**Slutpunkten.** En medföljande `solomd-mcp`-binär exponerar samma valv för vilken MCP-klient som helst — 13 verktyg som standard, inklusive 5 SoloMD-egna (`autogit_log`, `autogit_diff`, `autogit_rollback`, `sync_status`, `share_url`) som ingen annan Markdown-server har. v4.0 lägger till `--workspace path1 --workspace path2`-federation — en MCP-session, många valv. Plus en `solomd agent <prompt>`-CLI som lämnar över till Claude Code / Codex CLI med förkopplad MCP.

**Agent-ytan (v4.0).** Agentpanel till höger: streamad chat-with-vault, `[[wikilink]]`-citat, verktygsanropskort inline, **Infoga** / **Kopiera**-knappar låter svaret falla in i den aktiva anteckningen. Plus deklarativa **recipes** som YAML i `<workspace>/.solomd/agents/*.yml` — `cron` / `on-save` / `on-commit` / `on-tag-add` / manuella triggers. **Varje agentskrivning landar på sin egen AutoGit-gren som du accepterar eller avvisar** innan den rör `main`; standard write-cap 5; vägrar starta om arbetsträdet är dirty; återspelbar `trace.jsonl` per körning med `read_agent_trace`-MCP-verktyg.

| Funktion | |
|---|---|
| **Agentpanel** *(v4.0)* | Streamad chat-with-vault på samma nivå som Outline / Backlinks / Tags / History. Verktygsanropskort fälls ut inline; svar Infoga / Kopiera till aktiv editor; körningslogg bevarad som ren Markdown under `.solomd/agent-runs/`. |
| **Schemalagda recipes** *(v4.0)* | YAML-jobb i ditt valv. AutoGit-grensandbox + accept/reject-UI före merge. Write-cap per körning (standard 5, max 50). Receptbok med 11 recipes i trädet. |
| **Återspelbar trace** *(v4.0)* | `trace.jsonl` per steg (`prompt` / `model_call` / `tool_call` / `tool_result` / `git_commit`). Replay-from-step spolar tillbaka och kör om. |
| **Workspace-federation** *(v4.0)* | `solomd-mcp --workspace path1 --workspace path2`. En Claude Desktop-session, många valv. MCP-profil-UI i Inställningar → Integrationer. |
| **Ollama förstklassig** *(v4.0)* | Auto-detektering på `localhost:11434`. Tre modell-presets (`qwen2.5:1.5b/7b/14b`). `provider: local` recipe-alias för molnfria autonoma loopar. |
| **AI-omskrivning, BYOK** | 14 leverantörer — OpenAI · Claude · Gemini · DeepSeek · Qwen · GLM · Kimi · Doubao · SiliconFlow · OpenRouter · Mistral · Groq · xAI · Ollama. Direkta leverantörsanrop. Nycklar i OS-keychain. |
| **GitHub-backad sync** | Pusha ditt valv till ett privat GitHub-repo vid varje sparning. Valfri E2EE (Argon2id + XChaCha20-Poly1305). GitLab / Gitea / vilken HTTPS-git-URL som helst fungerar också. |
| **AutoGit per anteckning** | Varje `⌘S` är en commit i en lokal `.git` i workspacen. libgit2 medföljer, ingen system-git behövs. Pushas aldrig automatiskt. |
| **MCP-server medföljer** | `solomd-mcp` ingår i installationen. 13 verktyg (8 generiska + 5 SoloMD-egna). Endast stdio, ingen nätverksport. Skrivskyddad som standard; `--allow-write` opt-in. |
| **REST API** *(v4.0)* | Endast localhost, token-auth. Samma yta som MCP för klienter som ännu inte talar MCP — Alfred / Raycast / n8n / egna skript. |
| **BYOK-kostnadsmätare** *(v4.0)* | Löpande tokenanvändningsräknare per leverantör, opt-in. Inställningar → Integrationer. |
| **Molnmappläge** | Om ditt valv ligger i `~/Library/Mobile Documents/...` eller `~/Dropbox/...` upptäcker SoloMD det och lägger till sessionsåterställning mellan enheter — OS:et sköter redan filsynkningen. |
| **Publik skrivskyddad delning** | Kommandopalett → kopiera en `solomd.app/share/?repo=...&path=...`-länk. Renderar vilken fil som helst i ditt publika GitHub-repo, inget SoloMD-konto behövs för att visa. |

## Användning

Efter att du installerat SoloMD på macOS / Linux:

**1. Chatta med ditt valv.** Öppna agentpanelen till höger (⌘⇧P → "View: Toggle Agent Panel" om dold). Streamad multi-turn mot dina anteckningar; verktygsanropskort visar varje läs/skriv inline. Svar för långt? **Infoga** låter det falla in i den aktiva anteckningen vid markörens position (ersätter markering); **Kopiera** till urklipp.

**2. Schemalägg en recipe.** Inställningar → Recipes → bläddra i receptboken. 11 starters klara: veckosammanfattning, daglig sammanfattning, TODO-extraktion, översättningspass, citationsstädning, CJK-stavningsagent, link rot-detektor, frontmatter-normaliserare, outline-till-blogg, refactor-pass, veckovis taggtriage. Installera en, redigera prompten, kör.

**3. Styr samma valv från en annan LLM-klient.** I ett svep:

```bash
# Skriv ut MCP-konfigurationssnutt för din AI-klient.
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

Klistra in i Claude Desktop / Cursor / etc. För multi-valv-federation, upprepa `--workspace`:

```json
"args": [
  "--workspace", "/Users/me/Documents/SoloMD",
  "--workspace", "/Users/me/Documents/work-notes"
]
```

**4. Eller lämna över en prompt direkt till claude / codex CLI:**

```bash
solomd agent "skriv om denna veckas dagliga anteckningar till en veckosammanfattning och commita den"
```

Path traversal-skyddad. Ingen nätverksport. LLM:et ser bara det du pekar workspacen mot.

## Installation

Senaste release: [**v4.0.0**](https://github.com/zhitongblog/solomd/releases/latest).

### macOS — Universell dmg (Apple Silicon + Intel, signerad + notariserad)

```bash
brew install --cask zhitongblog/solomd/solomd
```

Eller ladda ner dmg direkt:

```
https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_universal.dmg
```

Eller en-rads shell-installation:

```bash
curl -fsSL https://solomd.app/install.sh | bash
```

### Windows — x64

- [`SoloMD_4.0.0_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64_en-US.msi)
- [`SoloMD_4.0.0_x64-setup.exe`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-setup.exe) (NSIS)
- [`SoloMD_4.0.0_x64-portable.zip`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-portable.zip) — ingen installer

```powershell
irm https://solomd.app/install.ps1 | iex
```

```powershell
winget install solomd
```

### Linux — x86_64 + aarch64

- `.AppImage` (universell), `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL) — båda arkitekturerna från [releases-sidan](https://github.com/zhitongblog/solomd/releases/latest).
- Arch-användare: [`solomd-bin`](https://aur.archlinux.org/packages/solomd-bin) på AUR.

### iPad

[App Store](https://apps.apple.com/app/solomd/id6762498874) — samma motor, native iPad-UI.

## Sekretess och säkerhet

Rent klientsidigt. Dina `.md`-filer stannar i mappen du valde. API-nycklar bor i OS-keychain (macOS Keychain / Windows Credential Manager / Linux libsecret), aldrig i `localStorage` eller en konfigurationsfil. AI-förfrågningar går direkt från din maskin till den valda leverantören — inget SoloMD-relä. RAG-embeddings och AutoGit-repot är endast lokala. MCP-servern talar stdio, öppnar aldrig en nätverksport. Hela kodbasen är MIT och granskningsbar.

**Agentsäkerhetsräcken (v4.0).** Varje recipe-körning startar på sin egen AutoGit-gren — din `main` förblir orörd tills du klickar Acceptera på diffen. Write-cap per körning (standard 5, hård max 50) förhindrar löpta loopar. Recipe-runnern vägrar starta om arbetsträdet är dirty (ingen agent-commit kommer att sopa upp ditt WIP). Path traversal-skydd avvisar `..`-segment och absoluta sökvägar i förväg i varje Tauri / MCP / REST-slutpunkt som accepterar en användartillhandahållen sökväg.

E2EE-sync använder Argon2id (RFC9106 standardparametrar) → XChaCha20-Poly1305 med deterministiska nonces och sökväg-som-AAD. Klartext stannar på dina enheter; remote ser bara chiffertext. Misslyckad `sync.json`-parsning är fail-closed — vägrar pusha istället för att degradera till klartext (en v3.0.x revisionsfix).

Fullständig genomgång: <https://solomd.app/security>.

## Bygga från källa

Förkrav: Rust (stable), Node 18+, pnpm.

```bash
git clone https://github.com/zhitongblog/solomd.git
cd solomd/app
pnpm install
pnpm tauri dev      # dev med hot reload
pnpm tauri build    # release-artefakter → src-tauri/target/release/bundle/
```

Linux behöver dessutom `libdbus-1-dev` för keychain-backenden.

MCP-servern är en separat crate under `mcp-server/`; dev-MCP-harnesset för end-to-end-tester bor under `dev-mcp/`. Ingångspunkt för end-to-end-tester: `scripts/v4-self-test.sh` (kör med `--with-release --with-ollama --with-ui` för full täckning).

## Bidra

Issues och PR:s välkomna — [öppna ett](https://github.com/zhitongblog/solomd/issues). För en känsla av riktningen, se [`docs/roadmap.md`](docs/roadmap.md). v4.0-byggloggen finns på [solomd.app/blog/v4-0-0-how-we-built-it/](https://solomd.app/blog/v4-0-0-how-we-built-it/) — börja där om du vill förstå ingenjörsprinciperna innan du skickar en PR.

## Kontakt

En underhållare, två ytterdörrar. Asynkront på [GitHub Discussions](https://github.com/zhitongblog/solomd/discussions). Realtidschatt:

- **Telegram (internationellt):** [@SOLOMDAPP](https://t.me/SOLOMDAPP) — release-aviseringar + chatt
- **WeChat (中文):** skanna för att lägga till mig — notera "SoloMD"

## Licens och credits

[MIT](LICENSE) © 2026 xiangdong li. SoloMD står på Tauri 2, Vue 3, CodeMirror 6, markdown-it, KaTeX, Mermaid, libgit2, Pandoc, Hunspell, `keyring-rs` och `rmcp`. Sponsra via [GitHub Sponsors](https://github.com/sponsors/zhitongblog) eller [solomd.app/#sponsor](https://solomd.app/#sponsor).
