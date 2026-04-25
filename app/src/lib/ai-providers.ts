/**
 * Provider + action catalog for v2.0 F4 (inline AI rewrite, BYOK).
 *
 * `PROVIDERS` defines the three options the user can pick in settings; each
 * carries a sensible default model and (where relevant) a default base URL.
 * Actual API keys are stored in the OS keychain (see `ai_proxy.rs`), never
 * here.
 *
 * `ACTIONS` defines the prompt presets shown in the AI Rewrite overlay. Each
 * action ships a system + user prompt; the user's selected text is appended
 * by the Rust side as `Text:\n<selection>`.
 */

/**
 * Stable id used as the keychain slot key. Each id gets its own slot so
 * users can keep multiple provider keys at once. Many CN/US vendors share
 * the OpenAI Chat Completions wire format — they're separate entries here
 * so users can pick by brand without manually setting a base URL.
 */
export type ProviderId =
  // US
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'xai'
  | 'mistral'
  | 'groq'
  // CN
  | 'deepseek'
  | 'qwen'
  | 'glm'
  | 'kimi'
  | 'volcengine'
  | 'siliconflow'
  // Local
  | 'ollama';

/** Wire format the Rust proxy uses to talk to the provider. */
export type ApiFormat = 'openai' | 'anthropic' | 'ollama';

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  /** OpenAI / Anthropic / Ollama wire format. Most providers below speak
   *  the OpenAI Chat Completions format. */
  apiFormat: ApiFormat;
  /** Default model name shown in settings + used if user leaves the field empty. */
  defaultModel: string;
  /** Default endpoint; user may override. */
  defaultBaseUrl?: string;
  /** Examples shown under the model input — surfaces the standard / coder /
   *  reasoner model names without forcing separate dropdown entries. */
  modelHint?: string;
  /** Where to get an API key (button-link in settings). */
  signupUrl?: string;
}

export const PROVIDERS: ProviderConfig[] = [
  // ---- US providers --------------------------------------------------
  {
    id: 'openai',
    label: 'OpenAI',
    apiFormat: 'openai',
    defaultModel: 'gpt-4.1-mini',
    defaultBaseUrl: 'https://api.openai.com',
    modelHint: 'gpt-4.1-mini · gpt-4.1 · o4-mini · gpt-4o-mini',
    signupUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    apiFormat: 'anthropic',
    defaultModel: 'claude-haiku-4-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    modelHint: 'claude-opus-4-5 · claude-sonnet-4-5 · claude-haiku-4-5',
    signupUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    apiFormat: 'openai',
    defaultModel: 'gemini-2.0-flash',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelHint: 'gemini-2.5-pro · gemini-2.0-flash · gemini-2.0-flash-thinking',
    signupUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    apiFormat: 'openai',
    defaultModel: 'grok-3',
    defaultBaseUrl: 'https://api.x.ai/v1',
    modelHint: 'grok-3 · grok-3-mini · grok-2-vision',
    signupUrl: 'https://console.x.ai',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    apiFormat: 'openai',
    defaultModel: 'mistral-small-latest',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    modelHint: 'mistral-large-latest · mistral-small-latest · codestral-latest',
    signupUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'groq',
    label: 'Groq (fast inference)',
    apiFormat: 'openai',
    defaultModel: 'llama-3.3-70b-versatile',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    modelHint: 'llama-3.3-70b-versatile · qwen-2.5-32b · deepseek-r1-distill-llama-70b',
    signupUrl: 'https://console.groq.com/keys',
  },
  // ---- CN providers --------------------------------------------------
  {
    id: 'deepseek',
    label: 'DeepSeek',
    apiFormat: 'openai',
    defaultModel: 'deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com',
    modelHint: '标准: deepseek-chat · 推理: deepseek-reasoner · 编码: deepseek-coder',
    signupUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'qwen',
    label: '通义千问 Qwen (DashScope)',
    apiFormat: 'openai',
    defaultModel: 'qwen-plus',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelHint:
      '标准: qwen-plus / qwen-max / qwen-turbo · 编码: qwen-coder-plus / qwen3-coder-plus · 推理: qwq-plus',
    signupUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    apiFormat: 'openai',
    defaultModel: 'glm-4-plus',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelHint: '标准: glm-4-plus / glm-4-air · 推理: glm-zero-preview · 编码: codegeex-4',
    signupUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    id: 'kimi',
    label: 'Moonshot Kimi',
    apiFormat: 'openai',
    defaultModel: 'moonshot-v1-8k',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    modelHint: 'moonshot-v1-8k · moonshot-v1-32k · moonshot-v1-128k · kimi-latest',
    signupUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'volcengine',
    label: '火山方舟 / 豆包 (Volcengine ARK)',
    apiFormat: 'openai',
    defaultModel: 'doubao-1-5-pro-32k',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelHint:
      '标准: doubao-1-5-pro-32k / doubao-1-5-lite · 编码: doubao-pro-coder · 推理: doubao-1-5-thinking-pro',
    signupUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    apiFormat: 'openai',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    modelHint:
      '托管多家开源模型: Qwen/Qwen2.5-* · deepseek-ai/DeepSeek-V3 · meta-llama/Meta-Llama-3.1-* 等',
    signupUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  // ---- Local ---------------------------------------------------------
  {
    id: 'ollama',
    label: 'Ollama (本地 / local)',
    apiFormat: 'ollama',
    defaultModel: 'llama3.2',
    defaultBaseUrl: 'http://localhost:11434',
    modelHint: 'llama3.2 · qwen2.5 · deepseek-r1 · gemma3 (任何 ollama pull 拉过的模型)',
  },
];

export function providerById(id: string): ProviderConfig | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export interface AIAction {
  /** Stable id used by the overlay to switch + remember last action. */
  id: string;
  /** i18n key (under the `ai.*` namespace, e.g. `ai.rewrite`). */
  labelKey: string;
  /** System prompt — sets the assistant's role / output rules. */
  system: string;
  /** User instruction — selection is appended as `\n\nText:\n<selection>`. */
  user: string;
  /** Whether the action needs a free-form prompt the user types in. */
  custom?: boolean;
}

const EDITOR_ROLE =
  'You are an expert editor. Reply with only the rewritten text — no preamble, no explanations, no markdown fences.';

const TRANSLATOR_ROLE =
  'You are a professional translator. Reply with only the translated text — preserve markdown formatting, links, and code blocks. No preamble.';

const EXPLAINER_ROLE =
  'You are a knowledgeable tutor. Explain the given text clearly and concisely. Use plain prose; no markdown headings.';

export const ACTIONS: AIAction[] = [
  {
    id: 'rewrite',
    labelKey: 'ai.rewrite',
    system: EDITOR_ROLE,
    user: 'Rewrite the following text to improve clarity and flow while keeping the meaning and tone. Reply with only the rewritten text.',
  },
  {
    id: 'shorten',
    labelKey: 'ai.shorten',
    system: EDITOR_ROLE,
    user: 'Rewrite the following text in fewer words while keeping the meaning. Reply with only the rewritten text, no preamble.',
  },
  {
    id: 'expand',
    labelKey: 'ai.expand',
    system: EDITOR_ROLE,
    user: 'Expand the following text with more detail and context while keeping the original tone. Reply with only the expanded text.',
  },
  {
    id: 'translateEn',
    labelKey: 'ai.translateEn',
    system: TRANSLATOR_ROLE,
    user: 'Translate the following text to natural, idiomatic English. Reply with only the translation.',
  },
  {
    id: 'translateZh',
    labelKey: 'ai.translateZh',
    system: TRANSLATOR_ROLE,
    user: '把下面这段文字翻译成自然、流畅的中文。只回复译文,不要其他说明。',
  },
  {
    id: 'explain',
    labelKey: 'ai.explain',
    system: EXPLAINER_ROLE,
    user: 'Explain the following text in plain language for a general reader. Reply with only the explanation.',
  },
  {
    id: 'custom',
    labelKey: 'ai.custom',
    system: EDITOR_ROLE,
    // For custom prompts the overlay replaces this with whatever the user typed.
    user: '',
    custom: true,
  },
];

export function actionById(id: string): AIAction | undefined {
  return ACTIONS.find((a) => a.id === id);
}
