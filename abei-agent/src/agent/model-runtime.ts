import {
  createModels,
  createProvider,
  type Api,
  type Credential,
  type CredentialStore,
  type Model,
  type Models,
  type Provider,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { cloudflareAIGatewayProvider } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway';
import { cloudflareWorkersAIProvider } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

import type { ModelConfig } from './model-config.js';

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-5.4-mini',
  anthropic: 'claude-sonnet-4-6',
  google: 'gemini-2.5-flash',
  'cloudflare-ai-gateway': 'gpt-5.4',
  'cloudflare-workers-ai': '@cf/moonshotai/kimi-k2.6',
  ollama: 'qwen3:8b',
};

export interface ModelRuntime {
  models: Models;
  provider: string;
  modelId: string;
  model?: Model<Api>;
  error?: string;
}

export function createModelRuntime(
  env: NodeJS.ProcessEnv = process.env,
  config?: ModelConfig,
): ModelRuntime {
  const provider = config?.provider ?? env.AI_PROVIDER?.trim() ?? 'openai';
  const modelId = config?.model ?? env.AI_MODEL?.trim() ?? DEFAULT_MODELS[provider] ?? '';
  const apiUrl = config?.apiUrl ?? providerApiUrl(provider, env);
  const models = createModels({
    ...(config ? { credentials: configuredCredentialStore(config) } : {}),
    authContext: {
      env: async (name) => env[name],
      fileExists: async () => false,
    },
  });

  switch (provider) {
    case 'openai': {
      models.setProvider(configureProvider(openaiProvider(), modelId, apiUrl));
      break;
    }
    case 'anthropic':
      models.setProvider(configureProvider(anthropicProvider(), modelId, apiUrl));
      break;
    case 'google':
      models.setProvider(configureProvider(googleProvider(), modelId, apiUrl));
      break;
    case 'cloudflare-ai-gateway':
      models.setProvider(cloudflareAIGatewayProvider());
      break;
    case 'cloudflare-workers-ai':
      models.setProvider(configureProvider(cloudflareWorkersAIProvider(), modelId));
      break;
    case 'ollama':
      models.setProvider(ollamaProvider(modelId, apiUrl));
      break;
    default:
      return { models, provider, modelId, error: `Unsupported AI_PROVIDER: ${provider}` };
  }

  const model = models.getModel(provider, modelId);
  return {
    models,
    provider,
    modelId,
    model,
    error: model ? undefined : `Unknown model ${provider}/${modelId}.`,
  };
}

function configureProvider(
  provider: Provider,
  modelId: string,
  configuredBaseUrl?: string,
): Provider {
  const baseUrl = configuredBaseUrl?.trim().replace(/\/+$/, '');
  const catalog = provider.getModels().map((model) => (baseUrl ? { ...model, baseUrl } : model));
  if (!catalog.some((model) => model.id === modelId)) {
    const custom = customModel(provider.id, modelId, baseUrl);
    if (custom) catalog.push(custom);
  }
  return {
    ...provider,
    ...(baseUrl ? { baseUrl } : {}),
    getModels: () => catalog,
  };
}

function customModel(provider: string, modelId: string, baseUrl?: string): Model<Api> | undefined {
  const settings: Record<string, { api: Api; baseUrl: string }> = {
    openai: { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
    anthropic: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
    google: {
      api: 'google-generative-ai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    },
    'cloudflare-workers-ai': {
      api: 'openai-completions',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    },
  };
  const setting = settings[provider];
  if (!setting) return undefined;
  // ponytail: 未收录模型使用保守窗口；需要精确计费/上下文时把它加入 pi-ai 目录。
  return {
    id: modelId,
    name: modelId,
    api: setting.api,
    provider,
    baseUrl: baseUrl ?? setting.baseUrl,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function providerApiUrl(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  if (provider === 'openai') return env.OPENAI_BASE_URL;
  if (provider === 'anthropic') return env.ANTHROPIC_BASE_URL;
  if (provider === 'google') return env.GEMINI_BASE_URL;
  if (provider === 'ollama') return env.OLLAMA_BASE_URL;
  return undefined;
}

function configuredCredentialStore(config: ModelConfig): CredentialStore {
  let credential: Credential | undefined = {
    type: 'api_key',
    ...(config.apiToken ? { key: config.apiToken } : {}),
    ...(config.accountId || config.gatewayId
      ? {
          env: {
            ...(config.accountId ? { CLOUDFLARE_ACCOUNT_ID: config.accountId } : {}),
            ...(config.gatewayId ? { CLOUDFLARE_GATEWAY_ID: config.gatewayId } : {}),
          },
        }
      : {}),
  };
  return {
    read: async (providerId) => (providerId === config.provider ? credential : undefined),
    list: async () => (credential ? [{ providerId: config.provider, type: credential.type }] : []),
    modify: async (providerId, update) => {
      if (providerId !== config.provider) return undefined;
      credential = (await update(credential)) ?? credential;
      return credential;
    },
    delete: async (providerId) => {
      if (providerId === config.provider) credential = undefined;
    },
  };
}

function ollamaProvider(modelId: string, configuredBaseUrl?: string) {
  const baseUrl = (configuredBaseUrl?.trim() || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
  const model: Model<'openai-completions'> = {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'ollama',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  return createProvider({
    id: 'ollama',
    name: 'Ollama',
    baseUrl,
    auth: {
      apiKey: {
        name: 'Ollama',
        resolve: async ({ credential }) => ({
          auth: credential?.type === 'api_key' && credential.key ? { apiKey: credential.key } : {},
        }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });
}
