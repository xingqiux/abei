import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { FireflyConfigError } from './errors.js';

export interface FireflyProfile {
  baseUrl: string;
  token: string;
}

export interface FireflyCliConfig {
  activeProfile?: string;
  timeout: number;
  profiles: Record<string, FireflyProfile>;
}

export interface ActiveProfile extends FireflyProfile {
  name: string;
}

export interface SetTokenInput {
  profile: string;
  baseUrl: string;
  token: string;
}

const DEFAULT_TIMEOUT_MS = 30000;

export function getDefaultConfigPath(): string {
  return process.env.FIREFLY_CLI_CONFIG ?? join(homedir(), '.config', 'firefly-cli', 'config.json');
}

export function createEmptyConfig(): FireflyCliConfig {
  return {
    activeProfile: undefined,
    timeout: DEFAULT_TIMEOUT_MS,
    profiles: {},
  };
}

export function redactToken(token?: string): string {
  if (!token) {
    return '';
  }
  if (token.length <= 4) {
    return '*'.repeat(token.length);
  }
  return `********${token.slice(-4)}`;
}

export class ConfigStore {
  constructor(private readonly path = getDefaultConfigPath()) {}

  getPath(): string {
    return this.path;
  }

  async load(): Promise<FireflyCliConfig> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<FireflyCliConfig>;
      return normalizeConfig(parsed);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return createEmptyConfig();
      }
      throw new FireflyConfigError(
        `Could not read Firefly CLI config at ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async save(config: FireflyCliConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.path, 0o600);
  }

  async setToken(input: SetTokenInput): Promise<FireflyCliConfig> {
    const config = await this.load();
    const profile = input.profile.trim();
    const token = input.token.trim();
    if (!profile) {
      throw new FireflyConfigError('Profile name cannot be empty.');
    }
    if (!token) {
      throw new FireflyConfigError('Token cannot be empty.');
    }
    config.activeProfile = profile;
    config.profiles[profile] = {
      baseUrl: normalizeBaseUrl(input.baseUrl),
      token,
    };
    await this.save(config);
    return config;
  }

  async useProfile(profile: string): Promise<FireflyCliConfig> {
    const config = await this.load();
    if (!config.profiles[profile]) {
      throw new Error(`Profile "${profile}" does not exist.`);
    }
    config.activeProfile = profile;
    await this.save(config);
    return config;
  }

  async getActiveProfile(profileOverride?: string): Promise<ActiveProfile | undefined> {
    const config = await this.load();
    const name = profileOverride ?? config.activeProfile;
    if (!name) {
      return undefined;
    }
    const profile = config.profiles[name];
    if (!profile) {
      return undefined;
    }
    return { name, ...profile };
  }
}

function normalizeConfig(input: Partial<FireflyCliConfig>): FireflyCliConfig {
  const profiles =
    input.profiles && typeof input.profiles === 'object' && !Array.isArray(input.profiles)
      ? input.profiles
      : {};

  return {
    activeProfile: typeof input.activeProfile === 'string' ? input.activeProfile : undefined,
    timeout:
      typeof input.timeout === 'number' && input.timeout > 0 ? input.timeout : DEFAULT_TIMEOUT_MS,
    profiles,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('URL must use http or https.');
    }
  } catch (error) {
    throw new FireflyConfigError(
      `Invalid Firefly URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return normalized;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
