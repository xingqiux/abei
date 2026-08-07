import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { registerAuthCommands } from './commands/auth.js';
import { registerAiCommands } from './commands/ai.js';
import { registerBaseCommands } from './commands/base.js';
import { registerBillInboxCommands } from './commands/bill-inbox.js';
import { registerPlatformCommands } from './commands/platform.js';
import { registerResourceCommands } from './commands/resources.js';
import { ConfigStore } from './core/config-store.js';
import type { GlobalOptions } from './core/command-context.js';
import { FireflyHttpClient } from './core/http-client.js';
import { renderOutput, type OutputFormat } from './core/output.js';
import { loadSystemOverview } from './services/system-overview.js';

export function createProgram(): Command {
  const program = new Command();
  program
    .name('ffc')
    .description('Command-line client for Firefly III.')
    .version('1.0.0')
    .option('--profile <name>', 'Config profile to use.')
    .option('--format <format>', 'Output format: json or raw.', parseFormat, 'json')
    .option('--config <file>', 'Path to config file.')
    .option('--trace-id <uuid>', 'Send X-Trace-Id header.')
    .option('--timeout <ms>', 'Request timeout in milliseconds.')
    .showSuggestionAfterError()
    .showHelpAfterError()
    .addHelpText(
      'after',
      `
快速开始:
  1. 在 Abaku「设置 > AI 与 CLI」生成配对命令
  2. 运行 ffc config --url <url> --token <token>
  3. 再运行 ffc 查看账况、待办和可用能力

常用命令:
  ffc transactions create --help   记一笔
  ffc bill-inbox --help            处理账单任务
  ffc transactions summary --help 查看消费汇总
  ffc <command> --help             查看任一功能的参数和示例`,
    );
  registerAuthCommands(program);
  registerAiCommands(program);
  registerBaseCommands(program);
  registerBillInboxCommands(program);
  registerResourceCommands(program);
  registerPlatformCommands(program);
  program.action(async function () {
    await showOverview(this.optsWithGlobals());
  });
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function parseFormat(value: string): OutputFormat {
  if (value === 'json' || value === 'raw') {
    return value;
  }
  throw new Error('Format must be one of: json, raw.');
}

async function showOverview(options: GlobalOptions): Promise<void> {
  const store = new ConfigStore(options.config);
  const active = await store.getActiveProfile(options.profile);
  const format = options.format ?? 'json';
  if (!active) {
    const result = {
      status: 'unconfigured',
      configFile: store.getPath(),
      next: '在 Abaku「设置 > AI 与 CLI」复制配对命令，然后在这里运行。',
      command: 'ffc config --url <url> --token <token>',
    };
    console.log(renderOutput(result, { format }));
    return;
  }

  const client = new FireflyHttpClient({
    baseUrl: active.baseUrl,
    token: active.token,
    traceId: options.traceId,
    timeout: options.timeout ? Number(options.timeout) : undefined,
  });
  const overview = await loadSystemOverview(client, {
    profile: active.name,
    baseUrl: active.baseUrl,
  });
  console.log(renderOutput(overview, { format }));
}

export function isCliEntrypoint(moduleUrl: string, argvPath?: string): boolean {
  if (!argvPath) {
    return false;
  }
  return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
}
