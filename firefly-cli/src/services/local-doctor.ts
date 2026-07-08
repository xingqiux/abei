import { execFile } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ASSET_ACCOUNT_TYPE = 'Asset account';
const DEFAULT_ACCOUNTING_TIMEZONE = 'Asia/Shanghai';

export interface LocalDoctorOptions {
  root: string;
  url: string;
  fetchImpl?: typeof fetch;
  sqliteQuery?: SqliteQuery;
}

export interface LocalDoctorReport {
  ok: boolean;
  checks: LocalDoctorCheck[];
}

export interface LocalDoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  path?: string;
  expected?: string;
  actual?: string;
}

export type SqliteQuery = (
  databasePath: string,
  sql: string,
) => Promise<Array<Record<string, unknown>>>;

export async function runLocalDoctor(options: LocalDoctorOptions): Promise<LocalDoctorReport> {
  const root = resolve(options.root);
  const appUrl = normalizeUrl(options.url);
  const env = await readEnv(root);
  const databasePath = resolveDatabasePath(root, env);
  const checks: LocalDoctorCheck[] = [
    await checkRoot(root),
    await checkDatabase(databasePath),
    checkAppUrl(env, appUrl),
    checkTimezone(env),
    await checkV2Assets(root),
    await checkV1Assets(root),
    await checkStorageCache(root),
    await checkFrontpageAccounts(databasePath, options.sqliteQuery ?? querySqlite),
    await checkHttp(appUrl, options.fetchImpl ?? fetch),
  ];

  return {
    ok: checks.every((check) => check.status === 'ok'),
    checks,
  };
}

async function checkRoot(root: string): Promise<LocalDoctorCheck> {
  const artisan = join(root, 'artisan');
  if (await exists(artisan)) {
    return {
      name: 'root',
      status: 'ok',
      message: `Firefly III root found at ${root}.`,
    };
  }
  return {
    name: 'root',
    status: 'fail',
    message: `Firefly III root not found at ${root}. Expected an artisan file.`,
    path: artisan,
  };
}

async function checkDatabase(databasePath: string): Promise<LocalDoctorCheck> {
  if (await exists(databasePath)) {
    return {
      name: 'database',
      status: 'ok',
      message: 'SQLite database exists.',
      path: databasePath,
    };
  }
  return {
    name: 'database',
    status: 'fail',
    message: 'SQLite database is missing.',
    path: databasePath,
  };
}

function checkAppUrl(env: Record<string, string>, checkedUrl: string): LocalDoctorCheck {
  const actual = env.APP_URL ? normalizeUrl(env.APP_URL) : undefined;
  if (!actual) {
    return {
      name: 'app-url',
      status: 'warn',
      message: `APP_URL is not set. Checked URL is ${checkedUrl}.`,
      expected: checkedUrl,
    };
  }
  if (actual !== checkedUrl) {
    return {
      name: 'app-url',
      status: 'warn',
      message: `APP_URL points to ${actual} but checked URL is ${checkedUrl}.`,
      expected: checkedUrl,
      actual,
    };
  }
  return {
    name: 'app-url',
    status: 'ok',
    message: `APP_URL matches ${checkedUrl}.`,
    expected: checkedUrl,
    actual,
  };
}

function checkTimezone(env: Record<string, string>): LocalDoctorCheck {
  const actual = env.TZ;
  if (!actual) {
    return {
      name: 'timezone',
      status: 'warn',
      message: `TZ is not set. Local accounting imports expect ${DEFAULT_ACCOUNTING_TIMEZONE}.`,
      expected: DEFAULT_ACCOUNTING_TIMEZONE,
    };
  }
  if (actual !== DEFAULT_ACCOUNTING_TIMEZONE) {
    return {
      name: 'timezone',
      status: 'warn',
      message: `TZ is ${actual} but local accounting imports expect ${DEFAULT_ACCOUNTING_TIMEZONE}. Update firefly-iii/.env or pass --timezone when importing.`,
      expected: DEFAULT_ACCOUNTING_TIMEZONE,
      actual,
    };
  }
  return {
    name: 'timezone',
    status: 'ok',
    message: `TZ matches ${DEFAULT_ACCOUNTING_TIMEZONE}.`,
    expected: DEFAULT_ACCOUNTING_TIMEZONE,
    actual,
  };
}

async function checkV2Assets(root: string): Promise<LocalDoctorCheck> {
  const path = join(root, 'public', 'build', 'manifest.json');
  if (await exists(path)) {
    return {
      name: 'v2-assets',
      status: 'ok',
      message: 'Vite manifest exists.',
      path,
    };
  }
  return {
    name: 'v2-assets',
    status: 'fail',
    message:
      'Missing public/build/manifest.json. Run npm install and npm run build --workspace resources/assets/v2 from firefly-iii.',
    path,
  };
}

async function checkV1Assets(root: string): Promise<LocalDoctorCheck> {
  const path = join(root, 'public', 'v1', 'js', 'app.js');
  if (await exists(path)) {
    return {
      name: 'v1-assets',
      status: 'ok',
      message: 'V1 app.js exists.',
      path,
    };
  }
  return {
    name: 'v1-assets',
    status: 'fail',
    message:
      'Missing public/v1/js/app.js. Run npm run production --workspace resources/assets/v1 from firefly-iii and hard refresh the browser.',
    path,
  };
}

/**
 * Laravel's file cache store (config/cache.php) writes to
 * storage/framework/cache/data and does not recreate that nested directory
 * on its own once it is wiped (a fresh checkout, a cleared volume, or an
 * operator running `rm -rf storage/framework/cache/*` all reproduce this).
 * When it is missing or not writable, EVERY Firefly API call fails with a
 * 500 (file_put_contents(...): Failed to open stream: No such file or
 * directory), which is easy to misread as an import-specific bug. Catch it
 * here before it gets that far.
 */
async function checkStorageCache(root: string): Promise<LocalDoctorCheck> {
  const dataDir = join(root, 'storage', 'framework', 'cache', 'data');
  if (!(await exists(dataDir))) {
    return {
      name: 'storage-cache',
      status: 'fail',
      message:
        'storage/framework/cache/data is missing. Laravel does not recreate this directory itself, so every API call will fail with HTTP 500 (file_put_contents ... No such file or directory) until it exists and is writable. Create it (and storage/framework/sessions, storage/framework/views, storage/logs, bootstrap/cache) and chown it to the web server user.',
      path: dataDir,
    };
  }

  const probePath = join(dataDir, `.ffc-doctor-write-check-${process.pid}`);
  try {
    await writeFile(probePath, '');
    await rm(probePath, { force: true });
  } catch (error) {
    return {
      name: 'storage-cache',
      status: 'fail',
      message: `storage/framework/cache/data exists but is not writable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      path: dataDir,
    };
  }

  return {
    name: 'storage-cache',
    status: 'ok',
    message: 'storage/framework/cache/data exists and is writable.',
    path: dataDir,
  };
}

async function checkFrontpageAccounts(
  databasePath: string,
  sqliteQuery: SqliteQuery,
): Promise<LocalDoctorCheck> {
  if (!(await exists(databasePath))) {
    return {
      name: 'frontpage-accounts',
      status: 'warn',
      message: 'Skipped frontpageAccounts check because the SQLite database is missing.',
      path: databasePath,
    };
  }

  try {
    const preferences = await sqliteQuery(
      databasePath,
      "select data from preferences where name = 'frontpageAccounts' limit 1",
    );
    const selectedIds = parseFrontpageIds(preferences[0]?.data);
    if (selectedIds.length === 0) {
      return {
        name: 'frontpage-accounts',
        status: 'ok',
        message: 'frontpageAccounts has no selected account IDs.',
      };
    }

    const selectedAccounts = await sqliteQuery(
      databasePath,
      `select accounts.id, accounts.name, account_types.type, accounts.deleted_at
       from accounts
       join account_types on account_types.id = accounts.account_type_id
       where accounts.id in (${selectedIds.join(',')})`,
    );
    const activeSelectedAssets = selectedAccounts.filter(
      (account) => account.type === ASSET_ACCOUNT_TYPE && !account.deleted_at,
    );
    if (activeSelectedAssets.length > 0) {
      return {
        name: 'frontpage-accounts',
        status: 'ok',
        message: `frontpageAccounts includes active asset account IDs: ${activeSelectedAssets
          .map((account) => account.id)
          .join(', ')}.`,
      };
    }

    const activeAssets = await sqliteQuery(
      databasePath,
      `select accounts.id, accounts.name
       from accounts
       join account_types on account_types.id = accounts.account_type_id
       where account_types.type = '${ASSET_ACCOUNT_TYPE}' and accounts.deleted_at is null
       order by accounts.id
       limit 10`,
    );
    const activeAssetIds = activeAssets.map((account) => String(account.id));
    return {
      name: 'frontpage-accounts',
      status: 'warn',
      message: `frontpageAccounts references no active asset accounts. Selected IDs: ${selectedIds.join(
        ', ',
      )}. Active asset IDs: ${activeAssetIds.length > 0 ? activeAssetIds.join(', ') : 'none'}.`,
      actual: selectedIds.join(','),
      expected: activeAssetIds.join(','),
    };
  } catch (error) {
    return {
      name: 'frontpage-accounts',
      status: 'warn',
      message: `Could not inspect frontpageAccounts: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

async function checkHttp(url: string, fetchImpl: typeof fetch): Promise<LocalDoctorCheck> {
  try {
    const response = await fetchImpl(`${url}/`, { method: 'GET' });
    const status = response.ok || response.status < 500 ? 'ok' : 'fail';
    return {
      name: 'http',
      status,
      message: `${url}/ responded with HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      name: 'http',
      status: 'fail',
      message: `Could not reach ${url}/: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readEnv(root: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(join(root, '.env'), 'utf8');
    return Object.fromEntries(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index), stripQuotes(line.slice(index + 1))];
        }),
    );
  } catch {
    return {};
  }
}

async function querySqlite(
  databasePath: string,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const { stdout } = await execFileAsync('sqlite3', ['-json', databasePath, sql]);
  if (stdout.trim() === '') {
    return [];
  }
  return JSON.parse(stdout) as Array<Record<string, unknown>>;
}

function resolveDatabasePath(root: string, env: Record<string, string>): string {
  const databasePath = env.DB_DATABASE ?? join(root, 'storage', 'database', 'database.sqlite');
  return databasePath.startsWith('/') ? databasePath : join(root, databasePath);
}

function parseFrontpageIds(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
