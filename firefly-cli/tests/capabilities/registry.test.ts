import { describe, expect, test, vi } from 'vitest';

import { createAgentTools } from '../../src/agent/tools.js';
import type { AiStore } from '../../src/agent/store.js';
import { listCapabilities } from '../../src/capabilities/registry.js';
import { FireflyHttpClient } from '../../src/core/http-client.js';

function clientWithFetch(fetchImpl: typeof fetch): FireflyHttpClient {
  return new FireflyHttpClient({
    baseUrl: 'http://firefly.test',
    token: 'pat',
    fetchImpl,
  });
}

function okJson(body: unknown = { data: {} }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FFC capability registry', () => {
  test('exposes only the eight approved accounting capabilities', () => {
    expect(listCapabilities().map(({ name, risk }) => [name, risk])).toEqual([
      ['list_bill_tasks', 'read'],
      ['review_bill_task', 'read'],
      ['update_bill_row', 'draft'],
      ['split_bill_row', 'draft'],
      ['import_bill_task', 'confirm'],
      ['submit_bill_secret', 'confirm'],
      ['search_transactions', 'read'],
      ['spending_summary', 'read'],
    ]);
  });

  test('marks every AI row edit as a suggestion', async () => {
    const fetchMock = vi.fn(async () => okJson());
    const tool = createAgentTools({
      client: clientWithFetch(fetchMock as typeof fetch),
      store: {} as AiStore,
      sessionId: 'session',
      ownerKey: 'owner',
    }).find(({ name }) => name === 'update_bill_row')!;

    await tool.execute('call', {
      row_id: '9',
      values: { category_name: '餐饮', firefly_description: '午餐' },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://firefly.test/api/v1/bill-statement-rows/9',
      expect.objectContaining({ method: 'PATCH' }),
    );
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).toEqual({
      category_name: '餐饮',
      firefly_description: '午餐',
      as_suggestion: true,
    });
  });

  test('returns complete paginated bill task results without truncation', async () => {
    const response = {
      data: [
        {
          type: 'bill-tasks',
          id: '30',
          attributes: { metadata: { original: 'x'.repeat(70_000) } },
          relationships: { mail_message: { data: { type: 'bill-mail-messages', id: '45' } } },
        },
      ],
      links: { next: '/api/v1/bill-tasks?page=3' },
      meta: { pagination: { current_page: 2, total_pages: 3 } },
    };
    const fetchMock = vi.fn(async () => okJson(response));
    const tool = createAgentTools({
      client: clientWithFetch(fetchMock as typeof fetch),
      store: {} as AiStore,
      sessionId: 'session',
      ownerKey: 'owner',
    }).find(({ name }) => name === 'list_bill_tasks')!;

    const result = await tool.execute('call', {
      source: 'alipay',
      status: 'parsed',
      page: 2,
      limit: 20,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://firefly.test/api/v1/bill-tasks?source=alipay&status=parsed&page=2&limit=20',
      expect.objectContaining({ method: 'GET' }),
    );
    const content = result.content[0] as { type: 'text'; text: string };
    expect(JSON.parse(content.text)).toEqual(response);
    expect(content.text).not.toContain('"truncated":true');
  });

  test('dry-runs an import and creates approval instead of committing it', async () => {
    const fetchMock = vi.fn(async () => okJson({ dry_run: true }));
    const createApproval = vi.fn(async (input) => ({
      id: 'approval',
      sessionId: input.sessionId,
      capability: input.capability,
      input: input.input,
      preview: input.preview,
      status: 'pending' as const,
      result: null,
      createdAt: new Date(0).toISOString(),
    }));
    const tool = createAgentTools({
      client: clientWithFetch(fetchMock as typeof fetch),
      store: { createApproval } as unknown as AiStore,
      sessionId: 'session',
      ownerKey: 'owner',
    }).find(({ name }) => name === 'import_bill_task')!;

    const result = await tool.execute('call', { task_id: '13', row_ids: [1, 2] });

    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).toEqual({
      confirm: false,
      row_ids: [1, 2],
    });
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'import_bill_task', preview: { dry_run: true } }),
    );
    expect(result.details).toEqual(expect.objectContaining({ risk: 'confirm' }));
  });

  test('never asks the model for or submits a bill secret', async () => {
    const fetchMock = vi.fn(async () => okJson());
    const createApproval = vi.fn(async (input) => ({
      id: 'approval',
      sessionId: input.sessionId,
      capability: input.capability,
      input: input.input,
      preview: null,
      status: 'pending' as const,
      result: null,
      createdAt: new Date(0).toISOString(),
    }));
    const tool = createAgentTools({
      client: clientWithFetch(fetchMock as typeof fetch),
      store: { createApproval } as unknown as AiStore,
      sessionId: 'session',
      ownerKey: 'owner',
    }).find(({ name }) => name === 'submit_bill_secret')!;

    await tool.execute('call', { task_id: '7' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ input: { task_id: '7' }, preview: undefined }),
    );
  });
});
