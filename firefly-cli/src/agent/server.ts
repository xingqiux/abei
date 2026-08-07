import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';

import {
  getCapability,
  validateCapabilityInput,
  validateCapabilityUserInput,
} from '../capabilities/registry.js';
import { FireflyHttpError } from '../core/errors.js';
import { FireflyHttpClient } from '../core/http-client.js';
import { isModelProviderId, type ModelConfig } from './model-config.js';
import { discoverModels, ModelDiscoveryError } from './model-discovery.js';
import { createModelRuntime, type ModelRuntime } from './model-runtime.js';
import { AiStore, createAiPool, type AiApproval } from './store.js';
import { createAgentTools } from './tools.js';

const SYSTEM_PROMPT = `你是 Abaku 的财务助手。你只处理当前用户的账本、账单收件箱和消费分析。

规则：
- 涉及真实数据时使用工具，不要猜数字、任务状态、分类或账户。
- 服务端已经判定为 duplicate、conflict 或 high-confidence crossSource 的行不要复核或修改。
- update_bill_row 和 split_bill_row 只修改待入账草稿；AI 修改会标为待确认建议。
- import_bill_task 永远先干跑，正式入账只能等待用户在界面确认。
- submit_bill_secret 只请求用户在受信界面输入密码；不要向用户索要密码文本，也不要让密码进入对话。
- 不声称自己能执行未提供的 shell、ffc api、删除、用户管理、配置或邮箱管理能力。
- 默认用简洁中文回答，清楚说明你查了什么、改了什么、还在等什么。`;

export interface AgentServerOptions {
  host?: string;
  port?: number;
  fireflyUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AgentServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startAgentServer(
  options: AgentServerOptions = {},
): Promise<AgentServerHandle> {
  const env = options.env ?? process.env;
  const host = options.host ?? env.AI_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(env.AI_PORT ?? 18003);
  const fireflyUrl = (options.fireflyUrl ?? env.FIREFLY_URL ?? 'http://127.0.0.1:18001').replace(
    /\/+$/,
    '',
  );
  const store = new AiStore(createAiPool(env), env.APP_KEY);
  await store.initialize();
  const environmentRuntime = createModelRuntime(env);
  const runtimeCache = new Map<string, ModelRuntime>();
  const activeSessions = new Set<string>();

  const server = createServer((request, response) => {
    void handleRequest({
      request,
      response,
      fireflyUrl,
      store,
      env,
      environmentRuntime,
      runtimeCache,
      activeSessions,
    }).catch((error) => respondError(response, error));
  });
  await listen(server, host, port);
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://${host}:${actualPort}`,
    async close() {
      await closeServer(server);
      await store.close();
    },
  };
}

export async function runAgentServer(options: AgentServerOptions = {}): Promise<void> {
  const handle = await startAgentServer(options);
  console.log(`Abaku agent listening on ${handle.url}`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await handle.close();
}

async function handleRequest(context: {
  request: IncomingMessage;
  response: ServerResponse;
  fireflyUrl: string;
  store: AiStore;
  env: NodeJS.ProcessEnv;
  environmentRuntime: ModelRuntime;
  runtimeCache: Map<string, ModelRuntime>;
  activeSessions: Set<string>;
}): Promise<void> {
  const {
    request,
    response,
    fireflyUrl,
    store,
    env,
    environmentRuntime,
    runtimeCache,
    activeSessions,
  } = context;
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/api/ai/health') {
    respondJson(response, 200, { status: 'ok' });
    return;
  }

  const token = bearerToken(request);
  const client = new FireflyHttpClient({ baseUrl: fireflyUrl, token });
  const ownerKey = await identifyOwner(client, fireflyUrl);

  if (request.method === 'POST' && url.pathname === '/api/ai/models') {
    const current = await store.getModelConfig(ownerKey);
    const config = parseModelConnection(await readJson(request, 16_384), current, env);
    try {
      respondJson(response, 200, { data: await discoverModels(config) });
    } catch (error) {
      if (error instanceof ModelDiscoveryError) throw new HttpError(502, error.message);
      throw error;
    }
    return;
  }

  if (url.pathname === '/api/ai/config') {
    if (request.method === 'GET') {
      const saved = await store.getModelConfig(ownerKey);
      const runtime = await runtimeForOwner({
        ownerKey,
        saved,
        store,
        env,
        environmentRuntime,
        runtimeCache,
      });
      respondJson(
        response,
        200,
        await modelConfigStatus(runtime, saved ? 'saved' : 'environment', saved, env),
      );
      return;
    }
    if (request.method === 'PUT') {
      const current = await store.getModelConfig(ownerKey);
      const config = parseModelConfig(await readJson(request, 16_384), current, env);
      const runtime = createModelRuntime(env, config);
      if (!runtime.model || runtime.error) {
        throw new HttpError(422, `模型 ${config.provider}/${config.model} 不可用。`);
      }
      if (!(await runtime.models.checkAuth(runtime.provider))) {
        throw new HttpError(422, '模型凭证字段不完整。');
      }
      await store.saveModelConfig(ownerKey, config);
      runtimeCache.set(ownerKey, runtime);
      respondJson(response, 200, await modelConfigStatus(runtime, 'saved', config, env));
      return;
    }
    if (request.method === 'DELETE') {
      await store.deleteModelConfig(ownerKey);
      runtimeCache.delete(ownerKey);
      respondJson(
        response,
        200,
        await modelConfigStatus(environmentRuntime, 'environment', undefined, env),
      );
      return;
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/ai/sessions') {
    respondJson(response, 200, { data: await store.listSessions(ownerKey) });
    return;
  }

  const sessionMatch =
    /^\/api\/ai\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
      url.pathname,
    );
  if (request.method === 'GET' && sessionMatch) {
    const session = await store.getSession(sessionMatch[1], ownerKey);
    if (!session) throw new HttpError(404, '会话不存在。');
    const [messages, approvals] = await Promise.all([
      store.loadMessages(session.id, ownerKey),
      store.listApprovals(session.id, ownerKey),
    ]);
    respondJson(response, 200, {
      data: {
        session,
        messages: displayMessages(messages),
        approvals,
      },
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/ai/chat') {
    const body = await readJson(request, 32_768);
    const runtime = await runtimeForOwner({
      ownerKey,
      store,
      env,
      environmentRuntime,
      runtimeCache,
    });
    await streamChat({
      response,
      body,
      client,
      ownerKey,
      store,
      runtime,
      activeSessions,
    });
    return;
  }

  const approvalMatch =
    /^\/api\/ai\/approvals\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
      url.pathname,
    );
  if (request.method === 'POST' && approvalMatch) {
    const body = await readJson(request, 4_096);
    const approval = await decideApproval({
      id: approvalMatch[1],
      body,
      client,
      ownerKey,
      store,
    });
    respondJson(response, 200, { data: approval });
    return;
  }

  throw new HttpError(404, '接口不存在。');
}

async function runtimeForOwner(args: {
  ownerKey: string;
  saved?: ModelConfig;
  store: AiStore;
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

async function modelConfigStatus(
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

function parseModelConfig(
  body: Record<string, unknown>,
  current?: ModelConfig,
  env?: NodeJS.ProcessEnv,
): ModelConfig {
  const model = requiredConfigString(body.model, '模型 ID', 200);
  return { ...parseModelConnection(body, current, env), model };
}

function parseModelConnection(
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

function requiredConfigString(value: unknown, label: string, maxLength: number): string {
  const result = optionalConfigString(value, label, maxLength);
  if (!result) throw new HttpError(422, `请填写${label}。`);
  return result;
}

function optionalConfigString(
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

async function streamChat(args: {
  response: ServerResponse;
  body: Record<string, unknown>;
  client: FireflyHttpClient;
  ownerKey: string;
  store: AiStore;
  runtime: ModelRuntime;
  activeSessions: Set<string>;
}): Promise<void> {
  const { response, body, client, ownerKey, store, runtime, activeSessions } = args;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 8_000) {
    throw new HttpError(422, '消息不能为空，且不能超过 8000 个字符。');
  }
  if (!runtime.model || runtime.error) throw new HttpError(503, runtime.error ?? '模型不可用。');
  if (!(await runtime.models.checkAuth(runtime.provider))) {
    throw new HttpError(503, `尚未配置 ${runtime.provider} 的模型凭证。`);
  }

  if (
    body.session_id !== undefined &&
    (typeof body.session_id !== 'string' || !isUuid(body.session_id))
  ) {
    throw new HttpError(422, 'session_id 格式不正确。');
  }
  let session =
    typeof body.session_id === 'string'
      ? await store.getSession(body.session_id, ownerKey)
      : undefined;
  if (body.session_id !== undefined && !session) throw new HttpError(404, '会话不存在。');
  session ??= await store.createSession({
    ownerKey,
    title: sessionTitle(message),
    provider: runtime.provider,
    model: runtime.modelId,
  });

  // ponytail: 单实例进程锁；需要横向扩容时换 PostgreSQL advisory lock。
  if (activeSessions.has(session.id)) throw new HttpError(409, '这个会话正在生成回复。');
  activeSessions.add(session.id);

  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event: Record<string, unknown>) => {
    if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
  };
  send({
    type: 'meta',
    session_id: session.id,
    provider: runtime.provider,
    model: runtime.modelId,
  });

  try {
    const [messages, approvals] = await Promise.all([
      store.loadMessages(session.id, ownerKey),
      store.listApprovals(session.id, ownerKey),
    ]);
    const agent = new Agent({
      initialState: {
        systemPrompt: systemPromptWithApprovals(approvals),
        model: runtime.model,
        thinkingLevel: 'low',
        tools: createAgentTools({ client, store, sessionId: session.id, ownerKey }),
        messages,
      },
      streamFn: runtime.models.streamSimple.bind(runtime.models),
      sessionId: session.id,
      toolExecution: 'sequential',
    });
    response.once('close', () => {
      if (!response.writableEnded) agent.abort();
    });
    agent.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        send({ type: 'text_delta', delta: event.assistantMessageEvent.delta });
      } else if (event.type === 'tool_execution_start') {
        send({
          type: 'tool_start',
          tool_call_id: event.toolCallId,
          capability: event.toolName,
          input: event.args,
        });
      } else if (event.type === 'tool_execution_end') {
        const details = toolDetails(event.result);
        send({
          type: 'tool_end',
          tool_call_id: event.toolCallId,
          capability: event.toolName,
          error: event.isError,
        });
        if (details?.approval) send({ type: 'approval', approval: details.approval });
      }
    });

    await agent.prompt(message);
    if (agent.state.errorMessage) {
      throw new HttpError(502, modelFailureMessage(agent.state.errorMessage));
    }
    const appended = agent.state.messages.slice(messages.length);
    await store.appendMessages(session.id, ownerKey, messages.length, appended);
    send({ type: 'done', session_id: session.id });
  } catch (error) {
    send({ type: 'error', message: publicErrorMessage(error) });
  } finally {
    activeSessions.delete(session.id);
    response.end();
  }
}

export function modelFailureMessage(providerMessage: string): string {
  void providerMessage;
  return '模型请求失败，请检查模型凭证和服务地址。';
}

async function decideApproval(args: {
  id: string;
  body: Record<string, unknown>;
  client: FireflyHttpClient;
  ownerKey: string;
  store: AiStore;
}): Promise<AiApproval> {
  if (args.body.decision === 'reject') {
    const rejected = await args.store.rejectApproval(args.id, args.ownerKey);
    if (!rejected) throw new HttpError(409, '审批已处理或不存在。');
    return rejected;
  }
  if (args.body.decision !== 'approve')
    throw new HttpError(422, 'decision 必须是 approve 或 reject。');

  const approval = await args.store.claimApproval(args.id, args.ownerKey);
  if (!approval) throw new HttpError(409, '审批已处理或不存在。');
  try {
    const capability = getCapability(approval.capability);
    validateCapabilityInput(capability, approval.input);
    const userInput = args.body.user_input;
    if (capability.userInputParameters) validateCapabilityUserInput(capability, userInput);
    const result = await capability.execute(
      args.client,
      approval.input,
      userInput as Record<string, unknown> | undefined,
    );
    return await args.store.finishApproval(approval.id, result);
  } catch (error) {
    await args.store.releaseApproval(approval.id, error);
    throw error;
  }
}

async function identifyOwner(client: FireflyHttpClient, fireflyUrl: string): Promise<string> {
  const about = await client.request('GET', '/api/v1/about/user');
  const data = recordValue(about)?.data;
  const user = recordValue(data);
  const attributes = recordValue(user?.attributes);
  const identity =
    stringValue(user?.id) ?? stringValue(attributes?.email) ?? stringValue(user?.email);
  if (!identity) throw new HttpError(502, 'Firefly 用户信息缺少稳定标识。');
  return createHash('sha256').update(`${fireflyUrl}\0${identity}`).digest('hex');
}

function displayMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  return messages.flatMap((message, index) => {
    if (!('role' in message) || (message.role !== 'user' && message.role !== 'assistant'))
      return [];
    const content = messageContent(message.content);
    if (!content && message.role === 'assistant') return [];
    return [
      {
        id: String(index),
        role: message.role,
        content,
        timestamp: 'timestamp' in message ? message.timestamp : undefined,
      },
    ];
  });
}

function messageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) =>
      recordValue(block)?.type === 'text' ? [String(recordValue(block)?.text ?? '')] : [],
    )
    .join('');
}

function systemPromptWithApprovals(approvals: AiApproval[]): string {
  const timeZone = process.env.TZ || 'Asia/Shanghai';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  const prompt = `${SYSTEM_PROMPT}\n\n当前日期：${today}（${timeZone}）。`;
  if (approvals.length === 0) return prompt;
  const status = approvals
    .slice(-20)
    .map((approval) => `${approval.capability} ${approval.id}: ${approval.status}`)
    .join('\n');
  return `${prompt}\n\n当前会话最近的人工审批状态：\n${status}`;
}

function toolDetails(result: unknown): { approval?: AiApproval } | undefined {
  const details = recordValue(recordValue(result)?.details);
  return details as { approval?: AiApproval } | undefined;
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match?.[1].trim()) throw new HttpError(401, '缺少 Firefly Bearer 令牌。');
  return match[1].trim();
}

async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > limit) throw new HttpError(413, '请求体过大。');
  }
  try {
    const value = JSON.parse(raw || '{}');
    if (!recordValue(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '请求体必须是 JSON 对象。');
  }
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function respondError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    if (!response.writableEnded) response.end();
    return;
  }
  const status =
    error instanceof HttpError
      ? error.status
      : error instanceof FireflyHttpError && error.status === 401
        ? 401
        : 500;
  if (status === 500) console.error(error);
  respondJson(response, status, { error: publicErrorMessage(error) });
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof FireflyHttpError) {
    if (error.status === 401) return 'Firefly 令牌无效或已过期。';
    if (error.status === 403) return '当前 Firefly 用户没有执行此操作的权限。';
    return `Firefly 请求失败（${error.status}）。`;
  }
  return 'AI 服务内部错误。';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function sessionTitle(message: string): string {
  return message.replace(/\s+/g, ' ').slice(0, 60);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
