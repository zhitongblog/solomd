/**
 * Korean UI translation — scaffolding (v4.0).
 *
 * Re-exports `en` as a baseline so every dictionary key resolves. Translated
 * namespaces progressively replace English over time.
 *
 * Translation status:
 *   - `wizard.*` / `cookbook.*` / `cost.*` / `rest.*`        → translated
 *   - everything else                                          → English fallback
 */

import { en } from './en';

const overrides = {
  wizard: {
    close: '닫기',
    chooseTitle: 'AI 어시스턴트 설정',
    chooseSub:
      'SoloMD는 AI 없이도 동작하지만, Agent 패널과 Recipes는 모델이 필요합니다. 둘 중 하나를 고르세요 — 언제든지 설정 → AI에서 변경 가능.',
    cloudTitle: '클라우드(BYOK)',
    cloudBody:
      'Anthropic Claude, OpenAI ChatGPT, Google Gemini, DeepSeek 등 14개 Provider. 자신의 API 키 사용.',
    cloudMeta: '품질 최고, 사용량 과금.',
    cloudSub: 'Provider를 선택하고 API 키를 붙여넣으세요. 키는 OS 키체인에 저장됩니다.',
    localTitle: '로컬(Ollama)',
    localBody: '본인 컴퓨터에서 작은 모델 실행. 메모는 기기 밖으로 나가지 않습니다.',
    localMeta: '최고의 프라이버시, 무료.',
    localDetected: '이 기기에서 Ollama 감지됨',
    localDetecting: '실행 중인 Ollama 서버를 찾는 중…',
    localNotRunning: 'localhost:11434에서 Ollama 서버가 발견되지 않습니다.',
    localNotRunningHint:
      'Ollama(약 80 MB)를 설치하고 실행한 뒤 「재시도」를 눌러주세요. SoloMD는 Ollama를 동봉하지 않습니다.',
    localInstallBtn: 'Ollama 설치',
    localRetryBtn: '재시도',
    localRunningNoModel:
      'Ollama가 {url}에서 실행 중이지만 아직 모델이 받아지지 않았습니다.',
    localPullHint:
      '추천 시작 모델(qwen2.5:1.5b, 약 1 GB)을 받습니다. 일회성 다운로드.',
    localPullBtn: 'qwen2.5:1.5b(약 1 GB) 받기',
    localPullingPct: '받는 중… {pct}%',
    localReady: '✓ {url}에 {n}개의 모델 설치됨.',
    localUseFirst: '첫 번째 모델 사용',
    providerLabel: 'Provider',
    keyLabel: 'API 키',
    keyPlaceholder: 'sk-…',
    cloudHint:
      '키는 OS 키체인(macOS Keychain / Windows Credential Manager / libsecret)에 저장되며, Provider 호출 시 외에는 기기를 떠나지 않습니다.',
    saveAndContinue: '저장 및 검증',
    verifying: '검증 중…',
    verifyOk: '✓ 연결 확인됨',
    errKeyEmpty: '먼저 API 키를 붙여넣어 주세요.',
    back: '뒤로',
    skip: '나중에 설정하기',
    doneTitle: '설정이 완료되었습니다.',
    doneSub: '오른쪽 사이드의 Agent 패널이 활성화되었습니다.',
    doneNext1: '오른쪽 사이드바(또는 ⌘⇧A)에서 Agent 패널을 엽니다.',
    doneNext2: '설정 → Recipes에서 예시 Recipe를 시도해 보세요 — 10개의 템플릿이 준비되어 있습니다.',
    doneNext3: 'docs/agents.md를 읽고 자신만의 Recipe를 작성하세요.',
    doneClose: '확인',
    ollamaPullDone: '모델 다운로드 완료 — Ollama 사용 가능.',
    reopenBtn: '설정 마법사 다시 실행',
  },
  cookbook: {
    heading: 'Recipe 쿡북',
    intro:
      '시작 Recipe를 고르세요 — 설치하면 YAML이 .solomd/agents/에 복사되고 편집할 수 있도록 열립니다. 여러 번 설치 가능하며, 매번 자동으로 접미사가 붙습니다.',
    browse: '쿡북 둘러보기',
    preview: 'YAML 미리보기',
    hidePreview: '미리보기 숨기기',
    install: '설치',
    installing: '설치 중…',
    installedToast: '설치 완료: {name}',
  },
  cost: {
    heading: 'BYOK 비용 미터',
    enable: 'Provider별 사용액 추적',
    hint:
      '기본값은 꺼짐. 켜면 성공한 Agent의 매 실행(패널 채팅 / 정시 Recipe)이 provider별 토큰 / 비용 장부로 모이며, 다른 앱 설정 옆에 저장됩니다.',
    enabled: '비용 미터 활성화 — 누계가 이후 누적됩니다',
    disabled: '비용 미터 비활성화 — 새로운 기록이 저장되지 않습니다',
    since: '집계 시작: {ts}',
    refresh: '새로고침',
    reset: '초기화',
    resetDone: '비용 미터를 초기화했습니다',
    provider: 'Provider',
    runs: '실행 횟수',
    input: '입력',
    output: '출력',
    cost: '예상 비용',
    total: '합계',
    empty: '아직 기록이 없습니다 — 패널 채팅을 시도하거나 Recipe를 실행해 보세요.',
  },
  rest: {
    heading: '공개 REST API',
    intro:
      'MCP와 동일한 vault 도구를 노출하는 localhost 전용 HTTP 인터페이스. Alfred, Raycast, n8n, 셸, iOS 단축어 등 MCP를 말하지 않는 클라이언트에 유용.',
    enable: 'REST API 활성화',
    enableHint:
      '기본값은 꺼짐. 켜면 SoloMD가 127.0.0.1(루프백 전용)에서 수신 대기합니다. 공개 배너 외 모든 경로는 아래 Bearer 토큰이 필요합니다.',
    endpoint: '엔드포인트',
    statusRunning: '실행 중',
    statusStarting: '시작 중…',
    token: '토큰',
    tokenMissing: '(없음)',
    tokenShow: '보이기',
    tokenHide: '가리기',
    tokenCopy: '복사',
    tokenRegenerate: '재생성',
    tokenCopied: '토큰을 클립보드에 복사했습니다',
    tokenRegenerated: '새 토큰을 생성했습니다 — 기존 토큰은 즉시 무효',
    allowWrite: '쓰기 도구 허용(write_note / append_to_note)',
    allowWriteHint:
      '기본값은 꺼짐. 읽기 도구(list_notes / read_note / search …)는 항상 사용 가능. 켜면 외부 클라이언트가 API로 메모를 만들거나 수정할 수 있습니다.',
    allowWriteOn: '쓰기 도구 활성화 — 외부 클라이언트가 메모를 수정할 수 있습니다',
    allowWriteOff: '쓰기 도구 비활성화 — 읽기 전용',
    curlExample: '터미널에서 시도',
    curlCopy: '복사',
    curlCopied: '스니펫을 클립보드에 복사했습니다',
    endpointEnabled: 'REST API가 127.0.0.1:{port}에서 수신 중',
    endpointDisabled: 'REST API가 중지되었습니다',
  },
};

export const ko = {
  ...en,
  ...overrides,
};
