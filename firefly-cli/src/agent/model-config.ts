export const MODEL_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'google',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'ollama',
] as const;

export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];

export interface ModelConfig {
  provider: ModelProviderId;
  model: string;
  apiToken: string;
  apiUrl?: string;
  accountId?: string;
  gatewayId?: string;
}

export function isModelProviderId(value: unknown): value is ModelProviderId {
  return typeof value === 'string' && MODEL_PROVIDER_IDS.includes(value as ModelProviderId);
}
