# SoloMD

> L'éditeur où vivent les agents.

[![Latest release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/zhitongblog/solomd/total)](https://github.com/zhitongblog/solomd/releases)
[![Website](https://img.shields.io/badge/website-solomd.app-ff9f40.svg)](https://solomd.app)

🌐 **[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Nederlands](README.nl.md) · [Türkçe](README.tr.md) · [Svenska](README.sv.md) · [Українська](README.uk.md)**

[**Télécharger v4.0**](https://github.com/zhitongblog/solomd/releases/latest) · [**Article de lancement**](https://solomd.app/blog/v4-0-0-agent-native-author/) · [**Site web**](https://solomd.app) · [**Sécurité**](https://solomd.app/security)

![Éditeur SoloMD](web/public/demo/solomd-demo.svg)

Vos notes vivent dans un dossier. **SoloMD est l'éditeur par-dessus — avec une surface d'agent de première classe à l'intérieur de l'éditeur, et le point de terminaison MCP que Claude Code / Cursor peuvent piloter depuis l'extérieur.** Mêmes fichiers `.md`. Discutez avec votre vault. Planifiez des recipes qui s'exécutent quand vous n'êtes pas au clavier. Confiez le même vault à n'importe quel client MCP.

Construit sur Tauri 2 + Vue 3 + CodeMirror 6. Universal macOS dmg ~32 Mo. Gratuit, MIT, sans abonnement, sans serveurs hébergés par SoloMD. Vos notes, clés AI, index d'embeddings et historique git restent tous sur votre machine.

## Trois moitiés d'un produit

**L'éditeur.** Édition en direct WYSIWYG (style Typora), onglets + volets divisés, KaTeX + Mermaid, collage d'images dans `_assets/`, mode diaporama (`⌘⌥P`), mode Vim, Hunspell + relecture CJK, recherche sémantique (`⌘⇧F`), wikilinks + backlinks, export Pandoc. Encodages CJK (GBK / Big5 / Shift-JIS) auto-détectés.

**Le point de terminaison.** Un binaire `solomd-mcp` empaqueté expose le même vault à n'importe quel client MCP — 13 outils prêts à l'emploi, dont 5 spécifiques à SoloMD (`autogit_log`, `autogit_diff`, `autogit_rollback`, `sync_status`, `share_url`) qu'aucun autre serveur markdown n'a. v4.0 ajoute la fédération `--workspace path1 --workspace path2` — une session MCP, plusieurs vaults. Plus un CLI `solomd agent <prompt>` qui transmet à Claude Code / Codex CLI avec MCP pré-câblé.

**La surface d'agent (v4.0).** Panneau Agent à droite : chat-with-vault streamé, citations `[[wikilink]]`, cartes d'appels d'outil inline, boutons **Insérer** / **Copier** déposent la réponse dans la note active. Plus des **recipes** déclaratives en YAML dans `<workspace>/.solomd/agents/*.yml` — déclencheurs `cron` / `on-save` / `on-commit` / `on-tag-add` / manuels. **Chaque écriture d'agent atterrit sur sa propre branche AutoGit que vous acceptez ou rejetez** avant qu'elle ne touche à `main` ; write-cap par défaut 5 ; refuse de démarrer quand l'arbre de travail est dirty ; `trace.jsonl` rejouable par exécution avec l'outil MCP `read_agent_trace`.

| Fonctionnalité | |
|---|---|
| **Panneau Agent** *(v4.0)* | Chat-with-vault streamé au même niveau qu'Outline / Backlinks / Tags / History. Cartes d'appels d'outil se déplient inline ; Insertion / Copie de réponse vers l'éditeur actif ; historique d'exécution persiste comme markdown brut sous `.solomd/agent-runs/`. |
| **Recipes planifiés** *(v4.0)* | Jobs YAML dans votre vault. Sandbox de branche AutoGit + UI accept/reject avant merge. Write-cap par exécution (par défaut 5, plafond 50). Cookbook de 11 recipes livré dans l'arbre. |
| **Trace rejouable** *(v4.0)* | `trace.jsonl` par étape (`prompt` / `model_call` / `tool_call` / `tool_result` / `git_commit`). Replay-from-step rembobine et réexécute. |
| **Fédération de workspace** *(v4.0)* | `solomd-mcp --workspace path1 --workspace path2`. Une session Claude Desktop, plusieurs vaults. UI de profils MCP dans Paramètres → Intégrations. |
| **Ollama première classe** *(v4.0)* | Auto-détection sur `localhost:11434`. Trois presets de modèles (`qwen2.5:1.5b/7b/14b`). Alias de recipe `provider: local` pour boucles autonomes sans coût cloud. |
| **Réécriture IA, BYOK** | 14 providers — OpenAI · Claude · Gemini · DeepSeek · Qwen · GLM · Kimi · Doubao · SiliconFlow · OpenRouter · Mistral · Groq · xAI · Ollama. Appels directs au vendeur. Clés dans le trousseau OS. |
| **Sync via GitHub** | Pousser votre vault vers un dépôt GitHub privé à chaque enregistrement. E2EE optionnel (Argon2id + XChaCha20-Poly1305). GitLab / Gitea / toute URL git HTTPS fonctionne aussi. |
| **AutoGit par note** | Chaque `⌘S` est un commit dans un `.git` local à l'intérieur du workspace. libgit2 vendorisé, pas de git système nécessaire. Jamais auto-poussé. |
| **Serveur MCP empaqueté** | `solomd-mcp` est livré dans l'installation. 13 outils (8 génériques + 5 spécifiques à SoloMD). Stdio uniquement, pas de port réseau. Lecture seule par défaut ; `--allow-write` opt-in. |
| **API REST** *(v4.0)* | Localhost uniquement, auth par token. Même surface que MCP pour les clients qui ne parlent pas encore MCP — Alfred / Raycast / n8n / vos propres scripts. |
| **Compteur de coûts BYOK** *(v4.0)* | Compteur de tokens dépensés par provider, opt-in. Paramètres → Intégrations. |
| **Mode dossier cloud** | Si votre vault vit dans `~/Library/Mobile Documents/...` ou `~/Dropbox/...`, SoloMD le détecte et ajoute la restauration de session multi-appareils par-dessus — l'OS fait déjà la sync de fichiers. |
| **Partage public en lecture seule** | Palette de commandes → copier le lien `solomd.app/share/?repo=...&path=...`. Rend n'importe quel fichier de votre dépôt GitHub public, pas besoin de compte SoloMD pour visualiser. |

## Utilisation

Après installation de SoloMD sur macOS / Linux :

**1. Discuter avec votre vault.** Ouvrir le panneau Agent à droite (⌘⇧P → « View: Toggle Agent Panel » s'il est masqué). Multi-tour streamé contre vos notes ; les cartes d'appels d'outil affichent chaque lecture/écriture inline. Réponse trop longue ? **Insérer** la dépose à la position du curseur dans la note active (remplace la sélection) ; **Copier** vers le presse-papiers.

**2. Planifier un recipe.** Paramètres → Recipes → Parcourir le cookbook. 11 starters prêts : revue hebdomadaire, résumé quotidien, extraction TODO, passe de traduction, nettoyage de citations, agent de relecture CJK, détecteur de link rot, normaliseur de frontmatter, outline-to-blog, passe de refactor, triage hebdomadaire des tags. En installer un, éditer le prompt, l'exécuter.

**3. Piloter le même vault depuis un autre client LLM.** One-shot :

```bash
# Imprimer le snippet de config MCP pour votre client IA.
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

Coller dans Claude Desktop / Cursor / etc. Pour la fédération multi-vault, répéter `--workspace` :

```json
"args": [
  "--workspace", "/Users/me/Documents/SoloMD",
  "--workspace", "/Users/me/Documents/work-notes"
]
```

**4. Ou passer un prompt directement à claude / codex CLI :**

```bash
solomd agent "réécrire cette semaine de notes quotidiennes en une revue hebdomadaire et la committer"
```

Path-traversal protégé. Pas de port réseau. Le LLM ne voit que ce vers quoi vous pointez le workspace.

## Installation

Dernière release : [**v4.0.0**](https://github.com/zhitongblog/solomd/releases/latest).

### macOS — universal dmg (Apple Silicon + Intel, signé + notarisé)

```bash
brew install --cask zhitongblog/solomd/solomd
```

Ou télécharger le dmg directement :

```
https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_universal.dmg
```

Ou installation shell en une ligne :

```bash
curl -fsSL https://solomd.app/install.sh | bash
```

### Windows — x64

- [`SoloMD_4.0.0_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64_en-US.msi)
- [`SoloMD_4.0.0_x64-setup.exe`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-setup.exe) (NSIS)
- [`SoloMD_4.0.0_x64-portable.zip`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-portable.zip) — sans installeur

```powershell
irm https://solomd.app/install.ps1 | iex
```

```powershell
winget install solomd
```

### Linux — x86_64 + aarch64

- `.AppImage` (universel), `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL) — les deux architectures depuis [la page des releases](https://github.com/zhitongblog/solomd/releases/latest).
- Utilisateurs Arch : [`solomd-bin`](https://aur.archlinux.org/packages/solomd-bin) sur AUR.

### iPad

[App Store](https://apps.apple.com/app/solomd/id6762498874) — même moteur, UI iPad native.

## Confidentialité & sécurité

Pur côté client. Vos fichiers `.md` restent dans le dossier que vous avez choisi. Les clés API vivent dans le trousseau OS (macOS Keychain / Windows Credential Manager / Linux libsecret), jamais dans `localStorage` ou un fichier de config. Les requêtes IA vont directement de votre machine au provider que vous avez choisi — pas de relais SoloMD. Les embeddings RAG et le dépôt AutoGit sont locaux uniquement. Le serveur MCP parle stdio, n'ouvre jamais de port réseau. Toute la base de code est MIT et auditable.

**Garde-fous d'agent (v4.0).** Chaque exécution de recipe démarre sur sa propre branche AutoGit — votre `main` reste intact jusqu'à ce que vous cliquiez Accepter sur le diff. Write-cap par exécution (par défaut 5, plafond dur 50) empêche les boucles incontrôlées. Le runner de recipe refuse de démarrer quand l'arbre de travail est dirty (aucun commit d'agent ne balaiera votre WIP). Les gardes path-traversal rejettent les segments `..` et chemins absolus en amont dans chaque endpoint Tauri / MCP / REST acceptant un chemin fourni par l'utilisateur.

La sync E2EE utilise Argon2id (paramètres par défaut RFC9106) → XChaCha20-Poly1305 avec nonces déterministes et chemin-comme-AAD. Le texte clair reste sur vos appareils ; le remote ne voit que du chiffré. L'échec du parsing de `sync.json` est fail-closed — refuse de pousser plutôt que de dégrader vers du texte clair (un fix d'audit v3.0.x).

Writeup complet : <https://solomd.app/security>.

## Compiler depuis les sources

Prérequis : Rust (stable), Node 18+, pnpm.

```bash
git clone https://github.com/zhitongblog/solomd.git
cd solomd/app
pnpm install
pnpm tauri dev      # dev avec hot reload
pnpm tauri build    # artefacts release → src-tauri/target/release/bundle/
```

Linux nécessite en plus `libdbus-1-dev` pour le backend du trousseau.

Le serveur MCP est une crate séparée à `mcp-server/` ; le harness MCP dev utilisé pour les tests end-to-end vit à `dev-mcp/`. Point d'entrée des tests end-to-end : `scripts/v4-self-test.sh` (lancer avec `--with-release --with-ollama --with-ui` pour couverture complète).

## Contribuer

Issues et PRs bienvenus — [en ouvrir une](https://github.com/zhitongblog/solomd/issues). Pour un sentiment de la direction, voir [`docs/roadmap.md`](docs/roadmap.md). Le log de build v4.0 est sur [solomd.app/blog/v4-0-0-how-we-built-it/](https://solomd.app/blog/v4-0-0-how-we-built-it/) — commencer là si vous voulez comprendre les principes d'ingénierie avant d'envoyer un PR.

## Contact

Un mainteneur, deux portes d'entrée. Asynchrone sur [GitHub Discussions](https://github.com/zhitongblog/solomd/discussions). Chat en temps réel :

- **Telegram (international) :** [@SOLOMDAPP](https://t.me/SOLOMDAPP) — annonces de release + chat
- **WeChat (中文) :** scanner pour m'ajouter — note "SoloMD"

## Licence & crédits

[MIT](LICENSE) © 2026 xiangdong li. SoloMD repose sur Tauri 2, Vue 3, CodeMirror 6, markdown-it, KaTeX, Mermaid, libgit2, Pandoc, Hunspell, `keyring-rs` et `rmcp`. Sponsoriser sur [GitHub Sponsors](https://github.com/sponsors/zhitongblog) ou via [solomd.app/#sponsor](https://solomd.app/#sponsor).
