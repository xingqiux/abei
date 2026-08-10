/**
 * abei-agent 进程入口。这个包只剩一件事：给 abei-web 提供 `/api/ai`。
 * 命令行已经由 abei-cli（二进制 `abei`）接管，这里不再有子命令。
 */
import { pathToFileURL } from 'node:url';

import { runAgentServer } from './agent/server.js';

interface Options {
  host?: string;
  port?: number;
  fireflyUrl?: string;
  abeiUrl?: string;
}

const FLAGS: Record<string, keyof Options> = {
  '--host': 'host',
  '--port': 'port',
  '--firefly-url': 'fireflyUrl',
  '--abei-url': 'abeiUrl',
};

export function parseArgs(argv: string[]): Options {
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // Makefile 和 compose 目前还传着 `agent serve` 两个词；目录改名那一波会去掉。
    // 裸词一律忽略，拼错的选项要报出来。
    if (!arg.startsWith('--')) continue;
    const [flag, inline] = arg.includes('=') ? splitOnce(arg, '=') : [arg, undefined];
    const key = FLAGS[flag];
    if (!key) throw new Error(`未知选项 ${flag}。可用：${Object.keys(FLAGS).join(' ')}`);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`${flag} 需要一个值。`);
    if (key === 'port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error('--port 必须是 0 到 65535 之间的整数。');
      }
      options.port = port;
    } else {
      options[key] = value;
    }
  }
  return options;
}

function splitOnce(value: string, separator: string): [string, string] {
  const at = value.indexOf(separator);
  return [value.slice(0, at), value.slice(at + separator.length)];
}

async function main(): Promise<void> {
  await runAgentServer(parseArgs(process.argv.slice(2)));
}

// 直接跑这个文件才起服务；被测试或别的模块引入时只暴露 parseArgs。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
