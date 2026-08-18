/**
 * 进程生命周期：装配依赖、起 HTTP、收摊。
 *
 * 路由表在 routes.ts，这里只负责把真实依赖接上去。
 */

import { serve, type ServerType } from '@hono/node-server';

import { AbeiApi } from './abei-api.js';
import { AutofillWorker } from './autofill.js';
import { createModelRuntime, type ModelRuntime } from './model-runtime.js';
import { runtimeForOwner } from './model-settings.js';
import { createApp } from './routes.js';
import { AiStore, createAiPool } from './store.js';

export interface AgentServerOptions {
  host?: string;
  port?: number;
  fireflyUrl?: string;
  /** abei-api 地址。能力目录与能力调用都打这里。 */
  abeiUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AgentServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startAgentServer(
  options: AgentServerOptions = {},
): Promise<AgentServerHandle> {
  const env = options.env ?? process.env;
  const host = options.host ?? env.AI_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(env.AI_PORT ?? 18003);
  const fireflyUrl = (options.fireflyUrl ?? env.FIREFLY_URL ?? 'http://127.0.0.1:18001').replace(
    /\/+$/,
    '',
  );
  const abeiUrl = (options.abeiUrl ?? env.ABEI_API_URL ?? 'http://127.0.0.1:18002').replace(
    /\/+$/,
    '',
  );
  const abei = new AbeiApi({ baseUrl: abeiUrl });
  const store = new AiStore(createAiPool(env), env.APP_KEY);
  await store.initialize();
  // 过期的工作记录没人会翻。清不掉不影响起服务，记一行日志就行。
  await store.pruneAiRuns().catch((error: unknown) => {
    console.error(
      `[ai-runs] 清理过期记录失败：${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const environmentRuntime = createModelRuntime(env);
  const runtimeCache = new Map<string, ModelRuntime>();
  const activeSessions = new Set<string>();
  const autofill = new AutofillWorker({
    fireflyUrl,
    abeiUrl,
    store,
    resolveRuntime: (ownerKey) =>
      runtimeForOwner({ ownerKey, store, env, environmentRuntime, runtimeCache }),
  });

  const app = createApp({
    fireflyUrl,
    abei,
    store,
    env,
    environmentRuntime,
    runtimeCache,
    activeSessions,
    autofill,
  });
  const server = await listen(app.fetch, host, port);
  await autofill.start();
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://${host}:${actualPort}`,
    async close() {
      await closeServer(server);
      await autofill.stop();
      await store.close();
    },
  };
}

export async function runAgentServer(options: AgentServerOptions = {}): Promise<void> {
  const handle = await startAgentServer(options);
  console.log(`abei-agent listening on ${handle.url}`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await handle.close();
}

function listen(
  fetch: Parameters<typeof serve>[0]['fetch'],
  hostname: string,
  port: number,
): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, hostname, port }, () => resolve(server));
    server.once('error', reject);
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
