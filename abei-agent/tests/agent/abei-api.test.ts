import { describe, expect, test, vi } from 'vitest';

import {
  AbeiApi,
  AbeiProblemError,
  AbeiUnavailableError,
  fillPath,
} from '../../src/agent/abei-api.js';
import { catalogFixture, capability } from './catalog-fixture.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });
}

function apiWith(fetchImpl: typeof fetch, options: { catalogTtlMs?: number } = {}): AbeiApi {
  return new AbeiApi({ baseUrl: 'http://abei.test/', fetchImpl, ...options });
}

describe('abei-api 客户端', () => {
  test('目录只拉一次，并发的首次调用共用同一个请求', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      json(catalogFixture()),
    );
    const api = apiWith(fetchMock as unknown as typeof fetch);

    const [first, second] = await Promise.all([api.catalog('pat'), api.catalog('pat')]);
    const third = await api.catalog('another-pat');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://abei.test/v1/catalog');
    expect(first.byToolName('bills_import')?.id).toBe('bills.import');
    expect(second.version).toBe(third.version);
  });

  test('目录过期后重新拉一遍', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      json(catalogFixture()),
    );
    const api = apiWith(fetchMock as unknown as typeof fetch, { catalogTtlMs: -1 });

    await api.catalog('pat');
    await api.catalog('pat');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('GET 能力把参数放查询串，路径参数不再重复出现在查询里', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      json({ data: [] }),
    );
    const api = apiWith(fetchMock as unknown as typeof fetch);

    await api.invoke({
      token: 'pat',
      capability: capability('bills.review'),
      params: { id: '42' },
    });
    await api.invoke({
      token: 'pat',
      capability: capability('transactions.summary'),
      params: { start: '2026-08-01', exclude_category: ['房租', '还款'] },
    });

    expect(fetchMock.mock.calls[0][0]).toBe('http://abei.test/v1/bills/42/review');
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://abei.test/v1/transactions/summary?start=2026-08-01&exclude_category=%E6%88%BF%E7%A7%9F&exclude_category=%E8%BF%98%E6%AC%BE',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer pat' }),
    });
  });

  test('写能力把闸门放查询串、参数放请求体', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      json({ dry_run: true }),
    );
    const api = apiWith(fetchMock as unknown as typeof fetch);

    await api.invoke({
      token: 'pat',
      capability: capability('bills.import'),
      params: { id: '42', row_ids: [1, 2] },
      gate: { dryRun: true },
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://abei.test/v1/bills/42/import?dry_run=true');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ row_ids: [1, 2] });
  });

  test('固定参数由客户端注入且调用方不能覆盖，DELETE 参数仍走请求体', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      json({ data: {} }),
    );
    const api = apiWith(fetchMock as unknown as typeof fetch);
    const create = { ...capability('rows.update'), fixed_params: { source: 'cli' } };
    await api.invoke({
      token: 'pat',
      capability: create,
      params: { id: '7', source: 'model', category_name: '餐饮' },
    });
    const remove = {
      ...capability('bills.import'),
      id: 'feedback.delete',
      method: 'DELETE',
      path: '/v1/feedback/{id}',
    };
    await api.invoke({
      token: 'pat',
      capability: remove,
      params: { id: '42', reason: '隐私' },
      gate: { confirm: true },
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      source: 'cli',
      category_name: '餐饮',
    });
    expect(fetchMock.mock.calls[1][0]).toBe('http://abei.test/v1/feedback/42?confirm=true');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ reason: '隐私' });
  });

  test('problem+json 变成带 reason 的错误，409 认得出是等人确认', async () => {
    const problem = {
      type: 'https://abei.local/problems/confirmation-required',
      title: '需要显式确认',
      status: 409,
      reason: 'ConfirmationRequired',
      detail: 'bills.import 是要落库的操作。',
    };
    const api = apiWith((async () => json(problem, 409)) as unknown as typeof fetch);

    const error = await api
      .invoke({ token: 'pat', capability: capability('bills.import'), params: { id: '42' } })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AbeiProblemError);
    expect((error as AbeiProblemError).status).toBe(409);
    expect((error as AbeiProblemError).needsConfirmation).toBe(true);
  });

  test('连不上 abei-api 和参数错是两类错误', async () => {
    const api = apiWith((() => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);

    await expect(api.catalog('pat')).rejects.toBeInstanceOf(AbeiUnavailableError);
  });

  test('路径参数缺失当场报出来，不发一个 /v1/bills/undefined 的请求', () => {
    expect(() => fillPath('/v1/bills/{id}/import', {})).toThrow(AbeiProblemError);
  });
});
