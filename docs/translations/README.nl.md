# SoloMD

> De editor waar agents wonen.

[![Latest release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/zhitongblog/solomd/total)](https://github.com/zhitongblog/solomd/releases)
[![Website](https://img.shields.io/badge/website-solomd.app-ff9f40.svg)](https://solomd.app)

🌐 **[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Türkçe](README.tr.md) · [Svenska](README.sv.md) · [Українська](README.uk.md)**

[**v4.0 downloaden**](https://github.com/zhitongblog/solomd/releases/latest) · [**Lanceringspost**](https://solomd.app/blog/v4-0-0-agent-native-author/) · [**Website**](https://solomd.app) · [**Beveiliging**](https://solomd.app/security)

![SoloMD Editor](web/public/demo/solomd-demo.svg)

Je notities leven in een map. **SoloMD is de editor erbovenop — met een eersteklas agent-oppervlak in de editor en het MCP-eindpunt dat Claude Code / Cursor van buitenaf kunnen aansturen.** Dezelfde `.md`-bestanden. Chat met je vault. Plan recipes die draaien wanneer je niet achter het toetsenbord zit. Geef dezelfde vault door aan elke MCP-client.

Gebouwd op Tauri 2 + Vue 3 + CodeMirror 6. Universele macOS dmg ~32 MB. Gratis, MIT, geen abonnement, geen door SoloMD gehoste servers. Je notities, AI-sleutels, embeddings-index en Git-geschiedenis blijven allemaal op je machine.

## Drie helften van één product

**De editor.** WYSIWYG live-bewerken (Typora-stijl), tabs + gesplitste panelen, KaTeX + Mermaid, afbeeldingen plakken in `_assets/`, slideshow-modus (`⌘⌥P`), Vim-modus, Hunspell + CJK-spellingscontrole, semantisch zoeken (`⌘⇧F`), wikilinks + backlinks, Pandoc-export. CJK-coderingen (GBK / Big5 / Shift-JIS) automatisch gedetecteerd.

**Het eindpunt.** Een meegeleverde `solomd-mcp`-binary stelt dezelfde vault beschikbaar aan elke MCP-client — 13 tools standaard, waaronder 5 SoloMD-eigen (`autogit_log`, `autogit_diff`, `autogit_rollback`, `sync_status`, `share_url`) die geen enkele andere Markdown-server heeft. v4.0 voegt `--workspace path1 --workspace path2`-federatie toe — één MCP-sessie, meerdere vaults. Plus een `solomd agent <prompt>`-CLI die doorgeeft aan Claude Code / Codex CLI met vooraf bedrade MCP.

**Het agent-oppervlak (v4.0).** Agentpaneel aan de rechterkant: gestreamde chat-with-vault, `[[wikilink]]`-citaties, tool-call-kaarten inline, **Invoegen** / **Kopiëren**-knoppen laten het antwoord in de actieve notitie vallen. Plus declaratieve **recipes** als YAML in `<workspace>/.solomd/agents/*.yml` — `cron` / `on-save` / `on-commit` / `on-tag-add` / handmatige triggers. **Elke schrijfactie van een agent landt op zijn eigen AutoGit-branch die je accepteert of afwijst** voordat hij `main` raakt; standaard write-cap 5; weigert te starten als de werkboom dirty is; herhaalbare `trace.jsonl` per run met `read_agent_trace` MCP-tool.

| Functie | |
|---|---|
| **Agentpaneel** *(v4.0)* | Gestreamde chat-with-vault op gelijke voet met Outline / Backlinks / Tags / History. Tool-call-kaarten klappen inline open; antwoord Invoegen / Kopiëren naar de actieve editor; runlogboek bewaard als pure Markdown onder `.solomd/agent-runs/`. |
| **Geplande recipes** *(v4.0)* | YAML-jobs in je vault. AutoGit-branch-sandbox + accept/reject-UI vóór merge. Per-run write-cap (standaard 5, max. 50). Receptenboek met 11 recipes in de tree. |
| **Herhaalbare trace** *(v4.0)* | `trace.jsonl` per stap (`prompt` / `model_call` / `tool_call` / `tool_result` / `git_commit`). Replay-from-step spoelt terug en voert opnieuw uit. |
| **Workspace-federatie** *(v4.0)* | `solomd-mcp --workspace path1 --workspace path2`. Eén Claude Desktop-sessie, meerdere vaults. MCP-profiel-UI in Instellingen → Integraties. |
| **Ollama eersteklas** *(v4.0)* | Auto-detectie op `localhost:11434`. Drie model-presets (`qwen2.5:1.5b/7b/14b`). `provider: local` recipe-alias voor cloud-vrije autonome loops. |
| **AI-herschrijven, BYOK** | 14 providers — OpenAI · Claude · Gemini · DeepSeek · Qwen · GLM · Kimi · Doubao · SiliconFlow · OpenRouter · Mistral · Groq · xAI · Ollama. Directe vendor-aanroepen. Sleutels in OS-keychain. |
| **GitHub-backed sync** | Push je vault bij elke save naar een privé GitHub-repo. Optionele E2EE (Argon2id + XChaCha20-Poly1305). GitLab / Gitea / elke HTTPS-git-URL werkt ook. |
| **AutoGit per notitie** | Elke `⌘S` is een commit in een lokale `.git` in de workspace. libgit2 meegeleverd, geen systeem-git nodig. Wordt nooit automatisch gepusht. |
| **MCP-server gebundeld** | `solomd-mcp` zit in de installatie. 13 tools (8 generiek + 5 SoloMD-eigen). Stdio-only, geen netwerkpoort. Standaard read-only; `--allow-write` opt-in. |
| **REST API** *(v4.0)* | Localhost only, token-auth. Hetzelfde oppervlak als MCP voor clients die nog geen MCP spreken — Alfred / Raycast / n8n / eigen scripts. |
| **BYOK-kostenmeter** *(v4.0)* | Lopende token-verbruiksteller per provider, opt-in. Instellingen → Integraties. |
| **Cloud-mapmodus** | Als je vault in `~/Library/Mobile Documents/...` of `~/Dropbox/...` staat, detecteert SoloMD dat en voegt sessieherstel over apparaten heen toe — het OS doet de bestandssync al. |
| **Publieke read-only sharing** | Command palette → kopieer een `solomd.app/share/?repo=...&path=...`-link. Rendert elk bestand in je publieke GitHub-repo, geen SoloMD-account nodig om te bekijken. |

## Gebruik

Na installatie van SoloMD op macOS / Linux:

**1. Chat met je vault.** Open het agentpaneel rechts (⌘⇧P → "View: Toggle Agent Panel" als het verborgen is). Gestreamde multi-turn tegen je notities; tool-call-kaarten tonen elke read/write inline. Antwoord te lang? **Invoegen** laat het op de cursorpositie in de actieve notitie vallen (vervangt selectie); **Kopiëren** naar het klembord.

**2. Plan een recipe.** Instellingen → Recipes → blader door het receptenboek. 11 starters klaar: weekoverzicht, dagelijkse samenvatting, TODO-extractie, vertaalpas, citatieopschoning, CJK-spellingschecker-agent, link-rot-detector, frontmatter-normalisator, outline-naar-blog, refactor-pas, wekelijkse tag-triage. Installeer er één, bewerk de prompt, voer uit.

**3. Stuur dezelfde vault aan vanuit een andere LLM-client.** One-shot:

```bash
# Print MCP-configuratiesnippet voor je AI-client.
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

Plak in Claude Desktop / Cursor / etc. Voor multi-vault-federatie herhaal je `--workspace`:

```json
"args": [
  "--workspace", "/Users/me/Documents/SoloMD",
  "--workspace", "/Users/me/Documents/work-notes"
]
```

**4. Of geef een prompt rechtstreeks door aan de claude / codex CLI:**

```bash
solomd agent "herschrijf deze week aan dagelijkse notities tot een weekoverzicht en commit het"
```

Beveiligd tegen path traversal. Geen netwerkpoort. Het LLM ziet alleen waar je de workspace op richt.

## Installatie

Nieuwste release: [**v4.0.0**](https://github.com/zhitongblog/solomd/releases/latest).

### macOS — universele dmg (Apple Silicon + Intel, gesigneerd + genotariseerd)

```bash
brew install --cask zhitongblog/solomd/solomd
```

Of download de dmg rechtstreeks:

```
https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_universal.dmg
```

Of one-liner shell-installatie:

```bash
curl -fsSL https://solomd.app/install.sh | bash
```

### Windows — x64

- [`SoloMD_4.0.0_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64_en-US.msi)
- [`SoloMD_4.0.0_x64-setup.exe`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-setup.exe) (NSIS)
- [`SoloMD_4.0.0_x64-portable.zip`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-portable.zip) — geen installer

```powershell
irm https://solomd.app/install.ps1 | iex
```

```powershell
winget install solomd
```

### Linux — x86_64 + aarch64

- `.AppImage` (universeel), `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL) — beide architecturen op [de releases-pagina](https://github.com/zhitongblog/solomd/releases/latest).
- Arch-gebruikers: [`solomd-bin`](https://aur.archlinux.org/packages/solomd-bin) op AUR.

### iPad

[App Store](https://apps.apple.com/app/solomd/id6762498874) — dezelfde engine, native iPad-UI.

## Privacy & beveiliging

Puur client-side. Je `.md`-bestanden blijven in de map die jij koos. API-sleutels leven in de OS-keychain (macOS Keychain / Windows Credential Manager / Linux libsecret), nooit in `localStorage` of een configbestand. AI-verzoeken gaan rechtstreeks van je machine naar de gekozen provider — geen SoloMD-relay. RAG-embeddings en de AutoGit-repo zijn alleen lokaal. De MCP-server praat stdio, opent nooit een netwerkpoort. De volledige codebase is MIT en auditbaar.

**Agent-veiligheidsvangrails (v4.0).** Elke recipe-run start op een eigen AutoGit-branch — je `main` blijft onaangeroerd totdat je op het diff op Accepteren klikt. Per-run write-cap (standaard 5, harde max. 50) voorkomt op hol geslagen loops. De recipe-runner weigert te starten als de werkboom dirty is (geen agent-commit zal je WIP opvegen). Path-traversal-guards weigeren `..`-segmenten en absolute paden vooraf in elk Tauri / MCP / REST-eindpunt dat een door de gebruiker geleverd pad accepteert.

E2EE-sync gebruikt Argon2id (RFC9106 standaardparameters) → XChaCha20-Poly1305 met deterministische nonces en pad-als-AAD. Plaintext blijft op je apparaten; de remote ziet alleen ciphertext. Mislukt parsen van `sync.json` is fail-closed — weigert push in plaats van te degraderen naar plaintext (een v3.0.x audit-fix).

Volledige uitleg: <https://solomd.app/security>.

## Bouwen vanuit broncode

Vereisten: Rust (stable), Node 18+, pnpm.

```bash
git clone https://github.com/zhitongblog/solomd.git
cd solomd/app
pnpm install
pnpm tauri dev      # dev met hot reload
pnpm tauri build    # release-artefacten → src-tauri/target/release/bundle/
```

Linux heeft daarnaast `libdbus-1-dev` nodig voor de keychain-backend.

De MCP-server is een aparte crate onder `mcp-server/`; het dev-MCP-harnas voor end-to-end-tests staat onder `dev-mcp/`. Entry point voor end-to-end-tests: `scripts/v4-self-test.sh` (draai met `--with-release --with-ollama --with-ui` voor volledige dekking).

## Bijdragen

Issues en PRs welkom — [open er een](https://github.com/zhitongblog/solomd/issues). Voor een gevoel van de richting zie [`docs/roadmap.md`](docs/roadmap.md). Het v4.0 build-log staat op [solomd.app/blog/v4-0-0-how-we-built-it/](https://solomd.app/blog/v4-0-0-how-we-built-it/) — daar beginnen als je de engineering-principes wilt begrijpen voordat je een PR stuurt.

## Contact

Eén maintainer, twee voordeuren. Async op [GitHub Discussions](https://github.com/zhitongblog/solomd/discussions). Realtime chat:

- **Telegram (internationaal):** [@SOLOMDAPP](https://t.me/SOLOMDAPP) — release-aankondigingen + chat
- **WeChat (中文):** scan om me toe te voegen — notitie "SoloMD"

## Licentie & credits

[MIT](LICENSE) © 2026 xiangdong li. SoloMD staat op Tauri 2, Vue 3, CodeMirror 6, markdown-it, KaTeX, Mermaid, libgit2, Pandoc, Hunspell, `keyring-rs` en `rmcp`. Sponsoren via [GitHub Sponsors](https://github.com/sponsors/zhitongblog) of [solomd.app/#sponsor](https://solomd.app/#sponsor).
