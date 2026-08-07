import { Command } from 'commander';

import { runAgentServer } from '../agent/server.js';
import { runMcpServer } from '../capabilities/mcp-server.js';
import { createCommandContext } from '../core/command-context.js';
import { FireflyInputError } from '../core/errors.js';

interface AgentServeOptions {
  host?: string;
  port?: string;
  fireflyUrl?: string;
}

export function registerAiCommands(program: Command): void {
  program
    .command('mcp')
    .description('Expose the approved FFC capability registry over MCP stdio.')
    .action(async function () {
      const context = await createCommandContext(this);
      await runMcpServer(context.client);
    });

  program
    .command('agent')
    .description('Run the trusted Abaku AI service.')
    .command('serve')
    .description('Serve /api/ai for abaku-web.')
    .option('--host <host>', 'Listen host (default: AI_HOST or 127.0.0.1).')
    .option('--port <port>', 'Listen port (default: AI_PORT or 18003).')
    .option('--firefly-url <url>', 'Firefly base URL (default: FIREFLY_URL).')
    .action(async (options: AgentServeOptions) => {
      await runAgentServer({
        host: options.host,
        port: parsePort(options.port),
        fireflyUrl: options.fireflyUrl,
      });
    });
}

function parsePort(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new FireflyInputError('--port must be an integer between 0 and 65535.');
  }
  return port;
}
