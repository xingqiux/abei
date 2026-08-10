import { describe, expect, test, vi } from 'vitest';

import { AbeiApi } from '../../src/agent/abei-api.js';
import { decideApproval, pickUserInput, type ApprovalStore } from '../../src/agent/approvals.js';
import type { AiApproval } from '../../src/agent/store.js';
import { capability, catalogFixture } from './catalog-fixture.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });
}

function pending(capabilityId: string, input: Record<string, unknown>): AiApproval {
  return {
    id: 'approval-1',
    sessionId: 'session',
    capability: capabilityId,
    input,
    preview: null,
    status: 'pending',
    result: null,
    createdAt: new Date(0).toISOString(),
  };
}

function setup(approval: AiApproval | undefined, respond: () => Response) {
  const calls: Array<[string, RequestInit]> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/v1/catalog')) return json(catalogFixture());
    calls.push([String(url), init]);
    return respond();
  }) as unknown as typeof fetch;

  const store = {
    claimApproval: vi.fn(async () => approval),
    rejectApproval: vi.fn(async () => approval),
    finishApproval: vi.fn(async (_id: string, result: unknown) => ({
      ...approval!,
      status: 'approved' as const,
      result,
    })),
    releaseApproval: vi.fn(async () => undefined),
  } satisfies ApprovalStore;

  return {
    calls,
    store,
    abei: new AbeiApi({ baseUrl: 'http://abei.test', fetchImpl }),
  };
}

describe('人工审批', () => {
  test('确认之后才带 confirm=true 打 abei-api', async () => {
    const { abei, store, calls } = setup(pending('bills.import', { id: '42', all: true }), () =>
      json({ imported: 3 }),
    );

    const decided = await decideApproval({
      id: 'approval-1',
      body: { decision: 'approve' },
      abei,
      token: 'pat',
      ownerKey: 'owner',
      store,
    });

    const [url, init] = calls[0];
    expect(url).toBe('http://abei.test/v1/bills/42/import?confirm=true');
    expect(url).not.toContain('dry_run');
    expect(JSON.parse(String(init.body))).toEqual({ all: true });
    expect(store.finishApproval).toHaveBeenCalledWith('approval-1', { imported: 3 });
    expect(decided).toMatchObject({ status: 'approved', label: '导入账单' });
  });

  test('人填的密码只在这一次请求里经手，不写回审批记录', async () => {
    const { abei, store, calls } = setup(pending('bills.unlock', { id: '7' }), () =>
      json({ status: 'queued' }),
    );

    await decideApproval({
      id: 'approval-1',
      body: { decision: 'approve', user_input: { secret: '真·密码' } },
      abei,
      token: 'pat',
      ownerKey: 'owner',
      store,
    });

    expect(calls[0][0]).toBe('http://abei.test/v1/bills/7/unlock?confirm=true');
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ secret: '真·密码' });
    const stored = store.finishApproval.mock.calls[0];
    expect(JSON.stringify(stored)).not.toContain('真·密码');
  });

  test('驳回不打 abei-api', async () => {
    const { abei, store, calls } = setup(pending('bills.import', { id: '42' }), () => json({}));

    await decideApproval({
      id: 'approval-1',
      body: { decision: 'reject' },
      abei,
      token: 'pat',
      ownerKey: 'owner',
      store,
    });

    expect(calls).toHaveLength(0);
    expect(store.rejectApproval).toHaveBeenCalled();
    expect(store.claimApproval).not.toHaveBeenCalled();
  });

  test('执行失败把审批放回 pending', async () => {
    const problem = { status: 502, reason: 'UpstreamError', title: '上游出错' };
    const { abei, store } = setup(pending('bills.import', { id: '42', all: true }), () =>
      json(problem, 502),
    );

    await expect(
      decideApproval({
        id: 'approval-1',
        body: { decision: 'approve' },
        abei,
        token: 'pat',
        ownerKey: 'owner',
        store,
      }),
    ).rejects.toThrow('上游出错');
    expect(store.releaseApproval).toHaveBeenCalled();
    expect(store.finishApproval).not.toHaveBeenCalled();
  });

  test('审批端点不是随便改参数的后门', () => {
    const unlock = capability('bills.unlock');
    const importBill = capability('bills.import');

    expect(pickUserInput({ secret: 'x' }, unlock)).toEqual({ secret: 'x' });
    expect(() => pickUserInput({ secret: 'x', id: '999' }, unlock)).toThrow('user_input 只接受');
    expect(() => pickUserInput({ secret: '' }, unlock)).toThrow('请填写secret');
    expect(() => pickUserInput(undefined, unlock)).toThrow('受信界面');
    // 不需要人填参数的能力，页面传什么都不进请求。
    expect(pickUserInput({ all: true }, importBill)).toEqual({});
  });
});
