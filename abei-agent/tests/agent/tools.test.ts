import { validateToolArguments } from '@earendil-works/pi-ai';
import { describe, expect, test, vi } from 'vitest';

import { AbeiApi } from '../../src/agent/abei-api.js';
import type { AiStore } from '../../src/agent/store.js';
import { createAgentTools, modelParameters } from '../../src/agent/tools.js';
import { capability, catalogFixture } from './catalog-fixture.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });
}

/** 第一次请求回目录，之后回调用方给的响应。 */
function agentTools(responses: Array<() => Response>) {
  const calls: Array<[string, RequestInit]> = [];
  let index = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/v1/catalog')) return json(catalogFixture());
    calls.push([String(url), init]);
    return responses[index++]();
  }) as unknown as typeof fetch;

  const createApproval = vi.fn(async (input: Record<string, unknown>) => ({
    id: 'approval-1',
    sessionId: String(input.sessionId),
    capability: String(input.capability),
    input: input.input as Record<string, unknown>,
    preview: input.preview,
    status: 'pending' as const,
    result: null,
    createdAt: new Date(0).toISOString(),
  }));

  return {
    calls,
    createApproval,
    tools: createAgentTools({
      abei: new AbeiApi({ baseUrl: 'http://abei.test', fetchImpl }),
      token: 'pat',
      store: { createApproval } as unknown as AiStore,
      sessionId: 'session',
      ownerKey: 'owner',
    }),
  };
}

function textOf(result: { content: Array<{ type: string }> }): Record<string, unknown> {
  const block = result.content[0] as { type: 'text'; text: string };
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe('目录驱动的工具生成', () => {
  test('工具名、标签和参数模式都来自目录', async () => {
    const { tools } = agentTools([]);
    const list = await tools;

    expect(list.map((tool) => tool.name)).toEqual(
      catalogFixture().capabilities.map((item) => item.tool_name),
    );
    const review = list.find((tool) => tool.name === 'bills_review')!;
    expect(review.label).toBe('审阅账单');
    expect(review.executionMode).toBe('parallel');
    expect(list.find((tool) => tool.name === 'bills_import')!.executionMode).toBe('sequential');
  });

  test('目录里的参数模式能直接当工具模式用', () => {
    // 目录的 schema 是 schemars 生成的 JSON Schema，不是 TypeBox。
    // 这条测试盯着「pi-ai 认不认」这个假设，认不了就当场红。
    for (const item of catalogFixture().capabilities) {
      const example = item.examples[0];
      if (!example) continue;
      const args = validateToolArguments(
        { name: item.tool_name, description: item.description, parameters: item.params as never },
        { type: 'toolCall', id: 'call', name: item.tool_name, arguments: example.params },
      );
      expect(args).toEqual(example.params);
    }
  });

  test('密码字段不进模型看到的参数模式', () => {
    const params = modelParameters(capability('bills.unlock'));
    const properties = params.properties as Record<string, unknown>;

    expect(Object.keys(properties)).toEqual(['id']);
    expect(params.required).toEqual(['id']);
    expect(params.$schema).toBeUndefined();
  });

  test('只读能力直接打 abei-api 并把结果原样交回模型', async () => {
    const body = { data: [{ id: '1' }], meta: { pagination: { total: 1 } } };
    const { tools, calls } = agentTools([() => json(body)]);
    const tool = (await tools).find((item) => item.name === 'bills_list')!;

    const result = await tool.execute('call', { status: 'pending', limit: 20 });

    expect(calls[0][0]).toBe('http://abei.test/v1/bills?status=pending&limit=20');
    expect(textOf(result)).toEqual(body);
    expect(result.details).toMatchObject({ capability: 'bills.list', risk: 'read' });
  });

  test('confirm 档先干跑、落审批，不落库', async () => {
    const preview = { dry_run: true, would: { rows: 2 } };
    const { tools, calls, createApproval } = agentTools([() => json(preview)]);
    const tool = (await tools).find((item) => item.name === 'bills_import')!;

    const result = await tool.execute('call', { id: '42', row_ids: [1, 2] });

    expect(calls[0][0]).toBe('http://abei.test/v1/bills/42/import?dry_run=true');
    expect(calls[0][0]).not.toContain('confirm=true');
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'bills.import', preview }),
    );
    expect(textOf(result)).toMatchObject({
      status: 'approval_required',
      approval_id: 'approval-1',
    });
    expect(result.details).toMatchObject({
      risk: 'confirm',
      approval: expect.objectContaining({ label: '导入账单', needs_user_input: [] }),
    });
  });

  test('要人填密码的能力不干跑，直接等人，也绝不代模型提交密码', async () => {
    const { tools, calls, createApproval } = agentTools([]);
    const tool = (await tools).find((item) => item.name === 'bills_unlock')!;

    const result = await tool.execute('call', { id: '7', secret: '模型自己编的' });

    expect(calls).toHaveLength(0);
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'bills.unlock',
        input: { id: '7' },
        preview: undefined,
      }),
    );
    expect(JSON.stringify(result)).not.toContain('模型自己编的');
    expect(result.details).toMatchObject({
      approval: expect.objectContaining({ needs_user_input: ['secret'] }),
    });
  });

  test('服务端回 409 ConfirmationRequired 时转成等人确认，不当错误报', async () => {
    // 本地目录说这条是 draft、服务端已经调成 confirm，说明目录缓存过期了。
    const problem = { status: 409, reason: 'ConfirmationRequired', title: '需要显式确认' };
    const { tools, calls, createApproval } = agentTools([
      () => json(problem, 409),
      () => json({ dry_run: true }),
    ]);
    const tool = (await tools).find((item) => item.name === 'rows_update')!;

    const result = await tool.execute('call', { id: '9', category_name: '餐饮' });

    expect(calls[0][0]).toBe('http://abei.test/v1/rows/9');
    expect(calls[1][0]).toBe('http://abei.test/v1/rows/9?dry_run=true');
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'rows.update', preview: { dry_run: true } }),
    );
    expect(textOf(result)).toMatchObject({ status: 'approval_required' });
  });

  test('别的错误照常抛给模型，让它改参数重试', async () => {
    const problem = {
      status: 400,
      reason: 'InvalidParams',
      title: '参数不对',
      detail: 'limit 只能是 1 到 100。',
    };
    const { tools } = agentTools([() => json(problem, 400)]);
    const tool = (await tools).find((item) => item.name === 'bills_list')!;

    await expect(tool.execute('call', { limit: 500 })).rejects.toThrow('limit 只能是 1 到 100。');
  });
});
