import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ConfigStore } from '../../src/core/config-store.js';
import { runCli } from '../helpers/run-cli.js';

let tempDir: string;
let configPath: string;
const previousConfigEnv = process.env.FIREFLY_CLI_CONFIG;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'firefly-cli-base-'));
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

function mockJsonFetch(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('base commands', () => {
  test('bare command shows a connected accounting and task overview', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const body = url.includes('/about/user')
        ? { data: { attributes: { email: 'user@example.com', role: 'owner' } } }
        : url.includes('/summary/basic')
          ? {
              'earned-in-CNY': {
                key: 'earned-in-CNY',
                monetary_value: '1200',
                currency_code: 'CNY',
                currency_symbol: '¥',
                currency_decimal_places: 2,
              },
              'spent-in-CNY': {
                key: 'spent-in-CNY',
                monetary_value: '-300',
                currency_code: 'CNY',
                currency_symbol: '¥',
                currency_decimal_places: 2,
              },
              'balance-in-CNY': {
                key: 'balance-in-CNY',
                monetary_value: '900',
                currency_code: 'CNY',
                currency_symbol: '¥',
                currency_decimal_places: 2,
              },
              'net-worth-in-CNY': {
                key: 'net-worth-in-CNY',
                monetary_value: '8000',
                currency_code: 'CNY',
                currency_symbol: '¥',
                currency_decimal_places: 2,
              },
            }
          : url.includes('/bill-inbox/summary')
            ? {
                pending_total: 2,
                needs_code: 1,
                unprocessed: 1,
                failed: 0,
                channels: [{ parsed: 3, to_store: 12 }],
              }
            : { last_reconciled_date: '2026-08-01', days_unreconciled: 5 };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await runCli([]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(result.logs.join('\n'))).toMatchObject({
      status: 'connected',
      connection: { profile: 'local', email: 'user@example.com', role: 'owner' },
      finances: [{ currency: 'CNY', income: '1200', expense: '-300' }],
      tasks: {
        billInbox: { total: 5, review: 3, needsCode: 1, rowsReady: 12 },
        reconciliation: { daysUnreconciled: 5, lastReconciledDate: '2026-08-01' },
      },
    });
  });

  test('bare command explains how to pair when no config exists', async () => {
    const result = await runCli(['--config', join(tempDir, 'missing.json'), '--format', 'json']);

    expect(JSON.parse(result.logs.join('\n'))).toMatchObject({
      status: 'unconfigured',
      command: 'ffc config --url <url> --token <token>',
    });
  });

  test('about calls /api/v1/about', async () => {
    const fetchMock = mockJsonFetch({ data: { version: 'test' } });

    const result = await runCli(['about', '--format', 'json']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/about',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.logs.join('\n')).toContain('"version": "test"');
  });

  test('me calls /api/v1/about/user', async () => {
    const fetchMock = mockJsonFetch({ data: { email: 'user@example.com' } });

    const result = await runCli(['me', '--format', 'json']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/about/user',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.logs.join('\n')).toContain('user@example.com');
  });

  test('api command passes method path query and JSON body', async () => {
    const fetchMock = mockJsonFetch({ data: { id: '1' } });

    await runCli([
      'api',
      'POST',
      '/api/v1/accounts',
      '--query',
      'page=1',
      '--json',
      '{"name":"Cash"}',
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/accounts?page=1',
      expect.objectContaining({
        method: 'POST',
        body: '{"name":"Cash"}',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  test('doctor local reports pgsql config, TZ mismatch, and APP_URL port mismatch', async () => {
    const rootPath = join(tempDir, 'firefly-iii');
    await mkdir(join(rootPath, 'storage', 'framework', 'cache', 'data'), { recursive: true });
    await writeFile(join(rootPath, 'artisan'), '');
    await writeFile(
      join(rootPath, '.env'),
      [
        'APP_URL=http://127.0.0.1:18000',
        'TZ=Europe/Amsterdam',
        'DB_CONNECTION=pgsql',
        'DB_HOST=db',
        'DB_PORT=5432',
        'DB_DATABASE=firefly',
      ].join('\n'),
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1:18001/login' },
      }),
    );

    const result = await runCli([
      'doctor',
      'local',
      '--root',
      rootPath,
      '--url',
      'http://127.0.0.1:18001',
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18001/',
      expect.objectContaining({ method: 'GET' }),
    );
    const report = JSON.parse(result.logs.join('\n'));
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        {
          name: 'root',
          status: 'ok',
          message: `Firefly III root found at ${rootPath}.`,
        },
        {
          name: 'database',
          status: 'ok',
          message: 'PostgreSQL configured (db:5432/firefly).',
          actual: 'pgsql',
        },
        {
          name: 'app-url',
          status: 'warn',
          message:
            'APP_URL points to http://127.0.0.1:18000 but checked URL is http://127.0.0.1:18001.',
          expected: 'http://127.0.0.1:18001',
          actual: 'http://127.0.0.1:18000',
        },
        {
          name: 'timezone',
          status: 'warn',
          message:
            'TZ is Europe/Amsterdam but local accounting imports expect Asia/Shanghai. Update monorepo .env or pass --timezone when importing.',
          expected: 'Asia/Shanghai',
          actual: 'Europe/Amsterdam',
        },
        {
          name: 'storage-cache',
          status: 'ok',
          message: 'storage/framework/cache/data exists and is writable.',
          path: join(rootPath, 'storage', 'framework', 'cache', 'data'),
        },
        {
          name: 'http',
          status: 'ok',
          message: 'http://127.0.0.1:18001/ responded with HTTP 302.',
        },
      ]),
    );
    expect(report.checks.find((c: { name: string }) => c.name === 'v1-assets')).toBeUndefined();
    expect(report.checks.find((c: { name: string }) => c.name === 'v2-assets')).toBeUndefined();
  });
});
