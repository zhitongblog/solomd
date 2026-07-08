# SoloMD

> O editor onde os agentes vivem.

[![Latest release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/zhitongblog/solomd/total)](https://github.com/zhitongblog/solomd/releases)
[![Website](https://img.shields.io/badge/website-solomd.app-ff9f40.svg)](https://solomd.app)

🌐 **[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Nederlands](README.nl.md) · [Türkçe](README.tr.md) · [Svenska](README.sv.md) · [Українська](README.uk.md)**

[**Baixar v4.0**](https://github.com/zhitongblog/solomd/releases/latest) · [**Post de lançamento**](https://solomd.app/blog/v4-0-0-agent-native-author/) · [**Site**](https://solomd.app) · [**Segurança**](https://solomd.app/security)

![Editor SoloMD](web/public/demo/solomd-demo.svg)

Suas notas vivem em uma pasta. **O SoloMD é o editor por cima — com uma superfície de agente de primeira classe dentro do editor e o endpoint MCP que o Claude Code / Cursor podem operar de fora.** Os mesmos arquivos `.md`. Converse com seu vault. Agende recipes que rodam quando você não está no teclado. Entregue o mesmo vault a qualquer cliente MCP.

Construído sobre Tauri 2 + Vue 3 + CodeMirror 6. Universal macOS dmg ~32 MB. Grátis, MIT, sem assinatura, sem servidores hospedados pelo SoloMD. Suas notas, chaves AI, índice de embeddings e histórico git permanecem todos em sua máquina.

## Três metades de um produto

**O editor.** Edição ao vivo WYSIWYG (estilo Typora), abas + painéis divididos, KaTeX + Mermaid, colar imagens em `_assets/`, modo apresentação (`⌘⌥P`), modo Vim, Hunspell + revisão CJK, busca semântica (`⌘⇧F`), wikilinks + backlinks, exportação Pandoc. Codificações CJK (GBK / Big5 / Shift-JIS) detectadas automaticamente.

**O endpoint.** Um binário `solomd-mcp` empacotado expõe o mesmo vault a qualquer cliente MCP — 13 ferramentas prontas, incluindo 5 específicas do SoloMD (`autogit_log`, `autogit_diff`, `autogit_rollback`, `sync_status`, `share_url`) que nenhum outro servidor markdown tem. v4.0 adiciona federação `--workspace path1 --workspace path2` — uma sessão MCP, vários vaults. Mais um CLI `solomd agent <prompt>` que entrega ao Claude Code / Codex CLI com MCP pré-conectado.

**A superfície de agente (v4.0).** Painel Agent à direita: chat-with-vault em streaming, citações `[[wikilink]]`, cartões de chamada de ferramenta inline, botões **Inserir** / **Copiar** colocam a resposta na nota ativa. Mais **recipes** declarativos como YAML em `<workspace>/.solomd/agents/*.yml` — gatilhos `cron` / `on-save` / `on-commit` / `on-tag-add` / manual. **Cada escrita de agente aterrissa em sua própria branch AutoGit que você aceita ou rejeita** antes que toque `main`; write-cap padrão 5; recusa iniciar quando a árvore de trabalho está suja; `trace.jsonl` reproduzível por execução com a ferramenta MCP `read_agent_trace`.

| Funcionalidade | |
|---|---|
| **Painel Agent** *(v4.0)* | Chat-with-vault em streaming no mesmo nível de Outline / Backlinks / Tags / History. Cartões de chamada de ferramenta expandem inline; resposta Insert / Copy para o editor ativo; histórico de execução persiste como markdown puro sob `.solomd/agent-runs/`. |
| **Recipes agendados** *(v4.0)* | Jobs YAML no seu vault. Sandbox de branch AutoGit + UI accept/reject antes do merge. Write-cap por execução (padrão 5, teto 50). Cookbook de 11 recipes na árvore. |
| **Trace reproduzível** *(v4.0)* | `trace.jsonl` por etapa (`prompt` / `model_call` / `tool_call` / `tool_result` / `git_commit`). Replay-from-step rebobina e re-executa. |
| **Federação de workspace** *(v4.0)* | `solomd-mcp --workspace path1 --workspace path2`. Uma sessão Claude Desktop, vários vaults. UI de perfis MCP em Configurações → Integrações. |
| **Ollama primeira classe** *(v4.0)* | Auto-detecção em `localhost:11434`. Três presets de modelo (`qwen2.5:1.5b/7b/14b`). Alias de recipe `provider: local` para loops autônomos sem custo de nuvem. |
| **Reescrita IA, BYOK** | 14 providers — OpenAI · Claude · Gemini · DeepSeek · Qwen · GLM · Kimi · Doubao · SiliconFlow · OpenRouter · Mistral · Groq · xAI · Ollama. Chamadas diretas ao fornecedor. Chaves no chaveiro do SO. |
| **Sync apoiado em GitHub** | Empurre seu vault para um repo privado do GitHub a cada salvamento. E2EE opcional (Argon2id + XChaCha20-Poly1305). GitLab / Gitea / qualquer URL git HTTPS também funciona. |
| **AutoGit por nota** | Cada `⌘S` é um commit em um `.git` local dentro do workspace. libgit2 incorporado, sem necessidade de git do sistema. Nunca faz auto-push. |
| **Servidor MCP empacotado** | `solomd-mcp` vem na instalação. 13 ferramentas (8 genéricas + 5 específicas do SoloMD). Apenas stdio, sem porta de rede. Somente leitura por padrão; `--allow-write` opt-in. |
| **API REST** *(v4.0)* | Apenas localhost, auth por token. Mesma superfície que MCP para clientes que ainda não falam MCP — Alfred / Raycast / n8n / seus próprios scripts. |
| **Medidor de custo BYOK** *(v4.0)* | Contador acumulado de tokens gastos por provider, opt-in. Configurações → Integrações. |
| **Modo pasta cloud** | Se seu vault vive em `~/Library/Mobile Documents/...` ou `~/Dropbox/...`, o SoloMD detecta e adiciona restauração de sessão entre dispositivos por cima — o SO já faz a sync de arquivos. |
| **Compartilhamento público somente leitura** | Paleta de comandos → copiar link `solomd.app/share/?repo=...&path=...`. Renderiza qualquer arquivo em seu repo público do GitHub, não precisa de conta SoloMD para visualizar. |

## Uso

Após instalar o SoloMD em macOS / Linux:

**1. Converse com seu vault.** Abra o painel Agent à direita (⌘⇧P → "View: Toggle Agent Panel" se oculto). Multi-turno em streaming contra suas notas; cartões de chamada de ferramenta mostram cada leitura/escrita inline. Resposta muito longa? **Inserir** a coloca na posição do cursor na nota ativa (substitui seleção); **Copiar** para a área de transferência.

**2. Agende um recipe.** Configurações → Recipes → Explorar cookbook. 11 starters prontos: revisão semanal, resumo diário, extração TODO, passada de tradução, limpeza de citações, agente de revisão CJK, detector de link rot, normalizador de frontmatter, outline-para-blog, passada de refactor, triagem semanal de tags. Instale um, edite o prompt, execute.

**3. Opere o mesmo vault de outro cliente LLM.** One-shot:

```bash
# Imprime o snippet de config MCP para seu cliente IA.
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

Cole no Claude Desktop / Cursor / etc. Para federação multi-vault, repita `--workspace`:

```json
"args": [
  "--workspace", "/Users/me/Documents/SoloMD",
  "--workspace", "/Users/me/Documents/work-notes"
]
```

**4. Ou entregue um prompt diretamente ao claude / codex CLI:**

```bash
solomd agent "reescreva esta semana de notas diárias como uma revisão semanal e committe"
```

Path-traversal protegido. Sem porta de rede. O LLM só vê para onde você apontar o workspace.

## Instalação

Release mais recente: [**v4.0.0**](https://github.com/zhitongblog/solomd/releases/latest).

### macOS — universal dmg (Apple Silicon + Intel, assinado + notarizado)

```bash
brew install --cask zhitongblog/solomd/solomd
```

Ou baixar o dmg diretamente:

```
https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_universal.dmg
```

Ou instalação shell em uma linha:

```bash
curl -fsSL https://solomd.app/install.sh | bash
```

### Windows — x64

- [`SoloMD_4.0.0_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64_en-US.msi)
- [`SoloMD_4.0.0_x64-setup.exe`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-setup.exe) (NSIS)
- [`SoloMD_4.0.0_x64-portable.zip`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-portable.zip) — sem instalador

```powershell
irm https://solomd.app/install.ps1 | iex
```

```powershell
winget install solomd
```

### Linux — x86_64 + aarch64

- `.AppImage` (universal), `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL) — ambas arquiteturas em [a página de releases](https://github.com/zhitongblog/solomd/releases/latest).
- Usuários Arch: [`solomd-bin`](https://aur.archlinux.org/packages/solomd-bin) no AUR.

### iPad

[App Store](https://apps.apple.com/app/solomd/id6762498874) — mesmo motor, UI nativa do iPad.

## Privacidade e segurança

Puramente do lado do cliente. Seus arquivos `.md` permanecem na pasta que você escolheu. As chaves API vivem no chaveiro do SO (macOS Keychain / Windows Credential Manager / Linux libsecret), nunca em `localStorage` ou em um arquivo de config. Solicitações IA vão direto da sua máquina para o provider que você escolheu — sem relé SoloMD. Embeddings RAG e o repo AutoGit são apenas locais. O servidor MCP fala stdio, nunca abre porta de rede. Todo o código é MIT e auditável.

**Guardas de agente (v4.0).** Cada execução de recipe começa em sua própria branch AutoGit — seu `main` permanece intocado até você clicar Aceitar no diff. Write-cap por execução (padrão 5, teto duro 50) previne loops descontrolados. O runner de recipe recusa iniciar quando a árvore de trabalho está suja (nenhum commit de agente vai varrer seu WIP). Guardas de path-traversal rejeitam segmentos `..` e caminhos absolutos antecipadamente em cada endpoint Tauri / MCP / REST que aceita um caminho fornecido pelo usuário.

A sync E2EE usa Argon2id (parâmetros padrão RFC9106) → XChaCha20-Poly1305 com nonces determinísticos e caminho-como-AAD. Texto plano permanece nos seus dispositivos; o remoto só vê cifrado. O parsing falho de `sync.json` é fail-closed — recusa empurrar em vez de rebaixar para texto plano (um fix de auditoria v3.0.x).

Writeup completo: <https://solomd.app/security>.

## Compilar do código fonte

Pré-requisitos: Rust (stable), Node 18+, pnpm.

```bash
git clone https://github.com/zhitongblog/solomd.git
cd solomd/app
pnpm install
pnpm tauri dev      # dev com hot reload
pnpm tauri build    # artefatos release → src-tauri/target/release/bundle/
```

Linux precisa adicionalmente de `libdbus-1-dev` para o backend do chaveiro.

O servidor MCP é um crate separado em `mcp-server/`; o harness MCP dev usado para testes end-to-end vive em `dev-mcp/`. Ponto de entrada de testes end-to-end: `scripts/v4-self-test.sh` (rode com `--with-release --with-ollama --with-ui` para cobertura completa).

## Contribuir

Issues e PRs bem-vindos — [abra um](https://github.com/zhitongblog/solomd/issues). Para um sentido de direção, veja [`docs/roadmap.md`](docs/roadmap.md). O log de build v4.0 está em [solomd.app/blog/v4-0-0-how-we-built-it/](https://solomd.app/blog/v4-0-0-how-we-built-it/) — comece aí se quiser entender os princípios de engenharia antes de enviar um PR.

## Contato

Um mantenedor, duas portas de entrada. Assíncrono no [GitHub Discussions](https://github.com/zhitongblog/solomd/discussions). Chat em tempo real:

- **Telegram (internacional):** [@SOLOMDAPP](https://t.me/SOLOMDAPP) — anúncios de release + chat
- **WeChat (中文):** escaneie para me adicionar — nota "SoloMD"

## Licença e créditos

[MIT](LICENSE) © 2026 xiangdong li. O SoloMD se apoia em Tauri 2, Vue 3, CodeMirror 6, markdown-it, KaTeX, Mermaid, libgit2, Pandoc, Hunspell, `keyring-rs` e `rmcp`. Patrocine no [GitHub Sponsors](https://github.com/sponsors/zhitongblog) ou via [solomd.app/#sponsor](https://solomd.app/#sponsor).
