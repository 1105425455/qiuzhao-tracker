// Optional model presets. Each entry names the API shape that model expects:
//  - "anthropic": POST {baseUrl}/messages with x-api-key + anthropic-version
//  - "openai"   : POST {baseUrl}/chat/completions with Bearer token
// Users can pick any of these; no key change is required between them.
export const MODEL_CATALOG = [
  { id: 'gpt-4.1', label: 'GPT-4.1', api: 'openai', vision: true },
  { id: 'claude-opus-5', label: 'Claude Opus 5', api: 'anthropic', vision: true },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', api: 'openai', vision: true },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', api: 'anthropic', vision: true }
];

export function apiForModel(model, override) {
  if (override && ['anthropic', 'openai'].includes(override)) return override;
  const found = MODEL_CATALOG.find(item => item.id === model);
  if (found) return found.api;
  // Unknown custom id: anthropic style if it looks like a Claude model, else OpenAI.
  return /claude/i.test(model) ? 'anthropic' : 'openai';
}

export function labelForModel(model) {
  return MODEL_CATALOG.find(item => item.id === model)?.label || model;
}
