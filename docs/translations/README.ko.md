# SoloMD

> Agent가 머무는 에디터.

[![Latest release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/zhitongblog/solomd/total)](https://github.com/zhitongblog/solomd/releases)
[![Website](https://img.shields.io/badge/website-solomd.app-ff9f40.svg)](https://solomd.app)

🌐 **[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Nederlands](README.nl.md) · [Türkçe](README.tr.md) · [Svenska](README.sv.md) · [Українська](README.uk.md)**

[**v4.0 다운로드**](https://github.com/zhitongblog/solomd/releases/latest) · [**런치 글**](https://solomd.app/ko/blog/) · [**웹사이트**](https://solomd.app/ko/) · [**보안**](https://solomd.app/ko/security/)

![SoloMD 에디터](web/public/demo/solomd-demo.svg)

당신의 노트는 폴더에 있습니다. **SoloMD는 그 위의 에디터 — 에디터 내부에 일등 시민 Agent 표면, 외부에서는 Claude Code / Cursor가 호출할 수 있는 MCP 엔드포인트.** 같은 `.md` 파일. vault와 채팅. 키보드 앞에 없을 때 실행되는 Recipe. 같은 vault를 어떤 MCP 클라이언트에든 넘길 수 있습니다.

Tauri 2 + Vue 3 + CodeMirror 6 위에 구축. Mac universal dmg는 약 32 MB. 무료, MIT, 구독 없음, SoloMD 호스팅 서버 없음. 노트, AI 키, 임베딩 인덱스, git 기록 모두 본인 머신에 남습니다.

## 한 제품의 세 반쪽

**에디터.** WYSIWYG 라이브 편집(Typora 스타일), 탭 + 분할 패널, KaTeX + Mermaid, `_assets/`로 이미지 붙여넣기, 슬라이드쇼 모드(`⌘⌥P`), Vim 모드, Hunspell + CJK 교정, 시맨틱 검색(`⌘⇧F`), wikilinks + backlinks, Pandoc 내보내기. CJK 인코딩(GBK / Big5 / Shift-JIS) 자동 감지.

**엔드포인트.** 동봉된 `solomd-mcp` 바이너리가 같은 vault를 어떤 MCP 클라이언트에든 노출 — 기본 13개 도구, 그중 5개는 SoloMD 전용(`autogit_log`, `autogit_diff`, `autogit_rollback`, `sync_status`, `share_url`)으로 다른 markdown 서버에는 없습니다. v4.0은 `--workspace path1 --workspace path2` federation 추가 — 한 MCP 세션, 여러 vault. 또한 `solomd agent <prompt>` CLI로 Claude Code / Codex CLI에 MCP 사전 연결로 핸드오프.

**Agent 표면 (v4.0).** 오른쪽 사이드 Agent 패널: 스트리밍 chat-with-vault, `[[wikilink]]` 인용, 도구 호출 카드가 인라인으로 펼쳐짐, **삽입** / **복사** 버튼으로 답변을 현재 노트에 반영. 또한 `<workspace>/.solomd/agents/*.yml`의 YAML로 선언적 **Recipe** — `cron` / `on-save` / `on-commit` / `on-tag-add` / 수동 트리거. **모든 agent 쓰기는 자체 AutoGit 브랜치에 착지**, `main`에 닿기 전에 승인 또는 거부; write-cap 기본 5; 워킹 트리가 더러우면 실행 거부; 각 실행마다 `trace.jsonl` 재생 가능, `read_agent_trace` MCP 도구 포함.

| 기능 | |
|---|---|
| **Agent 패널** *(v4.0)* | Outline / Backlinks / Tags / History와 같은 레벨의 스트리밍 chat-with-vault. 도구 카드가 인라인 펼쳐짐; 답변을 Insert / Copy로 현재 에디터에; 실행 기록은 `.solomd/agent-runs/`에 평범한 markdown으로 저장. |
| **정시 Recipe** *(v4.0)* | vault 내 YAML 작업. AutoGit 브랜치 샌드박스 + 승인/거부 UI로 병합 전 검토. 실행당 write-cap (기본 5, 하드 상한 50). 11개 Recipe 쿡북 동봉. |
| **재생 가능한 trace** *(v4.0)* | 단계마다 `trace.jsonl` (`prompt` / `model_call` / `tool_call` / `tool_result` / `git_commit`). 단계에서 재생으로 되돌리고 재실행. |
| **Workspace federation** *(v4.0)* | `solomd-mcp --workspace path1 --workspace path2`. 한 Claude Desktop 세션, 여러 vault. 설정 → 통합에 MCP 프로필 UI. |
| **Ollama 일등 시민** *(v4.0)* | `localhost:11434` 자동 감지. 3개 모델 프리셋 (`qwen2.5:1.5b/7b/14b`). `provider: local` Recipe 별칭으로 클라우드 비용 0의 자동 루프. |
| **AI 다시쓰기, BYOK** | 14 Provider — OpenAI · Claude · Gemini · DeepSeek · Qwen · GLM · Kimi · Doubao · SiliconFlow · OpenRouter · Mistral · Groq · xAI · Ollama. 벤더 직접 호출. 키는 OS 키체인에. |
| **GitHub 백업 동기화** | vault를 저장할 때마다 비공개 GitHub 저장소로 push. 선택적 E2EE (Argon2id + XChaCha20-Poly1305). GitLab / Gitea / 모든 HTTPS git URL도 동작. |
| **노트별 AutoGit** | 각 `⌘S`가 워크스페이스 안 로컬 `.git`의 커밋. libgit2 동봉, 시스템 git 불필요. 자동 push 안 함. |
| **MCP 서버 동봉** | `solomd-mcp`가 인스톨에 동봉. 13개 도구 (일반 8 + SoloMD 전용 5). stdio만, 네트워크 포트 없음. 기본 읽기 전용; `--allow-write` 옵트인. |
| **REST API** *(v4.0)* | localhost만, 토큰 인증. MCP와 동일한 표면, 아직 MCP를 말하지 않는 클라이언트용 — Alfred / Raycast / n8n / 자작 스크립트. |
| **BYOK 비용 미터** *(v4.0)* | Provider별 누적 토큰 사용량 카운터, 옵트인. 설정 → 통합. |
| **클라우드 폴더 모드** | vault가 `~/Library/Mobile Documents/...`나 `~/Dropbox/...` 안에 있다면, SoloMD가 감지하고 크로스 디바이스 세션 복원을 추가 — 파일 동기화는 OS가 이미 합니다. |
| **공개 읽기 전용 공유** | 명령 팔레트 → `solomd.app/share/?repo=...&path=...` 링크 복사. 공개 GitHub 저장소의 어떤 파일도 렌더링, 보기 위해 SoloMD 계정 불필요. |

## 사용법

macOS / Linux에 SoloMD 설치 후:

**1. vault와 채팅.** 오른쪽 사이드 Agent 패널 열기 (숨겨져 있으면 ⌘⇧P → "View: Toggle Agent Panel"). 노트에 대한 스트리밍 멀티턴; 도구 카드가 모든 읽기/쓰기를 인라인 표시. 답변이 너무 길다면? **삽입**으로 현재 노트의 커서 위치에 (선택 영역이 있으면 대체); **복사**로 클립보드에.

**2. Recipe 스케줄.** 설정 → Recipes → 쿡북 둘러보기. 11개 스타터: 주간 리뷰, 일일 요약, TODO 추출, 번역 패스, 인용 정리, CJK 교정 agent, 링크 부패 감지, frontmatter 정규화, 개요 → 블로그, 리팩토링 패스, 주간 태그 트리아지. 하나 설치, prompt 편집, 실행.

**3. 같은 vault를 다른 LLM 클라이언트에서 조작.** 원샷:

```bash
# AI 클라이언트용 MCP 설정 스니펫 출력.
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

Claude Desktop / Cursor 등에 붙여넣기. 다중 vault federation의 경우 `--workspace`를 반복:

```json
"args": [
  "--workspace", "/Users/me/Documents/SoloMD",
  "--workspace", "/Users/me/Documents/work-notes"
]
```

**4. 또는 claude / codex CLI에 직접 prompt 전달:**

```bash
solomd agent "이번 주 일일 노트를 주간 리뷰로 다시 써서 커밋해"
```

경로 트래버설 가드. 네트워크 포트 없음. LLM은 워크스페이스로 가리킨 것만 봅니다.

## 설치

최신 릴리스: [**v4.0.0**](https://github.com/zhitongblog/solomd/releases/latest).

### macOS — universal dmg (Apple Silicon + Intel, 서명 + notarize)

```bash
brew install --cask zhitongblog/solomd/solomd
```

또는 dmg 직접 다운로드:

```
https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_universal.dmg
```

또는 한 줄 셸 설치:

```bash
curl -fsSL https://solomd.app/install.sh | bash
```

### Windows — x64

- [`SoloMD_4.0.0_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64_en-US.msi)
- [`SoloMD_4.0.0_x64-setup.exe`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-setup.exe) (NSIS)
- [`SoloMD_4.0.0_x64-portable.zip`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-portable.zip) — 인스톨러 없음

```powershell
irm https://solomd.app/install.ps1 | iex
```

```powershell
winget install solomd
```

### Linux — x86_64 + aarch64

- `.AppImage` (유니버설), `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL) — 두 아키텍처를 [릴리스 페이지](https://github.com/zhitongblog/solomd/releases/latest)에서.
- Arch 사용자: AUR의 [`solomd-bin`](https://aur.archlinux.org/packages/solomd-bin).

### iPad

[App Store](https://apps.apple.com/app/solomd/id6762498874) — 같은 엔진, 네이티브 iPad UI.

## 개인 정보 & 보안

순수 클라이언트 사이드. `.md` 파일은 본인이 고른 폴더에 남습니다. API 키는 OS 키체인(macOS Keychain / Windows Credential Manager / Linux libsecret)에 살며, `localStorage`나 설정 파일에는 절대 들어가지 않습니다. AI 요청은 본인 머신에서 선택한 Provider로 직접 — SoloMD 릴레이 없음. RAG 임베딩과 AutoGit 저장소는 로컬 전용. MCP 서버는 stdio로 말하며 네트워크 포트를 열지 않습니다. 코드베이스 전체는 MIT이고 감사 가능.

**Agent 안전 가드 (v4.0).** 각 Recipe 실행은 자체 AutoGit 브랜치에서 시작 — diff에서 Accept를 클릭하기 전까지 `main`은 그대로. 실행당 write-cap (기본 5, 하드 상한 50)으로 폭주 루프 방지. Recipe 러너는 워킹 트리가 더러울 때 실행 거부 (agent 커밋이 당신의 WIP를 휩쓸지 않습니다). 경로 트래버설 가드는 `..` 세그먼트와 절대 경로를, 사용자 입력 경로를 받는 모든 Tauri / MCP / REST 엔드포인트에서 선제 거부.

E2EE 동기화는 Argon2id (RFC9106 기본 매개변수) → XChaCha20-Poly1305, 결정론적 nonce, 경로를 AAD로 사용. 평문은 본인 기기에 남고 원격은 암호문만 봅니다. `sync.json` 파싱 실패는 fail-closed — 평문 강등보다 push 거부 (v3.0.x 감사 수정).

자세한 내용: <https://solomd.app/ko/security/>.

## 소스에서 빌드

선행 조건: Rust (stable), Node 18+, pnpm.

```bash
git clone https://github.com/zhitongblog/solomd.git
cd solomd/app
pnpm install
pnpm tauri dev      # 핫 리로드 dev
pnpm tauri build    # 릴리스 산출물 → src-tauri/target/release/bundle/
```

Linux는 키체인 백엔드용으로 `libdbus-1-dev`도 필요.

MCP 서버는 `mcp-server/`의 별도 crate; 엔드투엔드 테스트용 dev MCP harness는 `dev-mcp/`에. 엔드투엔드 테스트 진입점: `scripts/v4-self-test.sh` (`--with-release --with-ollama --with-ui`로 전체 커버리지).

## 기여

Issue와 PR 환영 — [열어주세요](https://github.com/zhitongblog/solomd/issues). 방향성은 [`docs/roadmap.md`](docs/roadmap.md) 참조. v4.0 빌드 로그는 [solomd.app/blog/v4-0-0-how-we-built-it/](https://solomd.app/blog/v4-0-0-how-we-built-it/)에 — PR을 보내기 전에 엔지니어링 원칙을 이해하고 싶다면 거기서.

## 문의

메인테이너 1명, 입구 2개. 비동기는 [GitHub Discussions](https://github.com/zhitongblog/solomd/discussions). 실시간 채팅:

- **Telegram (국제):** [@SOLOMDAPP](https://t.me/SOLOMDAPP) — 릴리스 공지 + 채팅
- **WeChat (中文):** 친구 추가 스캔 — "SoloMD"라고 적어주세요

## 라이선스 & 크레딧

[MIT](LICENSE) © 2026 xiangdong li. SoloMD는 Tauri 2, Vue 3, CodeMirror 6, markdown-it, KaTeX, Mermaid, libgit2, Pandoc, Hunspell, `keyring-rs`, `rmcp` 위에 서 있습니다. [GitHub Sponsors](https://github.com/sponsors/zhitongblog) 또는 [solomd.app/#sponsor](https://solomd.app/#sponsor)에서 후원하세요.
