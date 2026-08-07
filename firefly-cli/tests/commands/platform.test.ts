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
  tempDir = await mkdtemp(join(tmpdir(), 'firefly-cli-platform-'));
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

describe('platform commands', () => {
  test('config verifies a one-line pairing command before saving it', async () => {
    const pairedPath = join(tempDir, 'paired.json');
    const fetchMock = mockJsonFetch({ data: { attributes: { email: 'user@example.com' } } });

    const result = await runCli([
      '--config',
      pairedPath,
      'config',
      '--url',
      'https://abaku.example.test/',
      '--token',
      'new-token',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://abaku.example.test/api/v1/about/user',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer new-token' }),
      }),
    );
    expect(JSON.parse(await readFile(pairedPath, 'utf8'))).toMatchObject({
      activeProfile: 'default',
      profiles: {
        default: { baseUrl: 'https://abaku.example.test', token: 'new-token' },
      },
    });
    expect(result.logs.join('\n')).toContain('配对成功');
  });

  test('admin users list and get use admin user endpoints', async () => {
    const fetchMock = mockJsonFetch({ data: [] });

    await runCli(['admin', 'users', 'list', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/users',
      expect.objectContaining({ method: 'GET' }),
    );

    await runCli(['admin', 'users', 'get', '7', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/users/7',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('admin users create update and delete map body flags to requests', async () => {
    const fetchMock = mockJsonFetch();

    await runCli([
      'admin',
      'users',
      'create',
      '--email',
      'admin@example.com',
      '--password',
      'secret',
      '--format',
      'json',
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/users',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(requestBody(fetchMock.mock.calls.at(-1)!)).toEqual({
      email: 'admin@example.com',
      password: 'secret',
    });

    await runCli([
      'admin',
      'users',
      'update',
      '7',
      '--email',
      'new@example.com',
      '--format',
      'json',
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/users/7',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(requestBody(fetchMock.mock.calls.at(-1)!)).toEqual({ email: 'new@example.com' });

    await runCli(['admin', 'users', 'delete', '7', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/users/7',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  test('config list get and set use configuration endpoints', async () => {
    const fetchMock = mockJsonFetch();

    await runCli(['config', 'list', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/configuration',
      expect.objectContaining({ method: 'GET' }),
    );

    await runCli(['config', 'get', 'is_demo_site', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/configuration/is_demo_site',
      expect.objectContaining({ method: 'GET' }),
    );

    await runCli(['config', 'set', 'is_demo_site', 'false', '--format', 'json']);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/api/v1/configuration/is_demo_site',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(requestBody(fetchMock.mock.calls.at(-1)!)).toEqual({ value: 'false' });
  });

  test('data export transactions writes the API response to a file', async () => {
    const fetchMock = mockJsonFetch({ data: [{ id: 'tx-1' }] });
    const outputPath = join(tempDir, 'transactions.json');

    const result = await runCli([
      'data',
      'export',
      'transactions',
      '--output',
      outputPath,
      '--format',
      'json',
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/data/export/transactions',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual({ data: [{ id: 'tx-1' }] });
    expect(result.logs.join('\n')).toContain(outputPath);
  });

  test('cron run uses the CLI token in the path', async () => {
    const fetchMock = mockJsonFetch({ ok: true });

    await runCli(['cron', 'run', '--token', 'cron-token', '--format', 'json']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/v1/cron/cron-token',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
