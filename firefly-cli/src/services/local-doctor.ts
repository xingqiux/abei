import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DEFAULT_ACCOUNTING_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_LOCAL_URL = 'http://127.0.0.1:18001';

export interface LocalDoctorOptions {
  root: string;
  url: string;
  fetchImpl?: typeof fetch;
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

export async function runLocalDoctor(options: LocalDoctorOptions): Promise<LocalDoctorReport> {
  const root = resolve(options.root);
  const appUrl = normalizeUrl(options.url);
  const env = await readEnvForRoot(root);
  const checks: LocalDoctorCheck[] = [
    await checkRoot(root),
    checkDatabaseConfig(env),
    checkAppUrl(env, appUrl),
    checkTimezone(env),
    await checkStorageCache(root),
    await checkHttp(appUrl, options.fetchImpl ?? fetch),
  ];

  return {
    ok: checks.every((check) => check.status === 'ok'),
    checks,
  };
}

export function defaultLocalDoctorUrl(): string {
  return DEFAULT_LOCAL_URL;
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

/**
 * This monorepo runs PostgreSQL (compose / make dev). SQLite file checks and
 * Firefly's own web frontend assets no longer apply — UI is abaku-web.
 */
function checkDatabaseConfig(env: Record<string, string>): LocalDoctorCheck {
  const connection = (env.DB_CONNECTION ?? '').toLowerCase();
  if (connection === 'pgsql' || connection === 'postgres' || connection === 'postgresql') {
    const host = env.DB_HOST ?? 'db';
    const port = env.DB_PORT ?? '5432';
    const database = env.DB_DATABASE ?? 'firefly';
    return {
      name: 'database',
      status: 'ok',
      message: `PostgreSQL configured (${host}:${port}/${database}).`,
      actual: connection,
    };
  }

  if (connection === 'sqlite' || connection === '') {
    return {
      name: 'database',
      status: 'warn',
      message:
        connection === 'sqlite'
          ? 'DB_CONNECTION=sqlite. This project expects PostgreSQL (compose db / make dev).'
          : 'DB_CONNECTION not set in .env. Compose injects pgsql at runtime; for make dev set DB_CONNECTION=pgsql against local Postgres.',
      expected: 'pgsql',
      actual: connection || undefined,
    };
  }

  return {
    name: 'database',
    status: 'warn',
    message: `Unexpected DB_CONNECTION=${connection}. This project expects pgsql.`,
    expected: 'pgsql',
    actual: connection,
  };
}

function checkAppUrl(env: Record<string, string>, checkedUrl: string): LocalDoctorCheck {
  const actual = env.APP_URL ? normalizeUrl(env.APP_URL) : undefined;
  if (!actual) {
    // Compose defaults APP_URL from FIREFLY_PORT when unset.
    const port = env.FIREFLY_PORT;
    if (port && checkedUrl.endsWith(`:${port}`)) {
      return {
        name: 'app-url',
        status: 'ok',
        message: `APP_URL unset; checked URL ${checkedUrl} matches FIREFLY_PORT=${port}.`,
        expected: checkedUrl,
      };
    }
    return {
      name: 'app-url',
      status: 'warn',
      message: `APP_URL is not set. Checked URL is ${checkedUrl}.`,
      expected: checkedUrl,
    };
  }
  if (actual !== checkedUrl && !urlsEquivalent(actual, checkedUrl)) {
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
      message: `TZ is ${actual} but local accounting imports expect ${DEFAULT_ACCOUNTING_TIMEZONE}. Update monorepo .env or pass --timezone when importing.`,
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

/**
 * Laravel's file cache store writes to storage/framework/cache/data and does
 * not recreate that nested directory once wiped. Relevant for `make dev`
 * (local artisan serve). Docker app image usually ships with the dirs present.
 */
async function checkStorageCache(root: string): Promise<LocalDoctorCheck> {
  const dataDir = join(root, 'storage', 'framework', 'cache', 'data');
  if (!(await exists(dataDir))) {
    return {
      name: 'storage-cache',
      status: 'fail',
      message:
        'storage/framework/cache/data is missing. Laravel does not recreate this directory itself, so every API call will fail with HTTP 500 until it exists and is writable. Create it (and storage/framework/sessions, storage/framework/views, storage/logs, bootstrap/cache) and chown it to the web server user.',
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

/**
 * Env lives in monorepo root for compose/make; firefly-iii/.env is optional.
 * firefly-iii values override parent when both exist.
 */
async function readEnvForRoot(root: string): Promise<Record<string, string>> {
  const parentEnv = await readEnvFile(join(root, '..', '.env'));
  const localEnv = await readEnvFile(join(root, '.env'));
  return { ...parentEnv, ...localEnv };
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(path, 'utf8');
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

/** localhost vs 127.0.0.1 with same port should not warn. */
function urlsEquivalent(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const hostAliases = new Set(['localhost', '127.0.0.1']);
    const sameHost =
      left.hostname === right.hostname ||
      (hostAliases.has(left.hostname) && hostAliases.has(right.hostname));
    const leftPort = left.port || (left.protocol === 'https:' ? '443' : '80');
    const rightPort = right.port || (right.protocol === 'https:' ? '443' : '80');
    return sameHost && leftPort === rightPort && left.protocol === right.protocol;
  } catch {
    return false;
  }
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
