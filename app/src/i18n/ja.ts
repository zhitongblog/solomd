/**
 * Japanese UI translation — scaffolding (v4.0).
 *
 * Re-exports `en` as a baseline so every key in the dictionary resolves to
 * something legible (the ad-hoc fallback in `i18n/index.ts` only kicks in
 * when the entire dictionary is missing, not per-key). Translated namespaces
 * progressively replace English over time.
 *
 * Translation status:
 *   - `wizard.*` / `cookbook.*` / `cost.*` / `rest.*`        → translated
 *   - everything else                                          → English fallback
 *
 * To translate a namespace, copy it from `en.ts`, drop the value strings
 * into Japanese, and merge into the spread below. Keep the keys identical
 * to `en.ts` — `t('foo.bar')` looks them up by literal path.
 */

import { en } from './en';

const overrides = {
  wizard: {
    close: '閉じる',
    chooseTitle: 'AI アシスタントを設定',
    chooseSub:
      'SoloMD は AI なしでも動作しますが、Agent パネルと Recipes はモデルが必要です。どちらか一方を選択してください — 後で 設定 → AI でいつでも変更できます。',
    cloudTitle: 'クラウド（BYOK）',
    cloudBody:
      'Anthropic Claude、OpenAI ChatGPT、Google Gemini、DeepSeek など 14 の Provider。自前の API キーをお使いください。',
    cloudMeta: '品質最高、従量課金。',
    cloudSub: 'Provider を選んで API キーを貼り付けてください。キーは OS のキーチェーンに保存されます。',
    localTitle: 'ローカル（Ollama）',
    localBody: '小さめのモデルをマシン上で実行。メモは端末から一切出ません。',
    localMeta: '最高のプライバシー、完全無料。',
    localDetected: 'このマシン上で Ollama を検出しました',
    localDetecting: '稼働中の Ollama サーバーを探しています…',
    localNotRunning: 'localhost:11434 で Ollama サーバーが見つかりません。',
    localNotRunningHint:
      'Ollama（約 80 MB）をインストールして起動してから「再試行」を押してください。SoloMD は Ollama を同梱しません。',
    localInstallBtn: 'Ollama をインストール',
    localRetryBtn: '再試行',
    localRunningNoModel:
      'Ollama は {url} で稼働中ですが、まだモデルが取得されていません。',
    localPullHint:
      'おすすめの初心者向けモデル（qwen2.5:1.5b、約 1 GB）を取得します。一回限りのダウンロード。',
    localPullBtn: 'qwen2.5:1.5b（約 1 GB）を取得',
    localPullingPct: '取得中… {pct}%',
    localReady: '✓ {url} に {n} 個のモデルがインストール済み。',
    localUseFirst: '最初のモデルを使用',
    providerLabel: 'Provider',
    keyLabel: 'API キー',
    keyPlaceholder: 'sk-…',
    cloudHint:
      'キーは OS のキーチェーン（macOS Keychain / Windows Credential Manager / libsecret）に保存され、Provider を呼び出す時以外、マシンの外には出ません。',
    saveAndContinue: '保存して検証',
    verifying: '検証中…',
    verifyOk: '✓ 接続を確認しました',
    errKeyEmpty: 'まず API キーを貼り付けてください。',
    back: '戻る',
    skip: '後で設定する',
    doneTitle: '設定完了。',
    doneSub: '右サイドの Agent パネルが利用可能になりました。',
    doneNext1: '右サイドバー（または ⌘⇧A）から Agent パネルを開きます。',
    doneNext2: '設定 → Recipes でサンプル Recipe を試してください — 10 個用意されています。',
    doneNext3: 'docs/agents.md を読んで自分の Recipe を作る方法を学びましょう。',
    doneClose: 'わかりました',
    ollamaPullDone: 'モデル取得完了 — Ollama 利用可能。',
    reopenBtn: 'セットアップウィザードを再実行',
  },
  cookbook: {
    heading: 'Recipe クックブック',
    intro:
      'スターター Recipe を選んでください — インストールすると YAML が .solomd/agents/ にコピーされ、編集用に開きます。何度でもインストール可能で、自動的にサフィックスが追加されます。',
    browse: 'クックブックを参照',
    preview: 'YAML をプレビュー',
    hidePreview: 'プレビューを非表示',
    install: 'インストール',
    installing: 'インストール中…',
    installedToast: 'インストール完了：{name}',
  },
  cost: {
    heading: 'BYOK コストメーター',
    enable: 'Provider ごとの利用額を記録',
    hint:
      'デフォルトはオフ。オンにすると、成功した Agent の各実行（パネルチャット / 定時 Recipe）が provider 別のトークン / コスト台帳に集計され、他のアプリ設定の隣に保存されます。',
    enabled: 'コストメーターを有効化 — 累計が今後加算されます',
    disabled: 'コストメーターを無効化 — 新しい記録は行われません',
    since: '集計開始：{ts}',
    refresh: '更新',
    reset: 'リセット',
    resetDone: 'コストメーターをリセットしました',
    provider: 'Provider',
    runs: '実行回数',
    input: '入力',
    output: '出力',
    cost: '推定費用',
    total: '合計',
    empty: 'まだ記録がありません — パネルチャットを試すか Recipe を実行してみてください。',
  },
  rest: {
    heading: '公開 REST API',
    intro:
      'MCP と同じ vault ツールを公開する localhost 専用の HTTP サーフェス。Alfred、Raycast、n8n、シェル、iOS ショートカットなど、MCP を話さないクライアントに便利。',
    enable: 'REST API を有効化',
    enableHint:
      'デフォルトはオフ。オンにすると SoloMD は 127.0.0.1（ループバックのみ）でリッスンします。公開バナー以外のすべてのルートは下記の Bearer トークンが必要です。',
    endpoint: 'エンドポイント',
    statusRunning: '稼働中',
    statusStarting: '起動中…',
    token: 'トークン',
    tokenMissing: '（未生成）',
    tokenShow: '表示',
    tokenHide: '非表示',
    tokenCopy: 'コピー',
    tokenRegenerate: '再生成',
    tokenCopied: 'トークンをクリップボードにコピーしました',
    tokenRegenerated: '新しいトークンを生成しました — 旧トークンは即座に無効です',
    allowWrite: '書き込みツールを許可（write_note / append_to_note）',
    allowWriteHint:
      'デフォルトはオフ。読み取り系ツール（list_notes / read_note / search …）は常に利用可能；オンにすると外部クライアントが API 経由でメモを作成・編集できるようになります。',
    allowWriteOn: '書き込みツール有効化 — 外部クライアントがメモを変更できます',
    allowWriteOff: '書き込みツール無効化 — 読み取り専用',
    curlExample: 'ターミナルで試す',
    curlCopy: 'コピー',
    curlCopied: 'スニペットをクリップボードにコピーしました',
    endpointEnabled: 'REST API が 127.0.0.1:{port} でリッスン中',
    endpointDisabled: 'REST API を停止しました',
  },
};

/**
 * Final dictionary — English baseline merged with Japanese overrides.
 * Pinia / Vue reactivity reads `dicts[lang]`, so we materialize the merged
 * object at module-eval time rather than computing per-key.
 */
export const ja = {
  ...en,
  ...overrides,
};
