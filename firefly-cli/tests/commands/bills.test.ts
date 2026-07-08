import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ConfigStore } from '../../src/core/config-store.js';
import { runCli } from '../helpers/run-cli.js';

let tempDir: string;
let configPath: string;
const previousConfigEnv = process.env.FIREFLY_CLI_CONFIG;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'firefly-bill-tasks-'));
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

function mockJsonFetch(body: unknown = { data: [] }) {
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

describe('bill inbox commands', () => {
  test('lists bill tasks from the Firefly API', async () => {
    const fetchMock = mockJsonFetch({
      data: [
        {
          id: '1',
          attributes: {
            source: 'cmb',
            profile_id: 'cmb-credit-card',
            status: 'needs_secret',
            received_at: '2026-06-10T09:30:00+08:00',
            summary: '招商银行信用卡电子账单',
          },
        },
      ],
    });

    const result = await runCli([
      'bill-inbox',
      'list',
      '--source',
      'alipay',
      '--status',
      'parsed',
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks?source=alipay&status=parsed',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
      }),
    );
    expect(JSON.parse(result.logs.join('\n'))).toEqual({
      data: [
        {
          id: '1',
          attributes: expect.objectContaining({
            source: 'cmb',
            status: 'needs_secret',
          }),
        },
      ],
    });
  });

  test('shows a bill task and related details from the Firefly API', async () => {
    const fetchMock = mockJsonFetch({
      data: {
        id: '1',
        type: 'bill-tasks',
        attributes: {
          source: 'cmb',
          status: 'needs_secret',
          summary: '招商银行信用卡电子账单',
        },
        relationships: {
          mail_message: { data: { id: '1', type: 'bill-mail-messages' } },
          current_challenge: { data: { id: '1', type: 'bill-secret-challenges' } },
        },
      },
      included: [],
    });

    await runCli(['bill-inbox', 'show', '1', '--format', 'json']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks/1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('lists bill task artifacts and events through the Firefly API', async () => {
    const fetchMock = mockJsonFetch({ data: [] });

    await runCli(['bill-inbox', 'artifacts', '1', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks/1/artifacts',
      expect.objectContaining({ method: 'GET' }),
    );

    await runCli(['bill-inbox', 'events', '1', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks/1/events',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('lists statement rows with filters through the Firefly API', async () => {
    const fetchMock = mockJsonFetch({ data: [] });

    await runCli([
      'bill-inbox',
      'rows',
      '1',
      '--status',
      'pending',
      '--from',
      '2026-05-15',
      '--to',
      '2026-06-15',
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks/1/rows?status=pending&from=2026-05-15&to=2026-06-15',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('requests compact statement row summaries through the Firefly API', async () => {
    const fetchMock = mockJsonFetch({
      summary: {
        total: 117,
        by_status: { pending: 117 },
        by_duplicate_state: { unique: 100, duplicate: 15, conflict: 2 },
        amounts: { expense: '99.00', income: '0.00', net: '-99.00' },
      },
      data: [],
    });

    await runCli([
      'bill-inbox',
      'rows',
      '13',
      '--summary',
      '--limit',
      '10',
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks/13/rows?summary=true&limit=10',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('shows and updates a statement row through the Firefly API', async () => {
    const fetchMock = mockJsonFetch({
      data: {
        id: '9',
        type: 'bill-statement-rows',
        attributes: { counterparty: '中国联通' },
      },
    });

    await runCli(['bill-inbox', 'row', 'show', '9', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-statement-rows/9',
      expect.objectContaining({ method: 'GET' }),
    );

    await runCli([
      'bill-inbox',
      'row',
      'update',
      '9',
      '--set',
      'counterparty=中国联通线上营业厅',
      '--set',
      'firefly_amount=20.00',
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-statement-rows/9',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({
      counterparty: '中国联通线上营业厅',
      firefly_amount: '20.00',
    });
  });

  test('splits a combo-payment statement row through the Firefly API', async () => {
    const fetchMock = mockJsonFetch({
      parent: { id: '9', type: 'bill-statement-rows', attributes: { status: 'split' } },
      data: [],
    });

    await runCli([
      'bill-inbox',
      'row',
      'split',
      '9',
      '--part',
      '招商银行储蓄卡(8705):招商银行=9.72',
      '--part',
      '花呗=14.08',
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-statement-rows/9/split',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({
      splits: [
        { payment_method: '招商银行储蓄卡(8705)', source_name: '招商银行', amount: '9.72' },
        { payment_method: '花呗', amount: '14.08' },
      ],
    });
  });

  test('imports statement rows with dry run and confirmation flags', async () => {
    const fetchMock = mockJsonFetch({
      summary: { total: 3, imported: 3, skipped: 0, failed: 0 },
      rows: [],
    });

    await runCli(['bill-inbox', 'import', '1', '--rows', '5,6,7', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks/1/import',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({
      row_ids: [5, 6, 7],
      confirm: false,
    });

    await runCli(['bill-inbox', 'import', '1', '--all', '--confirm', '--format', 'json']);
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({
      all: true,
      confirm: true,
    });
  });

  test('can explicitly request dry-run payloads for bill imports', async () => {
    const fetchMock = mockJsonFetch({
      summary: { total: 1, imported: 0, skipped: 1, failed: 0 },
      rows: [],
    });

    await runCli(['bill-inbox', 'import', '1', '--all', '--include-payload', '--format', 'json']);

    expect(requestBody(fetchMock.mock.calls[0])).toEqual({
      all: true,
      confirm: false,
      include_payload: true,
    });
  });

  test('reviews statement rows before importing through the Firefly API', async () => {
    const fetchMock = mockJsonFetch({
      summary: {
        total: 117,
        pending: 117,
        importable: 100,
        duplicate_candidates: 15,
        conflict_candidates: 2,
        preserved_user_edits: 3,
      },
      new_candidates: [],
      existing_candidates: [],
      duplicate_candidates: [],
      conflict_candidates: [],
      preserved_user_edits: [],
      transfer_candidates: [],
      refund_pairs: [],
      needs_user_note: [],
    });

    await runCli(['bill-inbox', 'review', '13', '--format', 'json']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks/13/review',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('warns on stderr when review flags cross-source duplicate candidates', async () => {
    mockJsonFetch({
      summary: { total: 1, pending: 1 },
      new_candidates: [],
      existing_candidates: [],
      cross_source_candidates: [
        {
          row_id: '42',
          row_number: 3,
          cross_source_matches: [
            { transaction_group_id: '128', confidence: 'high', suggestion: 'skip' },
          ],
        },
      ],
      duplicate_candidates: [],
      conflict_candidates: [],
      preserved_user_edits: [],
      transfer_candidates: [],
      refund_pairs: [],
      needs_user_note: [],
    });

    const { logs, errors } = await runCli(['bill-inbox', 'review', '13', '--format', 'json']);

    // stdout stays pure JSON for agents/scripts...
    expect(logs.join('\n')).toContain('cross_source_candidates');
    // ...while the human advisory goes to stderr.
    const advisory = errors.join('\n');
    expect(advisory).toContain('疑似与已有 Firefly 交易重复');
    expect(advisory).toContain('row 3 → 交易 #128');
    expect(advisory).toContain('high');
    expect(advisory).toContain('skip');
  });

  test('does not emit a cross-source advisory when there are no candidates', async () => {
    mockJsonFetch({
      summary: { total: 1, pending: 1 },
      new_candidates: [],
      cross_source_candidates: [],
    });

    const { errors } = await runCli(['bill-inbox', 'review', '13', '--format', 'json']);

    expect(errors.join('\n')).not.toContain('疑似与已有 Firefly 交易重复');
  });

  test('warns on stderr when a balance chain does not close', async () => {
    mockJsonFetch({
      summary: { total: 1, pending: 1 },
      new_candidates: [],
      cross_source_candidates: [],
      balance_chain: {
        招商银行: {
          account_name: '招商银行',
          closes: false,
          expected_after: '979.00',
          statement_balance: '900.00',
          difference: '79.00',
        },
        工商银行: {
          account_name: '工商银行',
          closes: true,
          expected_after: '500.00',
          statement_balance: '500.00',
          difference: null,
        },
      },
    });

    const { errors } = await runCli(['bill-inbox', 'review', '13', '--format', 'json']);

    const advisory = errors.join('\n');
    expect(advisory).toContain('余额链未闭合');
    expect(advisory).toContain('招商银行：预期 979.00，账单 900.00，差 79.00');
    // the closing account must not be warned about.
    expect(advisory).not.toContain('工商银行');
  });

  test('archives one or many bill tasks through the Firefly API', async () => {
    const fetchMock = mockJsonFetch({
      data: { id: '1', type: 'bill-tasks', attributes: { status: 'cleaned' } },
    });

    await runCli(['bill-inbox', 'archive', '1', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks/1/archive',
      expect.objectContaining({ method: 'POST' }),
    );

    await runCli(['bill-inbox', 'archive', '--ids', '5,6,7', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks/archive',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ ids: [5, 6, 7] });
  });

  test('submits a secret through the Firefly API', async () => {
    const fetchMock = mockJsonFetch({
      data: {
        id: '1',
        type: 'bill-tasks',
        attributes: { status: 'ready' },
      },
    });

    await runCli(['bill-inbox', 'secret', 'submit', '1', '--value', '123456', '--format', 'json']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks/1/secret',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ value: '123456' });
  });

  test('ignores and retries tasks through the Firefly API', async () => {
    const fetchMock = mockJsonFetch({
      data: {
        id: '1',
        type: 'bill-tasks',
        attributes: { status: 'ignored' },
      },
    });

    await runCli(['bill-inbox', 'ignore', '1', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks/1/ignore',
      expect.objectContaining({ method: 'POST' }),
    );

    await runCli(['bill-inbox', 'retry', '1', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-tasks/1/retry',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('syncs and processes bill inbox tasks through the Firefly API', async () => {
    const fetchMock = mockJsonFetch({
      data: {
        type: 'bill-inbox-sync-result',
        attributes: {
          scanned: 2,
          created: 1,
          ignored: 0,
          duplicates: 1,
          failed: 0,
          processed: 1,
          process_failed: 0,
          errors: [],
        },
      },
    });

    await runCli(['bill-inbox', 'sync', '--limit', '50', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-inbox/sync',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ limit: 50 });

    await runCli(['bill-inbox', 'process', '--limit', '10', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-inbox/process',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ limit: 10 });
  });

  test('shows and updates mailbox settings through the Firefly API', async () => {
    const fetchMock = mockJsonFetch({
      data: {
        type: 'bill-inbox-settings',
        attributes: {
          enabled: true,
          provider: 'gmail',
          email: 'user@example.com',
          host: 'imap.gmail.com',
          port: 993,
          encryption: 'ssl',
          username: 'user@example.com',
          folder: 'INBOX',
          has_password: true,
          built_in_channels: [],
        },
      },
    });

    await runCli(['bill-inbox', 'settings', 'show', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-inbox/settings',
      expect.objectContaining({ method: 'GET' }),
    );

    await runCli([
      'bill-inbox',
      'settings',
      'set',
      '--enabled',
      '--provider',
      'gmail',
      '--email',
      'user@example.com',
      '--password',
      'app-pass',
      '--format',
      'json',
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-inbox/settings',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({
      enabled: true,
      provider: 'gmail',
      email: 'user@example.com',
      password: 'app-pass',
    });
  });

  test('cleans up stale bill inbox tasks through the Firefly API', async () => {
    const fetchMock = mockJsonFetch({
      data: {
        type: 'bill-inbox-cleanup-result',
        attributes: { archived: 3 },
      },
    });

    await runCli(['bill-inbox', 'cleanup-stale', '--format', 'json']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-inbox/cleanup-stale',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({});
  });

  test('downloads a bill artifact to a local file', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('zip-bytes', {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        }),
    );
    const output = join(tempDir, 'artifact.zip');

    await runCli(['bill-inbox', 'artifact', 'download', '9', '--output', output, '--format', 'json']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/bill-artifacts/9/download',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(await readFile(output, 'utf8')).toBe('zip-bytes');
  });
});
