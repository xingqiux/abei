import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runLocalDoctor } from '../../src/services/local-doctor.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'firefly-cli-doctor-'));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

async function scaffoldRoot(options?: {
  env?: string[];
  monorepoEnv?: string[];
  withCache?: boolean;
}): Promise<string> {
  const rootPath = join(tempDir, 'firefly-iii');
  await mkdir(rootPath, { recursive: true });
  await writeFile(join(rootPath, 'artisan'), '');
  if (options?.withCache) {
    await mkdir(join(rootPath, 'storage', 'framework', 'cache', 'data'), { recursive: true });
  }
  if (options?.env) {
    await writeFile(join(rootPath, '.env'), options.env.join('\n'));
  }
  if (options?.monorepoEnv) {
    await writeFile(join(tempDir, '.env'), options.monorepoEnv.join('\n'));
  }
  return rootPath;
}

describe('local doctor service', () => {
  test('passes when monorepo .env has pgsql, TZ, APP_URL and cache is writable', async () => {
    const rootPath = await scaffoldRoot({
      withCache: true,
      monorepoEnv: [
        'APP_URL=http://localhost:18001',
        'TZ=Asia/Shanghai',
        'DB_CONNECTION=pgsql',
        'DB_HOST=127.0.0.1',
        'DB_PORT=15432',
        'DB_DATABASE=firefly',
        'FIREFLY_PORT=18001',
      ],
    });

    const report = await runLocalDoctor({
      root: rootPath,
      url: 'http://127.0.0.1:18001',
      fetchImpl: async () => new Response('', { status: 302 }),
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual({
      name: 'database',
      status: 'ok',
      message: 'PostgreSQL configured (127.0.0.1:15432/firefly).',
      actual: 'pgsql',
    });
    expect(report.checks).toContainEqual({
      name: 'app-url',
      status: 'ok',
      message: 'APP_URL matches http://127.0.0.1:18001.',
      expected: 'http://127.0.0.1:18001',
      actual: 'http://localhost:18001',
    });
    expect(report.checks.find((c) => c.name === 'v1-assets')).toBeUndefined();
    expect(report.checks.find((c) => c.name === 'v2-assets')).toBeUndefined();
    expect(report.checks.find((c) => c.name === 'frontpage-accounts')).toBeUndefined();
  });

  test('warns when DB_CONNECTION is sqlite', async () => {
    const rootPath = await scaffoldRoot({
      withCache: true,
      env: ['DB_CONNECTION=sqlite', 'TZ=Asia/Shanghai', 'APP_URL=http://127.0.0.1:18001'],
    });

    const report = await runLocalDoctor({
      root: rootPath,
      url: 'http://127.0.0.1:18001',
      fetchImpl: async () => new Response('', { status: 200 }),
    });

    expect(report.checks).toContainEqual({
      name: 'database',
      status: 'warn',
      message: 'DB_CONNECTION=sqlite. This project expects PostgreSQL (compose db / make dev).',
      expected: 'pgsql',
      actual: 'sqlite',
    });
    expect(report.ok).toBe(false);
  });

  test('fails storage-cache check when storage/framework/cache/data is missing', async () => {
    const rootPath = await scaffoldRoot({
      monorepoEnv: ['DB_CONNECTION=pgsql', 'TZ=Asia/Shanghai'],
    });

    const report = await runLocalDoctor({
      root: rootPath,
      url: 'http://127.0.0.1:18001',
      fetchImpl: async () => new Response('', { status: 302 }),
    });

    const check = report.checks.find((item) => item.name === 'storage-cache');
    expect(check).toMatchObject({
      status: 'fail',
      path: join(rootPath, 'storage', 'framework', 'cache', 'data'),
    });
    expect(check?.message).toContain('storage/framework/cache/data is missing');
    expect(report.ok).toBe(false);
  });

  test('passes storage-cache check when storage/framework/cache/data exists and is writable', async () => {
    const rootPath = await scaffoldRoot({
      withCache: true,
      monorepoEnv: ['DB_CONNECTION=pgsql'],
    });

    const report = await runLocalDoctor({
      root: rootPath,
      url: 'http://127.0.0.1:18001',
      fetchImpl: async () => new Response('', { status: 302 }),
    });

    expect(report.checks).toContainEqual({
      name: 'storage-cache',
      status: 'ok',
      message: 'storage/framework/cache/data exists and is writable.',
      path: join(rootPath, 'storage', 'framework', 'cache', 'data'),
    });
  });

  test('firefly-iii .env overrides monorepo parent .env', async () => {
    const rootPath = await scaffoldRoot({
      withCache: true,
      monorepoEnv: ['TZ=Europe/Amsterdam', 'DB_CONNECTION=sqlite'],
      env: [
        'TZ=Asia/Shanghai',
        'DB_CONNECTION=pgsql',
        'DB_HOST=db',
        'DB_PORT=5432',
        'DB_DATABASE=firefly',
        'APP_URL=http://127.0.0.1:18001',
      ],
    });

    const report = await runLocalDoctor({
      root: rootPath,
      url: 'http://127.0.0.1:18001',
      fetchImpl: async () => new Response('', { status: 200 }),
    });

    expect(report.checks.find((c) => c.name === 'timezone')).toMatchObject({
      status: 'ok',
      actual: 'Asia/Shanghai',
    });
    expect(report.checks.find((c) => c.name === 'database')).toMatchObject({
      status: 'ok',
      actual: 'pgsql',
    });
  });
});
