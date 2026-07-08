import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ConfigStore } from '../../src/core/config-store.js';
import { runCli } from '../helpers/run-cli.js';

let tempDir: string;
let configPath: string;
const previousConfigEnv = process.env.FIREFLY_CLI_CONFIG;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'firefly-cli-resources-'));
  configPath = join(tempDir, 'config.json');
  process.env.FIREFLY_CLI_CONFIG = configPath;
  await new ConfigStore(configPath).setToken({
    profile: 'local',
    baseUrl: 'http://127.0.0.1:8000',
    token: 'secret-token',
  });
});

afterEach(async () => {
  if (previousConfigEnv === undefined) {
    delete process.env.FIREFLY_CLI_CONFIG;
  } else {
    process.env.FIREFLY_CLI_CONFIG = previousConfigEnv;
  }
  vi.restoreAllMocks();
  await rm(tempDir, { force: true, recursive: true });
});

function mockJsonFetch(body: unknown = { data: { id: '1' } }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function requestBody(call: unknown[]): unknown {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe('resource commands', () => {
  test('accounts commands map list get create update and delete requests', async () => {
    const fetchMock = mockJsonFetch({ data: [] });

    await runCli([
      'accounts',
      'list',
      '--page',
      '2',
      '--limit',
      '10',
      '--sort',
      'name',
      '--filter',
      'type=asset',
      '--format',
      'json',
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/accounts?page=2&limit=10&sort=name&type=asset',
      expect.objectContaining({ method: 'GET' }),
    );

    await runCli(['accounts', 'get', '123', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/accounts/123',
      expect.objectContaining({ method: 'GET' }),
    );

    await runCli(['accounts', 'create', '--name', 'Cash', '--type', 'asset', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/accounts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
    expect(requestBody(fetchMock.mock.calls.at(-1)!)).toEqual({ name: 'Cash', type: 'asset' });

    await runCli([
      'accounts',
      'update',
      '123',
      '--name',
      'Wallet',
      '--set',
      'order=1',
      '--format',
      'json',
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/accounts/123',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(requestBody(fetchMock.mock.calls.at(-1)!)).toEqual({ name: 'Wallet', order: '1' });

    await runCli(['accounts', 'delete', '123', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/accounts/123',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  test.each([
    ['budgets', '/api/v1/budgets'],
    ['categories', '/api/v1/categories'],
    ['tags', '/api/v1/tags'],
    ['bills', '/api/v1/bills'],
    ['currencies', '/api/v1/currencies'],
    ['webhooks', '/api/v1/webhooks'],
  ])('%s list maps to its Firefly endpoint', async (commandName, endpoint) => {
    const fetchMock = mockJsonFetch({ data: [] });

    await runCli([commandName, 'list', '--format', 'json']);

    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8000${endpoint}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('transactions create builds the Firefly transaction group payload from MVP flags', async () => {
    const fetchMock = mockJsonFetch();

    await runCli([
      'transactions',
      'create',
      '--type',
      'withdrawal',
      '--source',
      '1',
      '--destination',
      '2',
      '--amount',
      '12.34',
      '--description',
      'Coffee',
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/transactions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({
      transactions: [
        {
          type: 'withdrawal',
          source_id: '1',
          destination_id: '2',
          amount: '12.34',
          description: 'Coffee',
        },
      ],
    });
  });

  test('transactions import dry-run previews creates duplicates and ambiguous rows', async () => {
    const inputPath = join(tempDir, 'transactions.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        {
          type: 'withdrawal',
          date: '2026-06-07',
          source_id: '8',
          destination_name: 'Coffee Shop',
          amount: '18.00',
          description: 'Coffee',
          category_name: 'Food',
          notes: 'receipt',
          tags: ['wechat'],
        },
        {
          type: 'withdrawal',
          date: '2026-06-07',
          source_id: '8',
          destination_name: 'Bookstore',
          amount: '45.50',
          description: 'Book',
        },
        {
          type: 'withdrawal',
          date: '2026-06-07',
          source_id: '8',
          amount: '9.90',
        },
      ]),
    );
    const fetchMock = mockJsonFetch({
      data: [
        {
          id: '99',
          attributes: {
            transactions: [
              {
                date: '2026-06-07T00:00:00+08:00',
                source_id: '8',
                destination_name: 'Coffee Shop',
                amount: '18.00',
                description: 'Coffee',
              },
            ],
          },
        },
      ],
    });

    const result = await runCli([
      'transactions',
      'import',
      '--input',
      inputPath,
      '--dry-run',
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/transactions?start=2026-06-07&end=2026-06-07&limit=500',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.parse(result.logs.join('\n'))).toEqual({
      mode: 'dry-run',
      summary: {
        total: 3,
        create: 1,
        duplicate: 1,
        ambiguous: 1,
      },
      rows: [
        expect.objectContaining({
          row: 1,
          status: 'duplicate',
          duplicateIds: ['99'],
        }),
        expect.objectContaining({
          row: 2,
          status: 'create',
        }),
        expect.objectContaining({
          row: 3,
          status: 'ambiguous',
          reasons: ['description is required', 'destination_id or destination_name is required'],
        }),
      ],
    });
  });

  test('transactions import confirm posts only create-ready rows', async () => {
    const inputPath = join(tempDir, 'transactions.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        {
          type: 'withdrawal',
          date: '2026-06-08',
          source_id: '8',
          destination_name: 'Coffee Shop',
          amount: '12.34',
          description: 'Coffee',
          category_name: 'Food',
          notes: 'receipt',
          tags: ['wechat'],
        },
      ]),
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: '100' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const result = await runCli([
      'transactions',
      'import',
      '--input',
      inputPath,
      '--confirm',
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/transactions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({
      transactions: [
        {
          type: 'withdrawal',
          date: '2026-06-08',
          source_id: '8',
          destination_name: 'Coffee Shop',
          amount: '12.34',
          description: 'Coffee',
          category_name: 'Food',
          notes: 'receipt',
          tags: ['wechat'],
        },
      ],
    });
    expect(JSON.parse(result.logs.join('\n'))).toEqual({
      mode: 'confirm',
      summary: {
        total: 1,
        create: 1,
        duplicate: 0,
        ambiguous: 0,
        submitted: 1,
        created: 1,
        failed: 0,
      },
      rows: [
        expect.objectContaining({ row: 1, status: 'created', response: { data: { id: '100' } } }),
      ],
      response: { data: { id: '100' } },
    });
  });

  test('transactions import confirm submits independent rows as separate groups, not one split', async () => {
    const inputPath = join(tempDir, 'transactions.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        {
          type: 'withdrawal',
          date: '2026-06-08',
          source_id: '8',
          destination_name: 'Coffee Shop',
          amount: '12.34',
          description: 'Coffee',
        },
        {
          type: 'withdrawal',
          date: '2026-06-08',
          source_id: '8',
          destination_name: 'Bookstore',
          amount: '45.50',
          description: 'Book',
        },
      ]),
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: '200' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: '201' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const result = await runCli([
      'transactions',
      'import',
      '--input',
      inputPath,
      '--confirm',
      '--format',
      'json',
    ]);

    // 1 GET for existing-transaction lookup + one POST per independent row.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({
      transactions: [
        {
          type: 'withdrawal',
          date: '2026-06-08',
          source_id: '8',
          destination_name: 'Coffee Shop',
          amount: '12.34',
          description: 'Coffee',
        },
      ],
    });
    expect(requestBody(fetchMock.mock.calls[2])).toEqual({
      transactions: [
        {
          type: 'withdrawal',
          date: '2026-06-08',
          source_id: '8',
          destination_name: 'Bookstore',
          amount: '45.50',
          description: 'Book',
        },
      ],
    });

    expect(JSON.parse(result.logs.join('\n'))).toEqual({
      mode: 'confirm',
      summary: {
        total: 2,
        create: 2,
        duplicate: 0,
        ambiguous: 0,
        submitted: 2,
        created: 2,
        failed: 0,
      },
      rows: [
        expect.objectContaining({ row: 1, status: 'created', response: { data: { id: '200' } } }),
        expect.objectContaining({ row: 2, status: 'created', response: { data: { id: '201' } } }),
      ],
      responses: [{ data: { id: '200' } }, { data: { id: '201' } }],
    });
  });

  test('transactions import confirm reports which rows failed when one create fails', async () => {
    const inputPath = join(tempDir, 'transactions.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        {
          type: 'withdrawal',
          date: '2026-06-08',
          source_id: '8',
          destination_name: 'Coffee Shop',
          amount: '12.34',
          description: 'Coffee',
        },
        {
          type: 'withdrawal',
          date: '2026-06-08',
          source_id: '8',
          destination_name: 'Bookstore',
          amount: '45.50',
          description: 'Book',
        },
      ]),
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: '300' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Internal Server Error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const result = await runCli([
      'transactions',
      'import',
      '--input',
      inputPath,
      '--confirm',
      '--format',
      'json',
    ]);

    // Both rows are still attempted even though the second one fails.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const parsed = JSON.parse(result.logs.join('\n'));
    expect(parsed.summary).toEqual({
      total: 2,
      create: 2,
      duplicate: 0,
      ambiguous: 0,
      submitted: 2,
      created: 1,
      failed: 1,
    });
    expect(parsed.rows[0]).toMatchObject({
      row: 1,
      status: 'created',
      response: { data: { id: '300' } },
    });
    expect(parsed.rows[1]).toMatchObject({ row: 2, status: 'failed' });
    expect(parsed.rows[1].error).toContain('Internal Server Error');
    expect(parsed.responses).toEqual([{ data: { id: '300' } }, null]);
  });

  test('transactions import converts source timezone before preview and confirm', async () => {
    const inputPath = join(tempDir, 'transactions.json');
    await writeFile(
      inputPath,
      JSON.stringify([
        {
          type: 'withdrawal',
          date: '2026-06-08 10:59:11',
          source_id: '12',
          destination_name: '邵火火鲍汁黄焖鸡',
          amount: '23.80',
          description: '邵火火鲍汁黄焖鸡外卖',
        },
      ]),
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: '101' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const result = await runCli([
      'transactions',
      'import',
      '--input',
      inputPath,
      '--timezone',
      'Asia/Shanghai',
      '--confirm',
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/transactions?start=2026-06-08&end=2026-06-08&limit=500',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({
      transactions: [
        {
          type: 'withdrawal',
          date: '2026-06-08T10:59:11+08:00',
          source_id: '12',
          destination_name: '邵火火鲍汁黄焖鸡',
          amount: '23.80',
          description: '邵火火鲍汁黄焖鸡外卖',
        },
      ],
    });
    expect(JSON.parse(result.logs.join('\n'))).toEqual({
      mode: 'confirm',
      timezone: 'Asia/Shanghai',
      summary: {
        total: 1,
        create: 1,
        duplicate: 0,
        ambiguous: 0,
        submitted: 1,
        created: 1,
        failed: 0,
      },
      rows: [
        expect.objectContaining({
          row: 1,
          status: 'created',
          originalDate: '2026-06-08 10:59:11',
          fireflyDate: '2026-06-08T10:59:11+08:00',
        }),
      ],
      response: { data: { id: '101' } },
    });
  });

  test('accounts create builds an asset account payload from shortcut flags', async () => {
    const fetchMock = mockJsonFetch();

    await runCli([
      'accounts',
      'create',
      '--asset',
      '--name',
      '微信钱包',
      '--balance',
      '798',
      '--currency',
      'CNY',
      '--date',
      '2026-06-04',
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/accounts',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({
      name: '微信钱包',
      type: 'asset',
      account_role: 'defaultAsset',
      currency_code: 'CNY',
      opening_balance: '798',
      opening_balance_date: '2026-06-04',
    });
  });

  test('accounts create builds a debt liability payload from shortcut flags', async () => {
    const fetchMock = mockJsonFetch();

    await runCli([
      'accounts',
      'create',
      '--liability',
      '--name',
      '花呗',
      '--debt',
      '2026.24',
      '--liability-type',
      'debt',
      '--date',
      '2026-06-04',
      '--format',
      'json',
    ]);

    expect(requestBody(fetchMock.mock.calls[0])).toEqual({
      name: '花呗',
      type: 'liability',
      liability_type: 'debt',
      liability_direction: 'debit',
      currency_code: 'CNY',
      opening_balance: '2026.24',
      opening_balance_date: '2026-06-04',
      interest: '0',
      interest_period: 'monthly',
    });
  });

  test('accounts create builds a loan liability payload with notes', async () => {
    const fetchMock = mockJsonFetch();

    await runCli([
      'accounts',
      'create',
      '--liability',
      '--name',
      '助学贷款',
      '--debt',
      '56000',
      '--liability-type',
      'loan',
      '--date',
      '2026-06-04',
      '--notes',
      '2022-08-08 12000; 2023-08-04 12000',
      '--format',
      'json',
    ]);

    expect(requestBody(fetchMock.mock.calls[0])).toEqual({
      name: '助学贷款',
      type: 'liability',
      liability_type: 'loan',
      liability_direction: 'debit',
      currency_code: 'CNY',
      opening_balance: '56000',
      opening_balance_date: '2026-06-04',
      interest: '0',
      interest_period: 'yearly',
      notes: '2022-08-08 12000; 2023-08-04 12000',
    });
  });

  test('accounts create rejects conflicting account shortcuts', async () => {
    mockJsonFetch();

    await expect(
      runCli([
        'accounts',
        'create',
        '--asset',
        '--liability',
        '--name',
        'Confused',
        '--format',
        'json',
      ]),
    ).rejects.toThrow('Use either --asset or --liability, not both.');
  });

  test('accounts create keeps explicit JSON body ahead of shortcut flags', async () => {
    const fetchMock = mockJsonFetch();

    await runCli([
      'accounts',
      'create',
      '--asset',
      '--name',
      '微信钱包',
      '--json',
      '{"name":"Manual","type":"asset"}',
      '--format',
      'json',
    ]);

    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ name: 'Manual', type: 'asset' });
  });

  test('webhooks submit posts to the manual submit endpoint', async () => {
    const fetchMock = mockJsonFetch();

    await runCli(['webhooks', 'submit', '42', '--format', 'json']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/webhooks/42/submit',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
