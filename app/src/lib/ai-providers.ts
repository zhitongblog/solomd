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

export type ProviderId = 'openai' | 'anthropic' | 'ollama';

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  /** Default model name shown in settings + used if user leaves the field empty. */
  defaultModel: string;
  /** Default endpoint; user may override (self-hosted OpenAI-compatible, custom Ollama port, etc.). */
  defaultBaseUrl?: string;
}

export const PROVIDERS: ProviderConfig[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4.1-mini',
    defaultBaseUrl: 'https://api.openai.com',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    defaultModel: 'claude-haiku-4-5',
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    defaultModel: 'llama3.2',
    defaultBaseUrl: 'http://localhost:11434',
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
