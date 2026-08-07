import { ConfigStore } from './config-store.js';
import { FireflyConfigError } from './errors.js';
import { FireflyHttpClient } from './http-client.js';
import type { OutputFormat } from './output.js';

export interface GlobalOptions {
  profile?: string;
  format?: OutputFormat;
  config?: string;
  traceId?: string;
  timeout?: string;
}

export interface CommandContext {
  client: FireflyHttpClient;
  format: OutputFormat;
}

export async function createCommandContext(command: {
  optsWithGlobals(): GlobalOptions;
}): Promise<CommandContext> {
  const options = command.optsWithGlobals();
  const store = new ConfigStore(options.config);
  const active = await store.getActiveProfile(options.profile);
  if (!active) {
    throw new FireflyConfigError(
      'No active Firefly profile configured. Run "ffc auth set-token" first.',
    );
  }

  return {
    client: new FireflyHttpClient({
      baseUrl: active.baseUrl,
      token: active.token,
      traceId: options.traceId,
      timeout: options.timeout ? Number(options.timeout) : undefined,
    }),
    format: options.format ?? 'json',
  };
}
