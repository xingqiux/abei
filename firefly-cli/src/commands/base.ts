import { Command } from 'commander';

import { createCommandContext } from '../core/command-context.js';
import { renderOutput } from '../core/output.js';
import { parseBodyOptions } from '../core/request-body.js';
import { parseQueryOptions } from '../core/query.js';
import { defaultLocalDoctorUrl, runLocalDoctor } from '../services/local-doctor.js';

interface ApiOptions {
  json?: string;
  body?: string;
  query?: string[];
}

interface DoctorLocalOptions {
  root?: string;
  url?: string;
}

const DEFAULT_DOCTOR_URL = defaultLocalDoctorUrl();

export function registerBaseCommands(program: Command): void {
  program
    .command('ping')
    .description('Check that Firefly III is reachable.')
    .action(async function () {
      const context = await createCommandContext(this);
      await context.client.request('GET', '/api/v1/about');
      console.log('Firefly III is reachable.');
    });

  program
    .command('about')
    .description('Show Firefly III API metadata.')
    .action(async function () {
      const context = await createCommandContext(this);
      const result = await context.client.request('GET', '/api/v1/about');
      console.log(renderOutput(result, { format: context.format }));
    });

  program
    .command('me')
    .description('Show the authenticated Firefly III user.')
    .action(async function () {
      const context = await createCommandContext(this);
      const result = await context.client.request('GET', '/api/v1/about/user');
      console.log(renderOutput(result, { format: context.format }));
    });

  program
    .command('api')
    .description('Call any Firefly III API endpoint.')
    .argument('<method>', 'HTTP method.')
    .argument('<path>', 'API path, for example /api/v1/accounts.')
    .option('--json <json>', 'Inline JSON request body.')
    .option('--body <file>', 'Read JSON request body from file.')
    .option('--query <key=value>', 'Query string key/value. Repeatable.', collect, [])
    .action(async function (method: string, path: string, options: ApiOptions) {
      const context = await createCommandContext(this);
      const body = await parseBodyOptions(options);
      const result = await context.client.request(method, path, {
        ...body,
        query: parseQueryOptions(options.query),
      });
      console.log(renderOutput(result, { format: context.format }));
    });

  const doctor = program.command('doctor').description('Diagnose local Firefly III setup.');
  doctor
    .command('local')
    .description(
      'Check local Firefly III root, DB config, TZ/APP_URL, storage cache, and HTTP reachability.',
    )
    .option('--root <path>', 'Path to the Firefly III root.', '../firefly-iii')
    .option('--url <url>', 'Local Firefly III URL.', DEFAULT_DOCTOR_URL)
    .action(async function (options: DoctorLocalOptions) {
      const globals = this.optsWithGlobals();
      const report = await runLocalDoctor({
        root: options.root ?? '../firefly-iii',
        url: options.url ?? DEFAULT_DOCTOR_URL,
      });
      console.log(renderOutput(report, { format: globals.format ?? 'json' }));
    });
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
