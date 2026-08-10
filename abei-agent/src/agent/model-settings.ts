/**
 * 模型连接设置：解析页面提交的连接参数、按用户取运行时、汇报当前状态。
 *
 * 用户自己存的配置优先，没存就回落到环境变量。运行时按 ownerKey 缓存，
 * 配置一改就把缓存那条踢掉。
 */

import { HttpError } from './http-error.js';
import { isModelProviderId, type ModelConfig } from './model-config.js';
import { createModelRuntime, type ModelRuntime } from './model-runtime.js';
import type { AiStore } from './store.js';

/** 取这个用户的模型运行时。存过配置就用存的，否则用环境变量那套。 */
export async function runtimeForOwner(args: {
  ownerKey: string;
  saved?: ModelConfig;
  store: Pick<AiStore, 'getModelConfig'>;
  env: NodeJS.ProcessEnv;
  environmentRuntime: ModelRuntime;
  runtimeCache: Map<string, ModelRuntime>;
}): Promise<ModelRuntime> {
  const cached = args.runtimeCache.get(args.ownerKey);
  if (cached) return cached;
  const saved = args.saved ?? (await args.store.getModelConfig(args.ownerKey));
  if (!saved) return args.environmentRuntime;
  const runtime = createModelRuntime(args.env, saved);
  args.runtimeCache.set(args.ownerKey, runtime);
  return runtime;
}

/** 设置页读的那份状态：配没配好、来源是哪、哪个模型、错在哪。 */
export async function modelConfigStatus(
  runtime: ModelRuntime,
  source: 'saved' | 'environment',
  config: ModelConfig | undefined,
  env: NodeJS.ProcessEnv,
) {
  const auth = runtime.model
    ? await runtime.models.checkAuth(runtime.provider).catch(() => undefined)
    : undefined;
  const environmentDetails: { apiUrl?: string; accountId?: string; gatewayId?: string } =
    source === 'environment' ? environmentConfigDetails(runtime.provider, env) : {};
  return {
    status: 'ok',
    configured: Boolean(runtime.model && auth),
    source,
    provider: runtime.provider,
    model: runtime.modelId,
    apiUrl: config?.apiUrl ?? environmentDetails.apiUrl,
    accountId: config?.accountId ?? environmentDetails.accountId,
    gatewayId: config?.gatewayId ?? environmentDetails.gatewayId,
    error: runtime.error ?? (!auth ? '模型凭证尚未配置。' : undefined),
  };
}

function environmentConfigDetails(provider: string, env: NodeJS.ProcessEnv) {
  return {
    apiUrl:
      provider === 'openai'
        ? env.OPENAI_BASE_URL
        : provider === 'anthropic'
          ? env.ANTHROPIC_BASE_URL
          : provider === 'google'
            ? env.GEMINI_BASE_URL
            : provider === 'ollama'
              ? env.OLLAMA_BASE_URL
              : undefined,
    accountId: provider.startsWith('cloudflare-') ? env.CLOUDFLARE_ACCOUNT_ID : undefined,
    gatewayId: provider === 'cloudflare-ai-gateway' ? env.CLOUDFLARE_GATEWAY_ID : undefined,
  };
}

export function parseModelConfig(
  body: Record<string, unknown>,
  current?: ModelConfig,
  env?: NodeJS.ProcessEnv,
): ModelConfig {
  const model = requiredConfigString(body.model, '模型 ID', 200);
  return { ...parseModelConnection(body, current, env), model };
}

export function parseModelConnection(
  body: Record<string, unknown>,
  current?: ModelConfig,
  env?: NodeJS.ProcessEnv,
): Omit<ModelConfig, 'model'> {
  if (!isModelProviderId(body.provider)) throw new HttpError(422, '请选择支持的模型供应商。');
  const provider = body.provider;
  const submittedToken = optionalConfigString(body.apiToken, 'API Key', 8_192);
  const apiToken =
    submittedToken ||
    (current?.provider === provider
      ? current.apiToken
      : current
        ? undefined
        : environmentApiToken(provider, env)) ||
    '';
  if (provider !== 'ollama' && !apiToken) throw new HttpError(422, '请填写 API Key。');

  const apiUrl = optionalConfigString(body.apiUrl, '服务地址', 2_048);
  if (apiUrl) {
    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw new HttpError(422, '服务地址格式不正确。');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new HttpError(422, '服务地址只支持 HTTP 或 HTTPS。');
    }
  }
  if (provider === 'ollama' && !apiUrl) throw new HttpError(422, '请填写 Ollama 服务地址。');

  const accountId = optionalConfigString(body.accountId, 'Cloudflare Account ID', 200);
  const gatewayId = optionalConfigString(body.gatewayId, 'Cloudflare Gateway ID', 200);
  if (provider.startsWith('cloudflare-') && !accountId) {
    throw new HttpError(422, '请填写 Cloudflare Account ID。');
  }
  if (provider === 'cloudflare-ai-gateway' && !gatewayId) {
    throw new HttpError(422, '请填写 Cloudflare Gateway ID。');
  }

  return {
    provider,
    apiToken,
    ...(apiUrl ? { apiUrl: apiUrl.replace(/\/+$/, '') } : {}),
    ...(accountId ? { accountId } : {}),
    ...(gatewayId ? { gatewayId } : {}),
  };
}

function environmentApiToken(provider: string, env?: NodeJS.ProcessEnv): string | undefined {
  if (!env) return undefined;
  if (provider === 'openai') return env.OPENAI_API_KEY?.trim();
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY?.trim();
  if (provider === 'google') return env.GEMINI_API_KEY?.trim();
  if (provider.startsWith('cloudflare-')) return env.CLOUDFLARE_API_KEY?.trim();
  return undefined;
}

export function requiredConfigString(value: unknown, label: string, maxLength: number): string {
  const result = optionalConfigString(value, label, maxLength);
  if (!result) throw new HttpError(422, `请填写${label}。`);
  return result;
}

export function optionalConfigString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new HttpError(422, `${label}格式不正确。`);
  const result = value.trim();
  if (result.length > maxLength) throw new HttpError(422, `${label}过长。`);
  return result || undefined;
}
