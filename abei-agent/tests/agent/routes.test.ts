/**
 * 路由表的行为。
 *
 * 这些用例守的是「哪条路径走到哪个处理函数、认不认令牌、错了回什么状态码」，
 * 也就是从手写 if 链换成 hono 时最容易悄悄改掉的那部分。依赖全给假的，
 * 不起数据库、不连 Firefly。
 */

import { describe, expect, test } from 'vitest';

import { AbeiApi } from '../../src/agent/abei-api.js';
import type { AutofillWorker } from '../../src/agent/autofill.js';
import type { ModelRuntime } from '../../src/agent/model-runtime.js';
import { createApp, type AgentDeps } from '../../src/agent/routes.js';
import type { AiStore } from '../../src/agent/store.js';
import { catalogFixture } from './catalog-fixture.js';

/** sha256('http://firefly.test\0' + Firefly 用户 id)。换实例或换人就是另一个 key。 */
const OWNER = 'dca55f6db00b7dc72347329dfa9e848ebed6b5e4aee57f9f8c3417740d3a7509';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 假 Firefly：只回 /about/user，够换出 ownerKey 了。 */
function fireflyFetch(status = 200): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).includes('/api/v1/about/user')) {
      if (status !== 200) return json({ message: 'nope' }, status);
      return json({ data: { id: '1', attributes: { email: 'a@example.com' } } });
    }
    return json({ message: 'unexpected' }, 404);
  }) as unknown as typeof fetch;
}

function deps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  const store = {
    getModelConfig: async () => undefined,
    getAutofillConfig: async () => undefined,
    listCategoryRules: async () => [],
    listSessions: async () => [{ id: 'session-1' }],
    deleteCategoryRule: async () => false,
    resolveVocabSuggestion: async () => undefined,
    listVocabSuggestions: async () => [],
    listBackfillSuggestions: async () => [],
    ...(overrides.store ?? {}),
  } as unknown as AiStore;

  return {
    fireflyUrl: 'http://firefly.test',
    abei: new AbeiApi({
      baseUrl: 'http://abei.test',
      fetchImpl: (async () => json(catalogFixture())) as unknown as typeof fetch,
    }),
    store,
    env: {},
    environmentRuntime: { provider: 'openai', modelId: 'x', models: {} } as unknown as ModelRuntime,
    runtimeCache: new Map(),
    activeSessions: new Set(),
    autofill: { isRunning: () => false, reschedule: async () => {} } as unknown as AutofillWorker,
    fetchImpl: fireflyFetch(),
    ...overrides,
  };
}

function call(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('authorization')) headers.set('authorization', 'Bearer pat-token');
  return app.request(`http://agent.test${path}`, { ...init, headers });
}

describe('路由表', () => {
  test('健康检查不要令牌', async () => {
    const response = await createApp(deps()).request('http://agent.test/api/ai/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('除健康检查外都要 Bearer 令牌', async () => {
    const response = await createApp(deps()).request('http://agent.test/api/ai/sessions');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: '缺少 Firefly Bearer 令牌。' });
  });

  test('Firefly 说令牌无效就照原样回 401', async () => {
    const app = createApp(deps({ fetchImpl: fireflyFetch(401) }));
    const response = await call(app, '/api/ai/sessions');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Firefly 令牌无效或已过期。' });
  });

  test('会话列表按 ownerKey 取，令牌本身不落库', async () => {
    let seen: string | undefined;
    const app = createApp(
      deps({
        store: {
          listSessions: async (ownerKey: string) => {
            seen = ownerKey;
            return [{ id: 'session-1' }];
          },
        } as unknown as AiStore,
      }),
    );
    const response = await call(app, '/api/ai/sessions');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: 'session-1' }] });
    // ownerKey 是 Firefly 身份哈希出来的，不是令牌原文。
    expect(seen).toBe(OWNER);
    expect(seen).not.toContain('pat-token');
  });

  test('同一路径的不同方法各走各的处理函数', async () => {
    const calls: string[] = [];
    const app = createApp(
      deps({
        store: {
          getModelConfig: async () => undefined,
          deleteModelConfig: async () => {
            calls.push('delete');
          },
        } as unknown as AiStore,
        environmentRuntime: {
          provider: 'openai',
          modelId: 'gpt',
          model: {},
          models: { checkAuth: async () => true },
        } as unknown as ModelRuntime,
      }),
    );
    const removed = await call(app, '/api/ai/config', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(calls).toEqual(['delete']);
    expect(await removed.json()).toMatchObject({ source: 'environment', configured: true });
  });

  test('路径参数形状不对就是 404，不进处理函数', async () => {
    const app = createApp(
      deps({
        store: {
          getSession: async () => {
            throw new Error('不该走到这里');
          },
        } as unknown as AiStore,
      }),
    );
    expect((await call(app, '/api/ai/sessions/not-a-uuid')).status).toBe(404);
    expect(
      (await call(app, '/api/ai/backfill/suggestions/abc/resolve', { method: 'POST' })).status,
    ).toBe(404);
  });

  test('形状对但库里没有，回 404 加人话', async () => {
    const app = createApp(
      deps({ store: { getSession: async () => undefined } as unknown as AiStore }),
    );
    const response = await call(app, '/api/ai/sessions/0a5f6ce4-6b4a-4f6d-9c2e-1b2c3d4e5f60');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '会话不存在。' });
  });

  test('没挂的路径回 404 而不是 500', async () => {
    const response = await call(createApp(deps()), '/api/ai/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '接口不存在。' });
  });

  test('请求体不是 JSON 对象就退 400', async () => {
    const response = await call(createApp(deps()), '/api/ai/category-feedback', {
      method: 'POST',
      body: '"just a string"',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '请求体必须是 JSON 对象。' });
  });

  test('请求体超限退 413，不把整个体读进内存', async () => {
    const response = await call(createApp(deps()), '/api/ai/category-feedback', {
      method: 'POST',
      body: JSON.stringify({ pattern: 'x'.repeat(9_000) }),
    });
    expect(response.status).toBe(413);
  });

  test('参数不合规退 422 并说清楚哪儿不对', async () => {
    const app = createApp(deps());
    const response = await call(app, '/api/ai/autofill-config', {
      method: 'POST',
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'enabled 必须是布尔值。' });
  });

  test('正在跑的时候再点一次退 409', async () => {
    const app = createApp(
      deps({ autofill: { isRunning: () => true } as unknown as AutofillWorker }),
    );
    const response = await call(app, '/api/ai/autofill/run', { method: 'POST', body: '{}' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: '预填正在跑，请等这一轮结束。' });
  });

  test('意料之外的异常统一成 500，不把内部细节抖出去', async () => {
    const app = createApp(
      deps({
        store: {
          listCategoryRules: async () => {
            throw new Error('connection to 10.0.0.5:5432 refused');
          },
        } as unknown as AiStore,
      }),
    );
    const response = await call(app, '/api/ai/category-rules');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'AI 服务内部错误。' });
  });
});
