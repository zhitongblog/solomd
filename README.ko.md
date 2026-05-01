# SoloMD

> 마크다운 에디터이자, LLM으로 가는 다리.

[![Latest Release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)

🌐 **[English README →](README.md) · [中文 README →](README.zh.md)**

[**다운로드**](https://github.com/zhitongblog/solomd/releases/latest) · [**홈페이지**](https://solomd.app) · [**FAQ**](https://solomd.app#faq)

![SoloMD 에디터](web/public/demo/solomd-demo.svg)

당신의 메모는 하나의 폴더입니다. **SoloMD는 그 위에서 동작하는 에디터이자, Claude Code / Codex CLI / Cursor가 직접 호출할 수 있는 MCP 엔드포인트입니다.** 같은 `.md` 파일에 두 개의 입구.

Tauri 2 + Vue 3 + CodeMirror 6 기반. Mac universal dmg 약 32 MB. 무료 / MIT / 구독 없음 / SoloMD 서버 없음. 메모도, AI 키도, 임베딩 인덱스도, git 기록도 모두 사용자의 머신에 남습니다.

## 한 제품의 두 면

**에디터.** WYSIWYG 라이브 편집(Typora 스타일), 탭 + 분할, KaTeX + Mermaid, `_assets/` 자동 이미지 붙여넣기, 프레젠테이션 모드(`⌘⌥P`), Vim 모드, Hunspell + 중국어 교정, 시맨틱 검색(`⌘⇧F`), 위키링크 + 백링크, Pandoc 내보내기. CJK 인코딩(GBK / Big5 / Shift-JIS) 자동 인식.

**엔드포인트.** 동봉된 `solomd-mcp` 바이너리가 같은 vault를 임의의 MCP 클라이언트에 노출합니다 — 13개 도구(그중 5개는 SoloMD 전용: `autogit_log`, `autogit_diff`, `autogit_rollback`, `sync_status`, `share_url`). 추가로 `solomd agent <prompt>` CLI로 Claude Code / Codex CLI에 MCP가 미리 연결된 작업을 바로 넘길 수 있습니다.

## v4.0: "Agent 네이티브" 글쓰기 환경

외부 CLI 핸드오프가 아니라, **에디터 안에서 agent가 살게** 설계되었습니다:

- **인라인 Agent 패널** — 오른쪽 사이드에 agent와의 대화. 인용은 `[[note]]` 링크로 변환됩니다.
- **Recipes(정해진 시간 / 저장 시 / 커밋 시 / 태그 추가 시)** — `.solomd/agents/*.yml`로 선언, 야간 배치처럼 실행 가능. 쓰기는 AutoGit 브랜치에 격리 → 수락 / 거부를 UI에서 확인.
- **트레이스 뷰** — 모든 실행을 `trace.jsonl`로 완전 가시화, 임의의 단계에서 replay 가능.
- **워크스페이스 연합** — `solomd-mcp --workspace … --workspace …`로 여러 vault를 하나의 MCP 세션으로.
- **Ollama 일급 통합** — 자동 감지, 추천 모델 `qwen2.5:1.5b` 원클릭 다운로드, 로컬 LLM용 3개의 프리셋.
- **공개 REST API** — Alfred / Raycast / n8n / 셸 등 MCP를 말하지 않는 클라이언트도 같은 vault를 다룰 수 있게.
- **BYOK 비용 미터** — provider별 누적 토큰 / 비용 추적(옵트인).

자세한 내용은 `docs/agents.md`(Recipe 작성 가이드)와 `docs/roadmap.md`를 참고하세요.

## 라이선스

MIT. 자세한 내용은 `LICENSE`.

---

이 저장소의 영어 README에 기능 전체, 지원 플랫폼, 빌드 방법 등이 정리되어 있습니다. 한국어 README는 그 요약본입니다.
