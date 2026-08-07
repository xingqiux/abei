import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createProgram } from '../../src/cli.js';

let tempDir: string;
let configPath: string;
const previousConfigEnv = process.env.FIREFLY_CLI_CONFIG;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'firefly-cli-auth-'));
  configPath = join(tempDir, 'config.json');
  process.env.FIREFLY_CLI_CONFIG = configPath;
});

afterEach(async () => {
  if (previousConfigEnv === undefined) {
    delete process.env.FIREFLY_CLI_CONFIG;
  } else {
    process.env.FIREFLY_CLI_CONFIG = previousConfigEnv;
  }
  await rm(tempDir, { force: true, recursive: true });
  vi.restoreAllMocks();
});

async function runCli(args: string[]) {
  const program = createProgram();
  program.exitOverride();
  await program.parseAsync(args, { from: 'user' });
}

describe('auth commands', () => {
  test('set-token stores a profile', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCli([
      'auth',
      'set-token',
      '--profile',
      'local',
      '--url',
      'http://127.0.0.1:8000/',
      '--token',
      'secret-token',
    ]);

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.activeProfile).toBe('local');
    expect(config.profiles.local).toMatchObject({
      baseUrl: 'http://127.0.0.1:8000',
      token: 'secret-token',
    });
    expect(log).toHaveBeenCalledWith('Saved profile "local" for http://127.0.0.1:8000.');
  });

  test('use switches active profile', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli([
      'auth',
      'set-token',
      '--profile',
      'local',
      '--url',
      'http://localhost',
      '--token',
      'a',
    ]);
    await runCli([
      'auth',
      'set-token',
      '--profile',
      'prod',
      '--url',
      'https://example.test',
      '--token',
      'b',
    ]);

    await runCli(['auth', 'use', 'local']);

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.activeProfile).toBe('local');
  });

  test('status prints redacted active token', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli([
      'auth',
      'set-token',
      '--profile',
      'local',
      '--url',
      'http://localhost',
      '--token',
      'abcdefghijklmnopqrstuvwxyz',
    ]);

    await runCli(['auth', 'status']);

    expect(log).toHaveBeenLastCalledWith(
      'Active profile: local\nBase URL: http://localhost\nToken: ********wxyz',
    );
  });

  test('all auth commands honor the global config path', async () => {
    delete process.env.FIREFLY_CLI_CONFIG;
    const explicitPath = join(tempDir, 'explicit.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCli([
      '--config',
      explicitPath,
      'auth',
      'set-token',
      '--profile',
      'local',
      '--url',
      'http://localhost',
      '--token',
      'explicit-token',
    ]);
    await runCli(['--config', explicitPath, 'auth', 'use', 'local']);
    await runCli(['--config', explicitPath, 'auth', 'status']);

    const config = JSON.parse(await readFile(explicitPath, 'utf8'));
    expect(config.activeProfile).toBe('local');
    expect(log).toHaveBeenLastCalledWith(
      'Active profile: local\nBase URL: http://localhost\nToken: ********oken',
    );
  });
});
