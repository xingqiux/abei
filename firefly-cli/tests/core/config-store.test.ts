import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ConfigStore, getDefaultConfigPath, redactToken } from '../../src/core/config-store.js';

let tempDir: string;
let configPath: string;
const previousConfigEnv = process.env.FIREFLY_CLI_CONFIG;
const previousHomeEnv = process.env.HOME;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'firefly-cli-config-'));
  configPath = join(tempDir, 'config.json');
  process.env.FIREFLY_CLI_CONFIG = configPath;
  process.env.HOME = tempDir;
});

afterEach(async () => {
  if (previousConfigEnv === undefined) {
    delete process.env.FIREFLY_CLI_CONFIG;
  } else {
    process.env.FIREFLY_CLI_CONFIG = previousConfigEnv;
  }
  if (previousHomeEnv === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHomeEnv;
  }
  await rm(tempDir, { force: true, recursive: true });
});

describe('getDefaultConfigPath', () => {
  test('uses FIREFLY_CLI_CONFIG when present', () => {
    expect(getDefaultConfigPath()).toBe(configPath);
  });

  test('falls back to ~/.config/firefly-cli/config.json', () => {
    delete process.env.FIREFLY_CLI_CONFIG;

    expect(getDefaultConfigPath()).toBe(join(tempDir, '.config', 'firefly-cli', 'config.json'));
  });
});

describe('ConfigStore', () => {
  test('creates a profile and makes it active', async () => {
    const store = new ConfigStore(configPath);

    await store.setToken({
      profile: 'local',
      baseUrl: 'http://127.0.0.1:8000/',
      token: 'secret-token',
    });

    const config = await store.load();
    expect(config.activeProfile).toBe('local');
    expect(config.profiles.local).toEqual({
      baseUrl: 'http://127.0.0.1:8000',
      token: 'secret-token',
    });
  });

  test('switches the active profile', async () => {
    const store = new ConfigStore(configPath);
    await store.setToken({
      profile: 'local',
      baseUrl: 'http://localhost:8000',
      token: 'local-token',
    });
    await store.setToken({
      profile: 'prod',
      baseUrl: 'https://firefly.example',
      token: 'prod-token',
    });

    await store.useProfile('local');

    const config = await store.load();
    expect(config.activeProfile).toBe('local');
    expect(await store.getActiveProfile()).toMatchObject({
      name: 'local',
      baseUrl: 'http://localhost:8000',
      token: 'local-token',
    });
  });

  test('reports malformed config instead of silently overwriting it', async () => {
    await writeFile(configPath, '{bad json', 'utf8');
    const store = new ConfigStore(configPath);

    await expect(store.load()).rejects.toThrow('Could not read Firefly CLI config');
  });

  test('writes config as JSON', async () => {
    const store = new ConfigStore(configPath);

    await store.setToken({ profile: 'local', baseUrl: 'http://localhost:8000', token: 'token' });

    const raw = await readFile(configPath, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({
      activeProfile: 'local',
      profiles: {
        local: {
          baseUrl: 'http://localhost:8000',
          token: 'token',
        },
      },
    });
  });
});

describe('redactToken', () => {
  test('hides most token characters', () => {
    expect(redactToken('abcdefghijklmnopqrstuvwxyz')).toBe('********wxyz');
  });

  test('handles short tokens', () => {
    expect(redactToken('abc')).toBe('***');
  });
});
