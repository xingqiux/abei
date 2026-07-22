import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Command } from 'commander';

import { createCommandContext } from '../core/command-context.js';
import { FireflyInputError } from '../core/errors.js';
import { renderOutput } from '../core/output.js';
import { BillTaskService } from '../services/bill-task-service.js';

interface SecretSubmitOptions {
  value?: string;
}

interface BillTaskListOptions {
  source?: string;
  status?: string;
}

interface BillStatementRowListOptions {
  status?: string;
  from?: string;
  to?: string;
  summary?: boolean;
  limit?: string;
}

interface BillStatementRowUpdateOptions {
  set?: string[];
}

interface BillStatementRowSplitOptions {
  part?: string[];
}

interface BillStatementImportCommandOptions {
  all?: boolean;
  rows?: string;
  confirm?: boolean;
  includePayload?: boolean;
}

interface BillTaskArchiveOptions {
  ids?: string;
}

interface BillInboxRunOptions {
  limit?: string;
}

interface BillInboxSettingsSetOptions {
  enabled?: boolean;
  disabled?: boolean;
  provider?: string;
  email?: string;
  host?: string;
  port?: string;
  encryption?: string;
  username?: string;
  password?: string;
  folder?: string;
}

interface BillArtifactDownloadOptions {
  output?: string;
}

export function registerBillInboxCommands(program: Command): void {
  const bills = program
    .command('bill-inbox')
    .description('Manage Firefly bill email ingestion tasks.');

  bills
    .command('sync')
    .description('Sync configured bill mailbox messages and process queued tasks.')
    .option('--limit <count>', 'Maximum number of mailbox messages to scan.')
    .action(async function (options: BillInboxRunOptions) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const result = await service.sync(parseOptionalPositiveInteger(options.limit, '--limit'));
      console.log(renderOutput(result, { format: context.format }));
    });

  bills
    .command('process')
    .description('Process queued bill inbox tasks without scanning the mailbox.')
    .option('--limit <count>', 'Maximum number of queued tasks to process.')
    .action(async function (options: BillInboxRunOptions) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const result = await service.process(parseOptionalPositiveInteger(options.limit, '--limit'));
      console.log(renderOutput(result, { format: context.format }));
    });

  bills
    .command('cleanup-stale')
    .description('Archive stale bill inbox tasks that still wait for a secret.')
    .action(async function () {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const result = await service.cleanupStale();
      console.log(renderOutput(result, { format: context.format }));
    });

  bills
    .command('list')
    .description('List bill inbox tasks.')
    .option('--source <source>', 'Filter tasks by source, for example alipay.')
    .option('--status <status>', 'Filter tasks by status, for example parsed.')
    .action(async function (options: BillTaskListOptions) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const tasks = await service.list({
        source: blankToUndefined(options.source),
        status: blankToUndefined(options.status),
      });
      console.log(renderOutput(tasks, { format: context.format }));
    });

  bills
    .command('show')
    .description('Show a bill inbox task with related records.')
    .argument('<taskId>', 'Bill task identifier.')
    .action(async function (taskId: string) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const detail = await service.show(taskId);
      console.log(renderOutput(detail, { format: context.format }));
    });

  bills
    .command('rows')
    .description('List parsed statement rows for a bill inbox task.')
    .argument('<taskId>', 'Bill task identifier.')
    .option('--status <status>', 'Filter rows by import status.')
    .option('--from <date>', 'Only include rows on or after YYYY-MM-DD.')
    .option('--to <date>', 'Only include rows on or before YYYY-MM-DD.')
    .option('--summary', 'Return compact summary and redacted row previews.')
    .option('--limit <count>', 'Maximum number of redacted previews when using --summary.')
    .action(async function (taskId: string, options: BillStatementRowListOptions) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const rows = await service.rows(taskId, {
        status: blankToUndefined(options.status),
        from: blankToUndefined(options.from),
        to: blankToUndefined(options.to),
        summary: options.summary ? true : undefined,
        limit: parseOptionalPositiveInteger(options.limit, '--limit'),
      });
      console.log(renderOutput(rows, { format: context.format }));
    });

  bills
    .command('review')
    .description('Review parsed statement rows before importing into Firefly.')
    .argument('<taskId>', 'Bill task identifier.')
    .action(async function (taskId: string) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const review = await service.review(taskId);
      console.log(renderOutput(review, { format: context.format }));
      for (const advisory of [
        renderCrossSourceAdvisory(review),
        renderBalanceChainAdvisory(review),
      ]) {
        if (advisory !== undefined) {
          console.error(advisory);
        }
      }
    });

  const row = bills.command('row').description('Inspect or edit a parsed statement row.');
  row
    .command('show')
    .description('Show one parsed statement row with all fields.')
    .argument('<rowId>', 'Statement row identifier.')
    .action(async function (rowId: string) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const detail = await service.showRow(rowId);
      console.log(renderOutput(detail, { format: context.format }));
    });

  row
    .command('update')
    .description('Update editable statement row and Firefly draft fields.')
    .argument('<rowId>', 'Statement row identifier.')
    .requiredOption('--set <field=value>', 'Set a row field. Repeatable.', collect, [])
    .action(async function (rowId: string, options: BillStatementRowUpdateOptions) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const result = await service.updateRow(rowId, parseSetValues(options.set ?? []));
      console.log(renderOutput(result, { format: context.format }));
    });

  row
    .command('split')
    .description('Split a combo-payment statement row into importable rows.')
    .argument('<rowId>', 'Statement row identifier.')
    .requiredOption(
      '--part <payment=amount>',
      'Split part. Use payment=amount or payment:source=amount. Repeatable.',
      collect,
      [],
    )
    .action(async function (rowId: string, options: BillStatementRowSplitOptions) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const result = await service.splitRow(rowId, parseSplitParts(options.part ?? []));
      console.log(renderOutput(result, { format: context.format }));
    });

  bills
    .command('import')
    .description('Import parsed statement rows into Firefly transactions.')
    .argument('<taskId>', 'Bill task identifier.')
    .option('--all', 'Import all importable rows for the task.')
    .option('--rows <ids>', 'Comma-separated statement row IDs to import.')
    .option('--confirm', 'Actually create Firefly transactions. Without this, performs a dry run.')
    .option(
      '--include-payload',
      'Include sanitized Firefly transaction payloads in dry-run output.',
    )
    .action(async function (taskId: string, options: BillStatementImportCommandOptions) {
      if (options.all && options.rows) {
        throw new FireflyInputError('Use either --all or --rows, not both.');
      }
      if (!options.all && !options.rows) {
        throw new FireflyInputError('Pass --all or --rows to choose statement rows.');
      }

      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const result = await service.importRows(taskId, {
        all: options.all,
        rowIds: options.rows ? parseIdList(options.rows, '--rows') : undefined,
        confirm: options.confirm ?? false,
        includePayload: options.includePayload ?? false,
      });
      console.log(renderOutput(result, { format: context.format }));
    });

  bills
    .command('archive')
    .description('Archive one or many bill inbox tasks without deleting mail or artifacts.')
    .argument('[taskId]', 'Bill task identifier.')
    .option('--ids <ids>', 'Comma-separated task IDs to archive.')
    .action(async function (taskId: string | undefined, options: BillTaskArchiveOptions) {
      if (taskId && options.ids) {
        throw new FireflyInputError('Pass either a task ID or --ids, not both.');
      }
      if (!taskId && !options.ids) {
        throw new FireflyInputError('Pass a task ID or --ids to archive tasks.');
      }

      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const result = taskId
        ? await service.archive(taskId)
        : await service.archiveMany(parseIdList(String(options.ids), '--ids'));
      console.log(renderOutput(result, { format: context.format }));
    });

  bills
    .command('artifacts')
    .description('List artifacts for a bill inbox task.')
    .argument('<taskId>', 'Bill task identifier.')
    .action(async function (taskId: string) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const artifacts = await service.artifacts(taskId);
      console.log(renderOutput(artifacts, { format: context.format }));
    });

  const artifact = bills.command('artifact').description('Inspect or download a bill artifact.');
  artifact
    .command('download')
    .description('Download a bill artifact to a local file.')
    .argument('<artifactId>', 'Bill artifact identifier.')
    .requiredOption('--output <file>', 'Local output file path.')
    .action(async function (artifactId: string, options: BillArtifactDownloadOptions) {
      if (!options.output) {
        throw new FireflyInputError('Pass --output to choose where to save the artifact.');
      }

      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const bytes = await service.downloadArtifact(artifactId);
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, Buffer.from(bytes));
      console.log(
        renderOutput(
          {
            artifact_id: artifactId,
            output: options.output,
            bytes: bytes.byteLength,
          },
          { format: context.format },
        ),
      );
    });

  bills
    .command('events')
    .description('List event log entries for a bill inbox task.')
    .argument('<taskId>', 'Bill task identifier.')
    .action(async function (taskId: string) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const events = await service.events(taskId);
      console.log(renderOutput(events, { format: context.format }));
    });

  bills
    .command('ignore')
    .description('Mark a bill inbox task as ignored.')
    .argument('<taskId>', 'Bill task identifier.')
    .action(async function (taskId: string) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const result = await service.ignore(taskId);
      console.log(renderOutput(result, { format: context.format }));
    });

  bills
    .command('retry')
    .description('Requeue a bill inbox task for backend processing.')
    .argument('<taskId>', 'Bill task identifier.')
    .action(async function (taskId: string) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const result = await service.retry(taskId);
      console.log(renderOutput(result, { format: context.format }));
    });

  const secret = bills.command('secret').description('Manage bill inbox secret challenges.');
  secret
    .command('submit')
    .description('Submit a password or code for the current task challenge.')
    .argument('<taskId>', 'Bill task identifier.')
    .requiredOption('--value <secret>', 'Secret value to use for this processing attempt.')
    .action(async function (taskId: string, options: SecretSubmitOptions) {
      if (!options.value) {
        throw new FireflyInputError('Pass --value to submit a secret.');
      }
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const result = await service.submitSecret(taskId, options.value);
      console.log(renderOutput(result, { format: context.format }));
    });

  const settings = bills
    .command('settings')
    .description('Show or update bill inbox mailbox settings.');
  settings
    .command('show')
    .description('Show configured bill inbox mailbox settings.')
    .action(async function () {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const result = await service.settings();
      console.log(renderOutput(result, { format: context.format }));
    });

  settings
    .command('set')
    .description('Update bill inbox mailbox settings.')
    .option('--enabled', 'Enable bill mailbox sync.')
    .option('--disabled', 'Disable bill mailbox sync.')
    .option('--provider <provider>', 'Mailbox provider: gmail or imap.')
    .option('--email <email>', 'Mailbox email address.')
    .option('--host <host>', 'IMAP host.')
    .option('--port <port>', 'IMAP port.')
    .option('--encryption <mode>', 'IMAP encryption: none, ssl, tls, or starttls.')
    .option('--username <username>', 'Mailbox username.')
    .option('--password <password>', 'Mailbox password or app password.')
    .option('--folder <folder>', 'Mailbox folder, defaults to INBOX.')
    .action(async function (options: BillInboxSettingsSetOptions) {
      const context = await createCommandContext(this);
      const service = new BillTaskService(context.client);
      const result = await service.updateSettings(parseSettingsUpdate(options));
      console.log(renderOutput(result, { format: context.format }));
    });
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseSetValues(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new FireflyInputError(`Invalid --set value "${value}". Use field=value.`);
    }
    const key = value.slice(0, separator).trim();
    const fieldValue = value.slice(separator + 1);
    if (key === '') {
      throw new FireflyInputError(`Invalid --set value "${value}". Field name is empty.`);
    }
    parsed[key] = fieldValue;
  }
  return parsed;
}

function parseSplitParts(
  values: string[],
): Array<{ payment_method: string; source_name?: string; amount: string }> {
  if (values.length < 2) {
    throw new FireflyInputError('Pass at least two --part values.');
  }

  return values.map((value) => {
    const separator = value.lastIndexOf('=');
    if (separator <= 0) {
      throw new FireflyInputError(`Invalid --part value "${value}". Use payment=amount.`);
    }
    const left = value.slice(0, separator).trim();
    const amount = value.slice(separator + 1).trim();
    const [paymentMethod, sourceName] = left.split(':', 2).map((item) => item.trim());
    if (!paymentMethod || !amount) {
      throw new FireflyInputError(`Invalid --part value "${value}". Use payment=amount.`);
    }

    return {
      payment_method: paymentMethod,
      source_name: sourceName || undefined,
      amount,
    };
  });
}

function parseIdList(value: string, option: string): number[] {
  const ids = value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  if (ids.length === 0) {
    throw new FireflyInputError(`Pass at least one numeric ID to ${option}.`);
  }
  return ids;
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  option: string,
): number | undefined {
  if (undefined === value || '' === value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new FireflyInputError(`${option} must be a positive integer.`);
  }

  return parsed;
}

function parseSettingsUpdate(
  options: BillInboxSettingsSetOptions,
): Record<string, string | number | boolean> {
  if (options.enabled && options.disabled) {
    throw new FireflyInputError('Use either --enabled or --disabled, not both.');
  }

  const payload: Record<string, string | number | boolean> = {};
  if (options.enabled) {
    payload.enabled = true;
  }
  if (options.disabled) {
    payload.enabled = false;
  }
  for (const key of [
    'provider',
    'email',
    'host',
    'encryption',
    'username',
    'password',
    'folder',
  ] as const) {
    const value = options[key];
    if (undefined !== value && '' !== value.trim()) {
      payload[key] = value;
    }
  }
  if (undefined !== options.port && '' !== options.port.trim()) {
    payload.port = parseOptionalPositiveInteger(options.port, '--port') as number;
  }
  if (Object.keys(payload).length === 0) {
    throw new FireflyInputError('Pass at least one setting option to update.');
  }

  return payload;
}

function blankToUndefined(value?: string): string | undefined {
  return value && value.trim() !== '' ? value : undefined;
}

interface CrossSourceMatch {
  transaction_group_id?: string;
  confidence?: string;
  suggestion?: string;
}

interface CrossSourceCandidate {
  row_id?: string;
  row_number?: number;
  cross_source_matches?: CrossSourceMatch[];
}

/**
 * Builds a concise, human-facing advisory when the review payload flags rows
 * that likely duplicate existing Firefly transactions from another source.
 * Printed to stderr so `--format json` stdout stays machine-parseable — the
 * structured data is already carried in `cross_source_candidates` /
 * per-row `cross_source_matches`.
 */
function renderCrossSourceAdvisory(review: unknown): string | undefined {
  if (typeof review !== 'object' || review === null) {
    return undefined;
  }
  const candidates = (review as { cross_source_candidates?: unknown }).cross_source_candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return undefined;
  }

  const lines = (candidates as CrossSourceCandidate[]).map((candidate) => {
    const rowLabel = candidate.row_number ?? candidate.row_id ?? '?';
    const top = candidate.cross_source_matches?.[0];
    const txId = top?.transaction_group_id ?? '?';
    const confidence = top?.confidence ?? 'unknown';
    const suggestion = top?.suggestion ?? 'review';
    return `  - row ${rowLabel} → 交易 #${txId} (${confidence}, 建议 ${suggestion})`;
  });

  return [
    `⚠ ${candidates.length} 行疑似与已有 Firefly 交易重复（跨来源），导入前请核对：`,
    ...lines,
  ].join('\n');
}

interface BalanceChainEntry {
  account_name?: string;
  closes?: boolean;
  expected_after?: string;
  statement_balance?: string;
  difference?: string | null;
}

/**
 * Warns (on stderr) about asset accounts whose statement balance does not
 * reconcile with the expected Firefly balance after importing the selected
 * rows. The full per-account data is already carried in `balance_chain`.
 */
function renderBalanceChainAdvisory(review: unknown): string | undefined {
  if (typeof review !== 'object' || review === null) {
    return undefined;
  }
  const chain = (review as { balance_chain?: unknown }).balance_chain;
  if (typeof chain !== 'object' || chain === null) {
    return undefined;
  }
  const broken = Object.values(chain as Record<string, BalanceChainEntry>).filter(
    (entry) => entry && entry.closes === false,
  );
  if (broken.length === 0) {
    return undefined;
  }

  const lines = broken.map((entry) => {
    const name = entry.account_name ?? '?';
    return `  - ${name}：预期 ${entry.expected_after ?? '?'}，账单 ${entry.statement_balance ?? '?'}，差 ${entry.difference ?? '?'}`;
  });

  return [`⚠ ${broken.length} 个资产账户的余额链未闭合，导入前请核对：`, ...lines].join('\n');
}
