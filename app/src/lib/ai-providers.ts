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
  // Aggregator
  | 'openrouter'
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
    defaultModel: 'gpt-5.5',
    defaultBaseUrl: 'https://api.openai.com/v1',
    modelHint: 'gpt-5.5 · gpt-5.5-pro · gpt-5.4 · gpt-5.4-mini · gpt-5.4-nano',
    signupUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    apiFormat: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    defaultBaseUrl: 'https://api.anthropic.com',
    modelHint: 'claude-opus-4-7 · claude-sonnet-4-6 · claude-haiku-4-5',
    signupUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    apiFormat: 'openai',
    defaultModel: 'gemini-3.1-pro-preview',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelHint:
      'gemini-3.1-pro-preview · gemini-3-flash-preview · gemini-2.5-flash · gemini-3.1-flash-lite-preview · gemini-2.0-flash',
    signupUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    apiFormat: 'openai',
    defaultModel: 'grok-4.20',
    defaultBaseUrl: 'https://api.x.ai/v1',
    modelHint:
      'grok-4.20 · grok-4-fast-reasoning · grok-4-1-fast-reasoning · grok-4-1-fast-non-reasoning · grok-code-fast-1',
    signupUrl: 'https://console.x.ai',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    apiFormat: 'openai',
    defaultModel: 'mistral-large-3',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    modelHint:
      'mistral-large-3 · mistral-medium-3.1 · mistral-small-4 · magistral-medium-1.2 · devstral-2 · codestral',
    signupUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'groq',
    label: 'Groq (fast inference)',
    apiFormat: 'openai',
    defaultModel: 'llama-3.3-70b-versatile',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    modelHint:
      'llama-3.3-70b-versatile · meta-llama/llama-4-scout-17b-16e-instruct · openai/gpt-oss-120b · qwen/qwen3-32b · groq/compound · groq/compound-mini',
    signupUrl: 'https://console.groq.com/keys',
  },
  // ---- CN providers --------------------------------------------------
  {
    id: 'deepseek',
    label: 'DeepSeek',
    apiFormat: 'openai',
    defaultModel: 'deepseek-v4-flash',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    modelHint:
      'deepseek-v4-pro · deepseek-v4-flash · deepseek-chat (legacy) · deepseek-reasoner (legacy)',
    signupUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'qwen',
    label: '通义千问 Qwen (DashScope)',
    apiFormat: 'openai',
    defaultModel: 'qwen-plus',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelHint:
      'qwen3-max · qwen3.5-plus · qwen-plus · qwen-flash · qwen3-coder-plus · qwen3-coder-flash · qwq-plus · qvq-max · qwen3-vl-plus',
    signupUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    apiFormat: 'openai',
    defaultModel: 'glm-4.6',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelHint:
      'glm-5.1 · glm-5 · glm-5-turbo · glm-4.7 · glm-4.6 · glm-4.7-flashx · glm-4.5-air · glm-5v-turbo · codegeex-4',
    signupUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    id: 'kimi',
    label: 'Moonshot Kimi',
    apiFormat: 'openai',
    defaultModel: 'kimi-k2-0905-preview',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    modelHint:
      'kimi-k2-0905-preview · kimi-k2-turbo-preview · kimi-k2-thinking · kimi-latest · moonshot-v1-128k',
    signupUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'volcengine',
    label: '火山方舟 / 豆包 (Volcengine ARK)',
    apiFormat: 'openai',
    defaultModel: 'doubao-seed-1.6',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelHint:
      'doubao-seed-1.6 · doubao-seed-1.6-lite · doubao-seed-1.6-flash · doubao-seed-1.6-thinking · doubao-seed-1.6-vision · doubao-1-5-pro-32k',
    signupUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    apiFormat: 'openai',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    modelHint:
      'deepseek-ai/DeepSeek-V3 · Qwen/Qwen2.5-Coder-32B-Instruct · moonshotai/Kimi-K2-Instruct · meta-llama/Meta-Llama-3.1-70B-Instruct',
    signupUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  // ---- Aggregator (one key, hundreds of models) ---------------------
  {
    id: 'openrouter',
    label: 'OpenRouter (聚合,400+ 模型)',
    apiFormat: 'openai',
    defaultModel: 'anthropic/claude-sonnet-4-6',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    modelHint:
      'anthropic/claude-sonnet-4-6 · openai/gpt-5.5 · google/gemini-3.1-pro · deepseek/deepseek-v4 · x-ai/grok-4.20 · meta-llama/llama-4-scout',
    signupUrl: 'https://openrouter.ai/keys',
  },
  // ---- Local ---------------------------------------------------------
  {
    id: 'ollama',
    label: 'Ollama (本地 / local)',
    apiFormat: 'ollama',
    defaultModel: 'llama3.2',
    defaultBaseUrl: 'http://localhost:11434',
    modelHint: 'llama3.2 · qwen2.5 · deepseek-r1 · gemma3 · mistral · phi3',
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
