import type { ModelConfig } from './model-config.js';

type ModelDiscoveryConfig = Omit<ModelConfig, 'model'>;

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class ModelDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelDiscoveryError';
  }
}

export async function discoverModels(config: ModelDiscoveryConfig): Promise<string[]> {
  switch (config.provider) {
    case 'openai':
      return openAiModels(config.apiUrl ?? 'https://api.openai.com/v1', config.apiToken);
    case 'anthropic':
      return anthropicModels(config.apiUrl, config.apiToken);
    case 'google':
      return googleModels(config.apiUrl, config.apiToken);
    case 'cloudflare-ai-gateway':
      return openAiModels(
        `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(config.accountId ?? '')}/${encodeURIComponent(config.gatewayId ?? '')}/compat`,
        config.apiToken,
      );
    case 'cloudflare-workers-ai':
      return cloudflareWorkersModels(config.accountId ?? '', config.apiToken);
    case 'ollama':
      return openAiModels(config.apiUrl ?? 'http://127.0.0.1:11434/v1', config.apiToken);
  }
}

async function openAiModels(baseUrl: string, apiToken: string): Promise<string[]> {
  const body = await fetchJson(modelsUrl(baseUrl), {
    headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
  });
  return modelIds(recordArray(body, 'data'));
}

async function anthropicModels(apiUrl: string | undefined, apiToken: string): Promise<string[]> {
  const baseUrl = apiUrl ?? 'https://api.anthropic.com/v1';
  const url = modelsUrl(apiUrl && !/\/v\d+(?:beta)?\/?$/i.test(apiUrl) ? `${apiUrl}/v1` : baseUrl);
  url.searchParams.set('limit', '1000');
  const body = await fetchJson(url, {
    headers: {
      'anthropic-version': '2023-06-01',
      'x-api-key': apiToken,
    },
  });
  return modelIds(recordArray(body, 'data'));
}

async function googleModels(apiUrl: string | undefined, apiToken: string): Promise<string[]> {
  const url = modelsUrl(apiUrl ?? 'https://generativelanguage.googleapis.com/v1beta');
  url.searchParams.set('key', apiToken);
  url.searchParams.set('pageSize', '1000');
  const body = await fetchJson(url);
  return modelIds(recordArray(body, 'models'), true);
}

async function cloudflareWorkersModels(accountId: string, apiToken: string): Promise<string[]> {
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search`,
  );
  url.searchParams.set('per_page', '1000');
  const body = await fetchJson(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  return modelIds(recordArray(body, 'result'));
}

function modelsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  return url;
}

async function fetchJson(url: URL, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ModelDiscoveryError('无法连接上游模型接口。');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ModelDiscoveryError('上游拒绝了模型凭证。');
    }
    if (response.status === 404) {
      throw new ModelDiscoveryError('上游没有提供模型列表接口。');
    }
    throw new ModelDiscoveryError(`上游模型接口返回 ${response.status}。`);
  }

  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) {
    throw new ModelDiscoveryError('上游返回的模型列表过大。');
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ModelDiscoveryError('上游返回的模型列表格式不正确。');
  }
}

function recordArray(value: unknown, key: string): unknown[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const result = (value as Record<string, unknown>)[key];
  return Array.isArray(result) ? result : [];
}

function modelIds(items: unknown[], stripGooglePrefix = false): string[] {
  const ids = items.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const id =
      typeof record.id === 'string'
        ? record.id
        : typeof record.name === 'string'
          ? record.name
          : undefined;
    return id ? [stripGooglePrefix ? id.replace(/^models\//, '') : id] : [];
  });
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .slice(0, 2_000);
}
