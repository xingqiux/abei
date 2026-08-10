/**
 * 聊天流走的是真 node 服务：hono 只负责路由，NDJSON 由 streamChat 直接写
 * ServerResponse。换路由框架时最容易出事的就是这条，所以这里起真服务器、
 * 用真 fetch 收流，检查响应头、事件顺序和收尾。
 */

import { serve, type ServerType } from '@hono/node-server';
import { afterEach, describe, expect, test } from 'vitest';

import { AbeiApi } from '../../src/agent/abei-api.js';
import type { AutofillWorker } from '../../src/agent/autofill.js';
import type { ModelRuntime } from '../../src/agent/model-runtime.js';
import { createApp, type AgentDeps } from '../../src/agent/routes.js';
import type { AiStore } from '../../src/agent/store.js';
import { catalogFixture } from './catalog-fixture.js';

let running: ServerType | undefined;

afterEach(async () => {
  const server = running;
  running = undefined;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fireflyFetch = (async (url: string | URL) =>
  String(url).includes('/api/v1/about/user')
    ? json({ data: { id: '1' } })
    : json({ message: 'unexpected' }, 404)) as unknown as typeof fetch;

/** 起一个真服务器，返回它的地址。 */
async function boot(overrides: Partial<AgentDeps>): Promise<string> {
  const deps: AgentDeps = {
    fireflyUrl: 'http://firefly.test',
    abei: new AbeiApi({
      baseUrl: 'http://abei.test',
      fetchImpl: (async () => json(catalogFixture())) as unknown as typeof fetch,
    }),
    store: {} as AiStore,
    env: {},
    environmentRuntime: {} as ModelRuntime,
    runtimeCache: new Map(),
    activeSessions: new Set(),
    autofill: { isRunning: () => false } as unknown as AutofillWorker,
    fetchImpl: fireflyFetch,
    ...overrides,
  };
  const app = createApp(deps);
  const server = await new Promise<ServerType>((resolve) => {
    const created = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () =>
      resolve(created),
    );
  });
  running = server;
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

/** 能过校验、但一取历史消息就炸的运行时和库。够把流开起来了。 */
function streamableDeps(): Partial<AgentDeps> {
  const runtime = {
    provider: 'openai',
    modelId: 'gpt-test',
    model: {},
    models: { checkAuth: async () => true },
  } as unknown as ModelRuntime;
  const store = {
    getModelConfig: async () => undefined,
    createSession: async () => ({ id: '0a5f6ce4-6b4a-4f6d-9c2e-1b2c3d4e5f60' }),
    loadMessages: async () => {
      throw new Error('库这会儿不可用');
    },
    listApprovals: async () => [],
  } as unknown as AiStore;
  return { store, environmentRuntime: runtime };
}

async function chat(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { authorization: 'Bearer pat-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('聊天流', () => {
  test('响应头是 NDJSON，第一行必是 meta，出错落 error 并收尾', async () => {
    const base = await boot(streamableDeps());
    const response = await chat(base, { message: '这个月花了多少' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    // 反向代理不许缓冲，否则前端要等整轮结束才看得到字。
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const lines = (await response.text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines[0]).toMatchObject({
      type: 'meta',
      session_id: '0a5f6ce4-6b4a-4f6d-9c2e-1b2c3d4e5f60',
      provider: 'openai',
      model: 'gpt-test',
    });
    // 流已经开头了，错误只能进事件流，且不能把内部细节抖出去。
    expect(lines.at(-1)).toEqual({ type: 'error', message: 'AI 服务内部错误。' });
    expect(JSON.stringify(lines)).not.toContain('库这会儿不可用');
  });

  test('流还没开就发现的问题，仍然是普通 JSON 错误体', async () => {
    const base = await boot(streamableDeps());
    const response = await chat(base, { message: '   ' });

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      error: '消息不能为空，且不能超过 8000 个字符。',
    });
  });

  test('模型没配好回 503，不开流', async () => {
    const base = await boot({
      ...streamableDeps(),
      environmentRuntime: { provider: 'openai', error: '模型不可用。' } as unknown as ModelRuntime,
    });
    const response = await chat(base, { message: '你好' });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: '模型不可用。' });
  });

  test('同一会话正在生成时再来一发退 409', async () => {
    const session = '0a5f6ce4-6b4a-4f6d-9c2e-1b2c3d4e5f60';
    const base = await boot({
      ...streamableDeps(),
      store: {
        getModelConfig: async () => undefined,
        getSession: async () => ({ id: session }),
        loadMessages: async () => [],
        listApprovals: async () => [],
      } as unknown as AiStore,
      activeSessions: new Set([session]),
    });
    const response = await chat(base, { message: '你好', session_id: session });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: '这个会话正在生成回复。' });
  });
});
