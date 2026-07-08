import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runLocalDoctor, type SqliteQuery } from '../../src/services/local-doctor.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'firefly-cli-doctor-'));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe('local doctor service', () => {
  test('warns when frontpage accounts reference only deleted accounts', async () => {
    const rootPath = join(tempDir, 'firefly-iii');
    const databasePath = join(rootPath, 'storage', 'database', 'database.sqlite');
    await mkdir(join(rootPath, 'public', 'build'), { recursive: true });
    await mkdir(join(rootPath, 'public', 'v1', 'js'), { recursive: true });
    await mkdir(join(rootPath, 'storage', 'database'), { recursive: true });
    await writeFile(join(rootPath, 'artisan'), '');
    await writeFile(join(rootPath, 'public', 'build', 'manifest.json'), '{}');
    await writeFile(join(rootPath, 'public', 'v1', 'js', 'app.js'), '');
    await writeFile(databasePath, '');
    await writeFile(
      join(rootPath, '.env'),
      [`APP_URL=http://127.0.0.1:8001`, `DB_DATABASE=${databasePath}`].join('\n'),
    );

    const sqliteQuery: SqliteQuery = async (_database, sql) => {
      if (sql.includes("from preferences where name = 'frontpageAccounts'")) {
        return [{ data: '[1,5]' }];
      }
      if (sql.includes('where id in (1,5)')) {
        return [
          { id: 1, name: 'Old Wallet', type: 'Asset account', deleted_at: '2026-01-01 00:00:00' },
          { id: 5, name: 'Old Bank', type: 'Asset account', deleted_at: '2026-01-01 00:00:00' },
        ];
      }
      if (sql.includes("where account_types.type = 'Asset account'")) {
        return [
          { id: 8, name: '微信钱包' },
          { id: 10, name: '中国银行' },
          { id: 12, name: '招商银行' },
        ];
      }
      return [];
    };

    const report = await runLocalDoctor({
      root: rootPath,
      url: 'http://127.0.0.1:8001',
      fetchImpl: async () => new Response('', { status: 302 }),
      sqliteQuery,
    });

    expect(report.checks).toContainEqual({
      name: 'frontpage-accounts',
      status: 'warn',
      message:
        'frontpageAccounts references no active asset accounts. Selected IDs: 1, 5. Active asset IDs: 8, 10, 12.',
      actual: '1,5',
      expected: '8,10,12',
    });
  });

  test('fails storage-cache check when storage/framework/cache/data is missing', async () => {
    const rootPath = join(tempDir, 'firefly-iii');
    const databasePath = join(rootPath, 'storage', 'database', 'database.sqlite');
    await mkdir(join(rootPath, 'public', 'build'), { recursive: true });
    await mkdir(join(rootPath, 'public', 'v1', 'js'), { recursive: true });
    await mkdir(join(rootPath, 'storage', 'database'), { recursive: true });
    await writeFile(join(rootPath, 'artisan'), '');
    await writeFile(join(rootPath, 'public', 'build', 'manifest.json'), '{}');
    await writeFile(join(rootPath, 'public', 'v1', 'js', 'app.js'), '');
    await writeFile(databasePath, '');

    const report = await runLocalDoctor({
      root: rootPath,
      url: 'http://127.0.0.1:8001',
      fetchImpl: async () => new Response('', { status: 302 }),
      sqliteQuery: async () => [],
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
    const rootPath = join(tempDir, 'firefly-iii');
    const databasePath = join(rootPath, 'storage', 'database', 'database.sqlite');
    await mkdir(join(rootPath, 'public', 'build'), { recursive: true });
    await mkdir(join(rootPath, 'public', 'v1', 'js'), { recursive: true });
    await mkdir(join(rootPath, 'storage', 'database'), { recursive: true });
    await mkdir(join(rootPath, 'storage', 'framework', 'cache', 'data'), { recursive: true });
    await writeFile(join(rootPath, 'artisan'), '');
    await writeFile(join(rootPath, 'public', 'build', 'manifest.json'), '{}');
    await writeFile(join(rootPath, 'public', 'v1', 'js', 'app.js'), '');
    await writeFile(databasePath, '');

    const report = await runLocalDoctor({
      root: rootPath,
      url: 'http://127.0.0.1:8001',
      fetchImpl: async () => new Response('', { status: 302 }),
      sqliteQuery: async () => [],
    });

    expect(report.checks).toContainEqual({
      name: 'storage-cache',
      status: 'ok',
      message: 'storage/framework/cache/data exists and is writable.',
      path: join(rootPath, 'storage', 'framework', 'cache', 'data'),
    });
  });
});
