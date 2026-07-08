# SoloMD

> L'editor dove vivono gli agent.

[![Latest release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/zhitongblog/solomd/total)](https://github.com/zhitongblog/solomd/releases)
[![Website](https://img.shields.io/badge/website-solomd.app-ff9f40.svg)](https://solomd.app)

🌐 **[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [Polski](README.pl.md) · [Nederlands](README.nl.md) · [Türkçe](README.tr.md) · [Svenska](README.sv.md) · [Українська](README.uk.md)**

[**Scarica v4.0**](https://github.com/zhitongblog/solomd/releases/latest) · [**Post di lancio**](https://solomd.app/blog/v4-0-0-agent-native-author/) · [**Sito web**](https://solomd.app) · [**Sicurezza**](https://solomd.app/security)

![Editor SoloMD](web/public/demo/solomd-demo.svg)

Le tue note vivono in una cartella. **SoloMD è l'editor sopra — con una superficie agent di prima classe dentro l'editor e l'endpoint MCP che Claude Code / Cursor possono pilotare dall'esterno.** Stessi file `.md`. Chatta con il tuo vault. Pianifica recipes che girano quando non sei alla tastiera. Consegna lo stesso vault a qualsiasi client MCP.

Costruito su Tauri 2 + Vue 3 + CodeMirror 6. Universal macOS dmg ~32 MB. Gratis, MIT, senza abbonamento, senza server ospitati da SoloMD. Le tue note, chiavi AI, indice di embeddings e cronologia git restano tutti sulla tua macchina.

## Tre metà di un prodotto

**L'editor.** Modifica live WYSIWYG (stile Typora), schede + pannelli divisi, KaTeX + Mermaid, incolla immagini in `_assets/`, modalità presentazione (`⌘⌥P`), modalità Vim, Hunspell + revisione CJK, ricerca semantica (`⌘⇧F`), wikilinks + backlinks, esportazione Pandoc. Codifiche CJK (GBK / Big5 / Shift-JIS) auto-rilevate.

**L'endpoint.** Un binario `solomd-mcp` empacchettato espone lo stesso vault a qualsiasi client MCP — 13 strumenti pronti, inclusi 5 specifici di SoloMD (`autogit_log`, `autogit_diff`, `autogit_rollback`, `sync_status`, `share_url`) che nessun altro server markdown ha. v4.0 aggiunge federazione `--workspace path1 --workspace path2` — una sessione MCP, molti vault. Più un CLI `solomd agent <prompt>` che consegna a Claude Code / Codex CLI con MCP pre-cablato.

**La superficie agent (v4.0).** Pannello Agent a destra: chat-with-vault streamato, citazioni `[[wikilink]]`, schede di chiamata strumento inline, pulsanti **Inserisci** / **Copia** lasciano cadere la risposta nella nota attiva. Più **recipes** dichiarativi come YAML in `<workspace>/.solomd/agents/*.yml` — trigger `cron` / `on-save` / `on-commit` / `on-tag-add` / manuali. **Ogni scrittura agent atterra sulla propria branch AutoGit che accetti o rifiuti** prima che tocchi `main`; write-cap predefinito 5; rifiuta di partire quando l'albero di lavoro è dirty; `trace.jsonl` ripetibile per esecuzione con strumento MCP `read_agent_trace`.

| Funzionalità | |
|---|---|
| **Pannello Agent** *(v4.0)* | Chat-with-vault streamato allo stesso livello di Outline / Backlinks / Tags / History. Schede di chiamata strumento si espandono inline; risposta Insert / Copy nell'editor attivo; cronologia esecuzione persiste come markdown semplice sotto `.solomd/agent-runs/`. |
| **Recipes pianificati** *(v4.0)* | Job YAML nel tuo vault. Sandbox di branch AutoGit + UI accept/reject prima del merge. Write-cap per esecuzione (predefinito 5, soffitto 50). Cookbook da 11 recipes nell'albero. |
| **Trace ripetibile** *(v4.0)* | `trace.jsonl` per passo (`prompt` / `model_call` / `tool_call` / `tool_result` / `git_commit`). Replay-from-step riavvolge e riesegue. |
| **Federazione workspace** *(v4.0)* | `solomd-mcp --workspace path1 --workspace path2`. Una sessione Claude Desktop, molti vault. UI profili MCP in Impostazioni → Integrazioni. |
| **Ollama prima classe** *(v4.0)* | Auto-rilevamento su `localhost:11434`. Tre preset di modello (`qwen2.5:1.5b/7b/14b`). Alias recipe `provider: local` per loop autonomi a costo zero in cloud. |
| **Riscrittura AI, BYOK** | 14 provider — OpenAI · Claude · Gemini · DeepSeek · Qwen · GLM · Kimi · Doubao · SiliconFlow · OpenRouter · Mistral · Groq · xAI · Ollama. Chiamate dirette al fornitore. Chiavi nel portachiavi OS. |
| **Sync supportato da GitHub** | Spingi il tuo vault in un repo privato GitHub a ogni salvataggio. E2EE opzionale (Argon2id + XChaCha20-Poly1305). GitLab / Gitea / qualsiasi URL git HTTPS funziona anche. |
| **AutoGit per nota** | Ogni `⌘S` è un commit in un `.git` locale dentro il workspace. libgit2 incluso, nessun git di sistema necessario. Mai auto-pushato. |
| **Server MCP empacchettato** | `solomd-mcp` viene nell'installazione. 13 strumenti (8 generici + 5 specifici SoloMD). Solo stdio, nessuna porta di rete. Sola lettura di default; `--allow-write` opt-in. |
| **API REST** *(v4.0)* | Solo localhost, auth con token. Stessa superficie di MCP per client che ancora non parlano MCP — Alfred / Raycast / n8n / i tuoi script. |
| **Contatore costi BYOK** *(v4.0)* | Contatore corrente di token spesi per provider, opt-in. Impostazioni → Integrazioni. |
| **Modalità cartella cloud** | Se il tuo vault vive in `~/Library/Mobile Documents/...` o `~/Dropbox/...`, SoloMD lo rileva e aggiunge ripristino sessione cross-device sopra — l'OS fa già la sync dei file. |
| **Condivisione pubblica sola lettura** | Tavolozza comandi → copia link `solomd.app/share/?repo=...&path=...`. Renderizza qualsiasi file nel tuo repo GitHub pubblico, nessun account SoloMD richiesto per visualizzare. |

## Uso

Dopo aver installato SoloMD su macOS / Linux:

**1. Chatta con il tuo vault.** Apri il pannello Agent a destra (⌘⇧P → "View: Toggle Agent Panel" se nascosto). Multi-turno streamato contro le tue note; le schede di chiamata strumento mostrano ogni lettura/scrittura inline. Risposta troppo lunga? **Inserisci** la lascia alla posizione del cursore nella nota attiva (sostituisce selezione); **Copia** negli appunti.

**2. Pianifica un recipe.** Impostazioni → Recipes → Sfoglia cookbook. 11 starter pronti: revisione settimanale, riepilogo giornaliero, estrazione TODO, passaggio di traduzione, pulizia citazioni, agent revisione CJK, rilevatore link rot, normalizzatore frontmatter, outline-a-blog, passaggio refactor, triage tag settimanale. Installane uno, modifica il prompt, eseguilo.

**3. Pilota lo stesso vault da un altro client LLM.** One-shot:

```bash
# Stampa lo snippet di config MCP per il tuo client AI.
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

Incolla in Claude Desktop / Cursor / ecc. Per federazione multi-vault, ripeti `--workspace`:

```json
"args": [
  "--workspace", "/Users/me/Documents/SoloMD",
  "--workspace", "/Users/me/Documents/work-notes"
]
```

**4. O consegna un prompt direttamente al CLI claude / codex:**

```bash
solomd agent "riscrivi questa settimana di note giornaliere come una revisione settimanale e fai commit"
```

Path-traversal protetto. Nessuna porta di rete. L'LLM vede solo dove punti il workspace.

## Installazione

Release più recente: [**v4.0.0**](https://github.com/zhitongblog/solomd/releases/latest).

### macOS — universal dmg (Apple Silicon + Intel, firmato + notarizzato)

```bash
brew install --cask zhitongblog/solomd/solomd
```

O scarica il dmg direttamente:

```
https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_universal.dmg
```

O installazione shell in una riga:

```bash
curl -fsSL https://solomd.app/install.sh | bash
```

### Windows — x64

- [`SoloMD_4.0.0_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64_en-US.msi)
- [`SoloMD_4.0.0_x64-setup.exe`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-setup.exe) (NSIS)
- [`SoloMD_4.0.0_x64-portable.zip`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-portable.zip) — senza installer

```powershell
irm https://solomd.app/install.ps1 | iex
```

```powershell
winget install solomd
```

### Linux — x86_64 + aarch64

- `.AppImage` (universale), `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL) — entrambe le architetture dalla [pagina releases](https://github.com/zhitongblog/solomd/releases/latest).
- Utenti Arch: [`solomd-bin`](https://aur.archlinux.org/packages/solomd-bin) su AUR.

### iPad

[App Store](https://apps.apple.com/app/solomd/id6762498874) — stesso motore, UI iPad nativa.

## Privacy e sicurezza

Puramente lato client. I tuoi file `.md` restano nella cartella che hai scelto. Le chiavi API vivono nel portachiavi OS (macOS Keychain / Windows Credential Manager / Linux libsecret), mai in `localStorage` o un file di config. Le richieste AI vanno dirette dalla tua macchina al provider che hai scelto — nessun relay SoloMD. Gli embeddings RAG e il repo AutoGit sono solo locali. Il server MCP parla stdio, mai apre una porta di rete. L'intera codebase è MIT e auditabile.

**Guardrail agent (v4.0).** Ogni esecuzione di recipe parte sulla propria branch AutoGit — il tuo `main` resta intoccato finché non clicchi Accetta sul diff. Write-cap per esecuzione (predefinito 5, tetto duro 50) previene loop fuori controllo. Il runner di recipe rifiuta di partire quando l'albero di lavoro è dirty (nessun commit agent porterà via il tuo WIP). I guardiani path-traversal rifiutano segmenti `..` e percorsi assoluti in anticipo in ogni endpoint Tauri / MCP / REST che accetta un percorso fornito dall'utente.

La sync E2EE usa Argon2id (parametri predefiniti RFC9106) → XChaCha20-Poly1305 con nonce deterministici e percorso-come-AAD. Il testo in chiaro resta sui tuoi dispositivi; il remoto vede solo cifrato. Il parsing fallito di `sync.json` è fail-closed — rifiuta di pushare invece di degradare a testo in chiaro (un fix di audit v3.0.x).

Writeup completo: <https://solomd.app/security>.

## Compilare dai sorgenti

Prerequisiti: Rust (stable), Node 18+, pnpm.

```bash
git clone https://github.com/zhitongblog/solomd.git
cd solomd/app
pnpm install
pnpm tauri dev      # dev con hot reload
pnpm tauri build    # artefatti release → src-tauri/target/release/bundle/
```

Linux necessita inoltre `libdbus-1-dev` per il backend del portachiavi.

Il server MCP è un crate separato in `mcp-server/`; il dev MCP harness usato per i test end-to-end vive in `dev-mcp/`. Punto di ingresso dei test end-to-end: `scripts/v4-self-test.sh` (esegui con `--with-release --with-ollama --with-ui` per copertura completa).

## Contribuire

Issue e PR benvenuti — [aprine uno](https://github.com/zhitongblog/solomd/issues). Per un senso della direzione, vedi [`docs/roadmap.md`](docs/roadmap.md). Il log di build v4.0 è su [solomd.app/blog/v4-0-0-how-we-built-it/](https://solomd.app/blog/v4-0-0-how-we-built-it/) — inizia da lì se vuoi capire i principi di ingegneria prima di inviare un PR.

## Contatto

Un manutentore, due porte d'ingresso. Asincrono su [GitHub Discussions](https://github.com/zhitongblog/solomd/discussions). Chat in tempo reale:

- **Telegram (internazionale):** [@SOLOMDAPP](https://t.me/SOLOMDAPP) — annunci release + chat
- **WeChat (中文):** scansiona per aggiungermi — nota "SoloMD"

## Licenza e crediti

[MIT](LICENSE) © 2026 xiangdong li. SoloMD si appoggia su Tauri 2, Vue 3, CodeMirror 6, markdown-it, KaTeX, Mermaid, libgit2, Pandoc, Hunspell, `keyring-rs` e `rmcp`. Sponsorizza su [GitHub Sponsors](https://github.com/sponsors/zhitongblog) o via [solomd.app/#sponsor](https://solomd.app/#sponsor).
