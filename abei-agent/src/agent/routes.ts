/**
 * `/api/ai` 的路由表。
 *
 * 这里只做三件事：认令牌、把路径映射到处理函数、把异常翻成 JSON 错误体。
 * 业务逻辑在各自模块里（模型设置在 model-settings，聊天流在 chat，
 * 能力调用在 tools/abei-api），路由表本身应该一眼扫得完。
 *
 * 路径参数用 hono 的正则形式声明（`:id{...}`）：形状不对的直接落到 404，
 * 和以前手写正则匹配失败的行为一样，处理函数里不必再校验一遍。
 */

import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono } from 'hono';

import { FireflyHttpError } from '../core/errors.js';
import { FireflyHttpClient } from '../core/http-client.js';
import type { AbeiApi } from './abei-api.js';
import { decideApproval } from './approvals.js';
import type { AutofillWorker } from './autofill.js';
import { displayMessages, streamChat } from './chat.js';
import { errorStatus, HttpError, publicErrorMessage } from './http-error.js';
import type { ModelConfig } from './model-config.js';
import { discoverModels, ModelDiscoveryError } from './model-discovery.js';
import { createModelRuntime, type ModelRuntime } from './model-runtime.js';
import {
  modelConfigStatus,
  optionalConfigString,
  parseModelConfig,
  parseModelConnection,
  runtimeForOwner,
} from './model-settings.js';
import { record } from './shared.js';
import {
  AiStore,
  DEFAULT_AUTOFILL_INTERVAL_SECONDS,
  type AiRunKind,
  type AutofillConfig,
} from './store.js';
import { describeApprovals } from './tools.js';

/** 路由要用的一切外部依赖。测试给假的即可，不必起数据库。 */
export interface AgentDeps {
  fireflyUrl: string;
  abei: AbeiApi;
  store: AiStore;
  env: NodeJS.ProcessEnv;
  environmentRuntime: ModelRuntime;
  runtimeCache: Map<string, ModelRuntime>;
  activeSessions: Set<string>;
  autofill: AutofillWorker;
  /** 打 Firefly 用的 fetch。测试塞假的，生产走全局那个。 */
  fetchImpl?: typeof fetch;
}

/** 鉴权中间件认完之后挂在上下文里的东西。 */
type Vars = {
  token: string;
  client: FireflyHttpClient;
  ownerKey: string;
};

const UUID = ':id{[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}}';
const LOOSE_UUID = ':id{[0-9a-fA-F-]{36}}';
const DIGITS = ':id{[0-9]{1,18}}';

export function createApp(deps: AgentDeps) {
  const app = new Hono<{ Variables: Vars }>();

  app.get('/api/ai/health', (c) => c.json({ status: 'ok' }));

  // 除健康检查外，所有接口都要 Firefly 令牌，且先换出 ownerKey——
  // 数据按它分区，认不出人就不该往下走。
  app.use('/api/ai/*', async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    const client = new FireflyHttpClient({
      baseUrl: deps.fireflyUrl,
      token,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    c.set('token', token);
    c.set('client', client);
    c.set('ownerKey', await identifyOwner(client, deps.fireflyUrl));
    await next();
  });

  app.post('/api/ai/models', async (c) => {
    const current = await deps.store.getModelConfig(c.get('ownerKey'));
    const config = parseModelConnection(await readJson(c.req.raw, 16_384), current, deps.env);
    try {
      return c.json({ data: await discoverModels(config) });
    } catch (error) {
      if (error instanceof ModelDiscoveryError) throw new HttpError(502, error.message);
      throw error;
    }
  });

  app.get('/api/ai/config', async (c) => {
    const saved = await deps.store.getModelConfig(c.get('ownerKey'));
    const runtime = await resolveRuntime(deps, c.get('ownerKey'), saved);
    return c.json(
      await modelConfigStatus(runtime, saved ? 'saved' : 'environment', saved, deps.env),
    );
  });

  app.put('/api/ai/config', async (c) => {
    const ownerKey = c.get('ownerKey');
    const current = await deps.store.getModelConfig(ownerKey);
    const config = parseModelConfig(await readJson(c.req.raw, 16_384), current, deps.env);
    const runtime = await verifiedRuntime(deps, config);
    await deps.store.saveModelConfig(ownerKey, config);
    deps.runtimeCache.set(ownerKey, runtime);
    return c.json(await modelConfigStatus(runtime, 'saved', config, deps.env));
  });

  app.delete('/api/ai/config', async (c) => {
    await deps.store.deleteModelConfig(c.get('ownerKey'));
    deps.runtimeCache.delete(c.get('ownerKey'));
    return c.json(
      await modelConfigStatus(deps.environmentRuntime, 'environment', undefined, deps.env),
    );
  });

  app.get('/api/ai/autofill-config', async (c) =>
    c.json(autofillStatus(await deps.store.getAutofillConfig(c.get('ownerKey')))),
  );

  app.post('/api/ai/autofill-config', async (c) => {
    const ownerKey = c.get('ownerKey');
    const body = await readJson(c.req.raw, 16_384);
    const current = await deps.store.getAutofillConfig(ownerKey);
    const saved = await deps.store.saveAutofillConfig(ownerKey, parseAutofillConfig(body, current));
    await deps.autofill.reschedule(ownerKey);
    return c.json(autofillStatus(saved));
  });

  app.post('/api/ai/autofill/run', async (c) => {
    const ownerKey = c.get('ownerKey');
    const body = await readJson(c.req.raw, 8_192);
    if (deps.autofill.isRunning(ownerKey)) throw new HttpError(409, '预填正在跑，请等这一轮结束。');
    // 手动补跑用调用方自己的令牌，存量清理不必先存 PAT。
    const stats = await deps.autofill
      .runNow({ ownerKey, client: c.get('client'), taskIds: parseTaskIds(body.task_ids) })
      .catch(rethrowWorkerFailure('预填没跑起来，请检查模型配置。'));
    return c.json({ data: stats });
  });

  app.post('/api/ai/learn/run', async (c) => {
    const ownerKey = c.get('ownerKey');
    if (deps.autofill.isRunning(ownerKey)) throw new HttpError(409, '还有一轮在跑，请等这一轮结束。');
    const stats = await deps.autofill
      .runLearnNow({ ownerKey, client: c.get('client') })
      .catch(rethrowWorkerFailure('学习没跑起来，请稍后再试。'));
    return c.json({ data: stats });
  });

  // 阿贝干过的活。列表不带明细（会把一页撑爆），单条才带。
  app.get('/api/ai/runs', async (c) => {
    const limit = parsePositiveInt(c.req.query('limit'), 'limit', 200);
    const offset = parsePositiveInt(c.req.query('offset'), 'offset', 100_000);
    return c.json({
      data: await deps.store.listAiRuns(c.get('ownerKey'), {
        limit,
        offset,
        kind: parseRunKind(c.req.query('kind')),
      }),
    });
  });

  app.get(`/api/ai/runs/${LOOSE_UUID}`, async (c) => {
    const run = await deps.store.getAiRun(c.get('ownerKey'), c.req.param('id'));
    if (!run) throw new HttpError(404, '这条记录不存在。');
    return c.json({ data: run });
  });

  app.post('/api/ai/backfill/run', async (c) => {
    const ownerKey = c.get('ownerKey');
    // 和预填共用一把并发闸：一个用户同一时刻只跑一件事。
    if (deps.autofill.isRunning(ownerKey))
      throw new HttpError(409, '还有一轮在跑，请等这一轮结束。');
    const stats = await deps.autofill
      .runBackfillNow({ ownerKey, client: c.get('client') })
      .catch(rethrowWorkerFailure('回填没跑起来，请检查模型配置。'));
    return c.json(
      {
        started: true,
        transactions: stats.journals,
        suggestions: stats.rule_suggestions + stats.model_suggestions,
      },
      202,
    );
  });

  app.get('/api/ai/backfill/suggestions', async (c) =>
    c.json({
      data: await deps.store.listBackfillSuggestions(c.get('ownerKey')),
      running: deps.autofill.isRunning(c.get('ownerKey')),
    }),
  );

  app.post(`/api/ai/backfill/suggestions/${DIGITS}/resolve`, async (c) => {
    const body = await readJson(c.req.raw, 4_096);
    if (typeof body.applied !== 'boolean') throw new HttpError(422, 'applied 必须是布尔值。');
    const resolved = await deps.store.resolveBackfillSuggestion(
      c.get('ownerKey'),
      c.req.param('id'),
      body.applied ? 'applied' : 'rejected',
    );
    if (!resolved) throw new HttpError(404, '建议不存在或已处理。');
    return c.json({ data: resolved });
  });

  app.get('/api/ai/vocab-suggestions', async (c) =>
    c.json({ data: await deps.store.listVocabSuggestions(c.get('ownerKey')) }),
  );

  app.post(`/api/ai/vocab-suggestions/${LOOSE_UUID}`, async (c) => {
    const body = await readJson(c.req.raw, 4_096);
    if (body.action !== 'accept' && body.action !== 'ignore') {
      throw new HttpError(422, 'action 必须是 accept 或 ignore。');
    }
    // 只改状态：真正建分类由 web 端先调 Firefly，成功了再回来 accept。
    const resolved = await deps.store.resolveVocabSuggestion(
      c.get('ownerKey'),
      c.req.param('id'),
      body.action === 'accept' ? 'accepted' : 'ignored',
    );
    if (!resolved) throw new HttpError(404, '建议不存在或已处理。');
    return c.json({ data: resolved });
  });

  app.get('/api/ai/sessions', async (c) =>
    c.json({ data: await deps.store.listSessions(c.get('ownerKey')) }),
  );

  app.get(`/api/ai/sessions/${UUID}`, async (c) => {
    const ownerKey = c.get('ownerKey');
    const session = await deps.store.getSession(c.req.param('id'), ownerKey);
    if (!session) throw new HttpError(404, '会话不存在。');
    const [messages, approvals, catalog] = await Promise.all([
      deps.store.loadMessages(session.id, ownerKey),
      deps.store.listApprovals(session.id, ownerKey),
      deps.abei.catalog(c.get('token')),
    ]);
    return c.json({
      data: {
        session,
        messages: displayMessages(messages),
        approvals: describeApprovals(approvals, catalog),
      },
    });
  });

  // 唯一一条不走 c.json 的路由：NDJSON 直接写回 node 的 ServerResponse，
  // 不经过 Response 对象，首字延迟和背压都保持原样。
  app.post('/api/ai/chat', async (c) => {
    const response = outgoing(c.env);
    const body = await readJson(c.req.raw, 32_768);
    const runtime = await resolveRuntime(deps, c.get('ownerKey'));
    await streamChat({
      response,
      body,
      abei: deps.abei,
      token: c.get('token'),
      ownerKey: c.get('ownerKey'),
      store: deps.store,
      runtime,
      activeSessions: deps.activeSessions,
    });
    return RESPONSE_ALREADY_SENT;
  });

  app.post(`/api/ai/approvals/${UUID}`, async (c) =>
    c.json({
      data: await decideApproval({
        id: c.req.param('id'),
        body: await readJson(c.req.raw, 4_096),
        abei: deps.abei,
        token: c.get('token'),
        ownerKey: c.get('ownerKey'),
        store: deps.store,
      }),
    }),
  );

  app.notFound((c) => c.json({ error: '接口不存在。' }, 404));

  app.onError((error, c) => {
    // 流已经开头了就没法再改状态码，交给 chat 那边把错误塞进事件流。
    if (c.finalized || headersSent(c.env)) return c.body(null);
    const status = errorStatus(error);
    if (status === 500) console.error(error);
    return c.json({ error: publicErrorMessage(error) }, status as 400);
  });

  return app;
}

/** 从 node-server 的 env 里取原始 ServerResponse。只有聊天流需要它。 */
function outgoing(env: unknown): ServerResponse {
  const response = record(env)?.outgoing;
  if (!response) throw new HttpError(500, '当前运行环境不支持流式响应。');
  return response as ServerResponse;
}

function headersSent(env: unknown): boolean {
  const response = record(env)?.outgoing as ServerResponse | undefined;
  return Boolean(response?.headersSent);
}

async function resolveRuntime(
  deps: AgentDeps,
  ownerKey: string,
  saved?: ModelConfig,
): Promise<ModelRuntime> {
  return runtimeForOwner({
    ownerKey,
    saved,
    store: deps.store,
    env: deps.env,
    environmentRuntime: deps.environmentRuntime,
    runtimeCache: deps.runtimeCache,
  });
}

/** 存配置之前先确认这套连接真能用，别把不可用的配置写进库。 */
async function verifiedRuntime(deps: AgentDeps, config: ModelConfig): Promise<ModelRuntime> {
  const runtime = createModelRuntime(deps.env, config);
  if (!runtime.model || runtime.error) {
    throw new HttpError(422, `模型 ${config.provider}/${config.model} 不可用。`);
  }
  if (!(await runtime.models.checkAuth(runtime.provider))) {
    throw new HttpError(422, '模型凭证字段不完整。');
  }
  return runtime;
}

/** 后台任务炸了：Firefly 的错原样透出去，其余一律换成一句话并记日志。 */
function rethrowWorkerFailure(message: string) {
  return (error: unknown): never => {
    if (error instanceof FireflyHttpError) throw error;
    console.error(error);
    throw new HttpError(502, message);
  };
}

/** 分页参数：给了就得是合法的非负整数，别把 `?limit=abc` 当没看见。 */
function parsePositiveInt(
  value: string | undefined,
  name: string,
  max: number,
): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new HttpError(422, `${name} 必须是 0 到 ${max} 之间的整数。`);
  }
  return parsed;
}

/** 按类别筛工作记录。认不出的类别一律拒掉，免得筛出个空列表让人以为没干过活。 */
function parseRunKind(value: string | undefined): AiRunKind | undefined {
  if (value === undefined || value === '') return undefined;
  if (!AI_RUN_KINDS.includes(value as AiRunKind)) {
    throw new HttpError(422, `kind 只能是 ${AI_RUN_KINDS.join('、')}。`);
  }
  return value as AiRunKind;
}

const AI_RUN_KINDS: AiRunKind[] = ['autofill', 'backfill', 'vocab_scan', 'learn'];

function autofillStatus(config?: AutofillConfig) {
  return {
    status: 'ok',
    enabled: config?.enabled ?? false,
    interval_seconds: config?.intervalSeconds ?? DEFAULT_AUTOFILL_INTERVAL_SECONDS,
    has_token: Boolean(config?.token),
  };
}

function parseAutofillConfig(
  body: Record<string, unknown>,
  current?: AutofillConfig,
): { enabled: boolean; intervalSeconds: number; token?: string } {
  if (typeof body.enabled !== 'boolean') throw new HttpError(422, 'enabled 必须是布尔值。');
  const token = optionalConfigString(body.token, 'Firefly 令牌', 8_192);
  if (body.enabled && !token && !current?.token) {
    throw new HttpError(422, '开启自动预填需要提供 Firefly 个人访问令牌。');
  }
  return {
    enabled: body.enabled,
    intervalSeconds: parseIntervalSeconds(body.interval_seconds, current),
    token,
  };
}

function parseIntervalSeconds(value: unknown, current?: AutofillConfig): number {
  if (value === undefined || value === null) {
    return current?.intervalSeconds ?? DEFAULT_AUTOFILL_INTERVAL_SECONDS;
  }
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86_400) {
    throw new HttpError(422, 'interval_seconds 必须是 60 到 86400 之间的整数。');
  }
  return seconds;
}

function parseTaskIds(value: unknown): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(422, 'task_ids 必须是不超过 100 个任务 ID 的数组。');
  }
  return value.map((item) => {
    const id = Number(item);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(422, 'task_ids 只能是正整数。');
    return id;
  });
}

function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  if (!match?.[1].trim()) throw new HttpError(401, '缺少 Firefly Bearer 令牌。');
  return match[1].trim();
}

/**
 * 用 Firefly 的用户身份换一个稳定的 ownerKey。带上 fireflyUrl 一起哈希，
 * 换实例就是另一个人，不会串数据。
 */
async function identifyOwner(client: FireflyHttpClient, fireflyUrl: string): Promise<string> {
  const about = await client.request('GET', '/api/v1/about/user');
  const data = record(about)?.data;
  const user = record(data);
  const attributes = record(user?.attributes);
  const identity =
    stringValue(user?.id) ?? stringValue(attributes?.email) ?? stringValue(user?.email);
  if (!identity) throw new HttpError(502, 'Firefly 用户信息缺少稳定标识。');
  return createHash('sha256').update(`${fireflyUrl}\0${identity}`).digest('hex');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

async function readJson(request: Request, limit: number): Promise<Record<string, unknown>> {
  // 先看声明的长度，超了就不必把整个体读进内存。
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, '请求体过大。');
  const raw = await request.text();
  if (Buffer.byteLength(raw) > limit) throw new HttpError(413, '请求体过大。');
  try {
    const value: unknown = JSON.parse(raw || '{}');
    const object = record(value);
    if (!object) throw new Error('object required');
    return object;
  } catch {
    throw new HttpError(400, '请求体必须是 JSON 对象。');
  }
}
