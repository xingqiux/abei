import { Command } from 'commander';

import { createCommandContext } from '../core/command-context.js';
import { FireflyInputError } from '../core/errors.js';
import { collectOption, parseKeyValueOptions } from '../core/key-value.js';
import { renderOutput } from '../core/output.js';
import { parseBodyOptions } from '../core/request-body.js';
import { ResourceService } from '../services/resource-service.js';
import { importTransactions } from '../services/transaction-import.js';
import {
  DEFAULT_EXCLUDE_CATEGORIES,
  fetchTransactionsForSummary,
  summarizeTransactions,
} from '../services/transaction-summary.js';

interface ListCommandOptions {
  page?: string;
  limit?: string;
  sort?: string;
  filter?: string[];
}

interface BodyCommandOptions {
  json?: string;
  body?: string;
  set?: string[];
}

interface NamedCreateOptions extends BodyCommandOptions {
  name?: string;
  type?: string;
}

interface AccountCreateOptions extends NamedCreateOptions {
  asset?: boolean;
  liability?: boolean;
  balance?: string;
  debt?: string;
  currency?: string;
  date?: string;
  liabilityType?: string;
  notes?: string;
}

interface TransactionCreateOptions extends BodyCommandOptions {
  type?: string;
  source?: string;
  destination?: string;
  amount?: string;
  description?: string;
}

interface TransactionImportOptions {
  input?: string;
  dryRun?: boolean;
  confirm?: boolean;
  timezone?: string;
}

interface TransactionSummaryCommandOptions {
  start?: string;
  end?: string;
  excludeCategory?: string[];
}

interface ResourceDefinition {
  name: string;
  endpoint: string;
  idLabel?: string;
  createFlags?: 'named' | 'none';
  updateFlags?: 'named' | 'none';
  extra?: (command: Command, definition: ResourceDefinition) => void;
}

const CRUD_RESOURCES: ResourceDefinition[] = [
  { name: 'accounts', endpoint: '/api/v1/accounts', createFlags: 'named', updateFlags: 'named' },
  { name: 'budgets', endpoint: '/api/v1/budgets', createFlags: 'named', updateFlags: 'named' },
  {
    name: 'categories',
    endpoint: '/api/v1/categories',
    createFlags: 'named',
    updateFlags: 'named',
  },
  {
    name: 'tags',
    endpoint: '/api/v1/tags',
    idLabel: 'tagOrId',
    createFlags: 'named',
    updateFlags: 'named',
  },
  { name: 'bills', endpoint: '/api/v1/bills', createFlags: 'named', updateFlags: 'named' },
  {
    name: 'currencies',
    endpoint: '/api/v1/currencies',
    idLabel: 'currencyCode',
    createFlags: 'named',
    updateFlags: 'named',
  },
  {
    name: 'webhooks',
    endpoint: '/api/v1/webhooks',
    createFlags: 'named',
    updateFlags: 'named',
    extra: registerWebhookExtras,
  },
];

export function registerResourceCommands(program: Command): void {
  for (const definition of CRUD_RESOURCES) {
    registerCrudResource(program, definition);
  }
  registerTransactions(program);
}

function registerCrudResource(program: Command, definition: ResourceDefinition): void {
  const resource = program
    .command(definition.name)
    .description(`Manage Firefly ${definition.name}.`);

  addListCommand(resource, definition);
  addGetCommand(resource, definition);
  addCreateCommand(resource, definition);
  addUpdateCommand(resource, definition);
  addDeleteCommand(resource, definition);
  definition.extra?.(resource, definition);
}

function addListCommand(resource: Command, definition: ResourceDefinition): void {
  resource
    .command('list')
    .description(`List ${definition.name}.`)
    .option('--page <page>', 'Page number.')
    .option('--limit <limit>', 'Page size.')
    .option('--sort <field>', 'Sort field.')
    .option('--filter <key=value>', 'Filter query parameter. Repeatable.', collectOption, [])
    .action(async function (options: ListCommandOptions) {
      const context = await createCommandContext(this);
      const service = new ResourceService(context.client, { endpoint: definition.endpoint });
      const result = await service.list(options);
      console.log(renderOutput(result, { format: context.format }));
    });
}

function addGetCommand(resource: Command, definition: ResourceDefinition): void {
  resource
    .command('get')
    .description(`Show one ${definition.name} item.`)
    .argument(`<${definition.idLabel ?? 'id'}>`, 'Resource identifier.')
    .action(async function (id: string) {
      const context = await createCommandContext(this);
      const service = new ResourceService(context.client, { endpoint: definition.endpoint });
      const result = await service.get(id);
      console.log(renderOutput(result, { format: context.format }));
    });
}

function addCreateCommand(resource: Command, definition: ResourceDefinition): void {
  const command = resource.command('create').description(`Create a ${definition.name} item.`);
  addBodyFlags(command);
  addNamedFlags(command, definition.createFlags);
  addAccountCreateFlags(command, definition);
  command.action(async function (options: NamedCreateOptions) {
    const context = await createCommandContext(this);
    const service = new ResourceService(context.client, { endpoint: definition.endpoint });
    const fallback =
      definition.name === 'accounts'
        ? buildAccountCreateBody(options as AccountCreateOptions)
        : buildNamedBody(options);
    const result = await service.create(await buildBody(options, fallback));
    console.log(renderOutput(result, { format: context.format }));
  });
}

function addUpdateCommand(resource: Command, definition: ResourceDefinition): void {
  const command = resource
    .command('update')
    .description(`Update a ${definition.name} item.`)
    .argument(`<${definition.idLabel ?? 'id'}>`, 'Resource identifier.');
  addBodyFlags(command);
  addNamedFlags(command, definition.updateFlags);
  command.action(async function (id: string, options: NamedCreateOptions) {
    const context = await createCommandContext(this);
    const service = new ResourceService(context.client, { endpoint: definition.endpoint });
    const result = await service.update(id, await buildBody(options, buildNamedBody(options)));
    console.log(renderOutput(result, { format: context.format }));
  });
}

function addDeleteCommand(resource: Command, definition: ResourceDefinition): void {
  resource
    .command('delete')
    .description(`Delete a ${definition.name} item.`)
    .argument(`<${definition.idLabel ?? 'id'}>`, 'Resource identifier.')
    .action(async function (id: string) {
      const context = await createCommandContext(this);
      const service = new ResourceService(context.client, { endpoint: definition.endpoint });
      const result = await service.delete(id);
      console.log(renderOutput(result, { format: context.format }));
    });
}

function registerTransactions(program: Command): void {
  const resource = program.command('transactions').description('Manage Firefly transactions.');
  const definition = { name: 'transactions', endpoint: '/api/v1/transactions' };
  addListCommand(resource, definition);
  addGetCommand(resource, definition);
  addUpdateCommand(resource, { ...definition, updateFlags: 'none' });
  addDeleteCommand(resource, definition);

  resource
    .command('create')
    .description('Create a transaction group.')
    .option('--type <type>', 'Transaction type.')
    .option('--source <id>', 'Source account ID.')
    .option('--destination <id>', 'Destination account ID.')
    .option('--amount <amount>', 'Transaction amount.')
    .option('--description <description>', 'Transaction description.')
    .option('--json <json>', 'Inline JSON request body.')
    .option('--body <file>', 'Read JSON request body from file.')
    .action(async function (options: TransactionCreateOptions) {
      const context = await createCommandContext(this);
      const service = new ResourceService(context.client, { endpoint: definition.endpoint });
      const result = await service.create(await buildTransactionBody(options));
      console.log(renderOutput(result, { format: context.format }));
    });

  resource
    .command('import')
    .description('Preview or import transaction groups from a JSON file.')
    .requiredOption('--input <file>', 'Read transactions from a JSON file.')
    .option('--dry-run', 'Preview rows without creating transactions.')
    .option('--confirm', 'Create rows that are not duplicates or ambiguous.')
    .option(
      '--timezone <iana>',
      'Source timezone for local transaction dates, for example Asia/Shanghai.',
    )
    .action(async function (options: TransactionImportOptions) {
      if (options.dryRun && options.confirm) {
        throw new FireflyInputError('Use either --dry-run or --confirm, not both.');
      }
      const context = await createCommandContext(this);
      const result = await importTransactions(context.client, {
        input: options.input!,
        mode: options.confirm ? 'confirm' : 'dry-run',
        timezone: options.timezone,
      });
      console.log(renderOutput(result, { format: context.format }));
    });

  resource
    .command('summary')
    .description(
      'Read-only spending summary: totals by transaction type, daily-consumption spend ' +
        '(withdrawals minus transfers/excluded categories), top categories and merchants, ' +
        'payment-account distribution, and a per-day breakdown.',
    )
    .option('--start <date>', 'Start date (YYYY-MM-DD), inclusive.')
    .option('--end <date>', 'End date (YYYY-MM-DD), inclusive.')
    .option(
      '--exclude-category <name>',
      `Category name to exclude from daily-consumption totals, in addition to the defaults ` +
        `(${DEFAULT_EXCLUDE_CATEGORIES.join(', ')}). Repeatable.`,
      collectOption,
      [],
    )
    .action(async function (options: TransactionSummaryCommandOptions) {
      const context = await createCommandContext(this);
      const range = { start: options.start, end: options.end };
      const transactions = await fetchTransactionsForSummary(context.client, range);
      const result = summarizeTransactions(
        transactions,
        { excludeCategories: options.excludeCategory },
        range,
      );
      console.log(renderOutput(result, { format: context.format }));
    });
}

function registerWebhookExtras(resource: Command, definition: ResourceDefinition): void {
  resource
    .command('submit')
    .description('Submit a webhook manually.')
    .argument('<id>', 'Webhook identifier.')
    .action(async function (id: string) {
      const context = await createCommandContext(this);
      const service = new ResourceService(context.client, { endpoint: definition.endpoint });
      const result = await service.post(`${encodeURIComponent(id)}/submit`);
      console.log(renderOutput(result, { format: context.format }));
    });
}

function addBodyFlags(command: Command): void {
  command
    .option('--json <json>', 'Inline JSON request body.')
    .option('--body <file>', 'Read JSON request body from file.')
    .option('--set <key=value>', 'Set a JSON field. Repeatable.', collectOption, []);
}

function addNamedFlags(command: Command, mode: ResourceDefinition['createFlags']): void {
  if (mode === 'named') {
    command.option('--name <name>', 'Resource name.').option('--type <type>', 'Resource type.');
  }
}

function addAccountCreateFlags(command: Command, definition: ResourceDefinition): void {
  if (definition.name !== 'accounts') {
    return;
  }
  command
    .option('--asset', 'Create an asset account with personal-finance defaults.')
    .option('--liability', 'Create a liability account with personal-finance defaults.')
    .option('--balance <amount>', 'Opening balance for asset accounts.')
    .option('--debt <amount>', 'Opening debt balance for liability accounts.')
    .option('--currency <code>', 'Currency code for the account.', 'CNY')
    .option('--date <date>', 'Opening balance date, YYYY-MM-DD.')
    .option('--liability-type <type>', 'Liability type, for example debt or loan.')
    .option('--notes <notes>', 'Account notes.');
}

async function buildBody(
  options: BodyCommandOptions,
  fallback: Record<string, unknown>,
): Promise<unknown> {
  const parsed = await parseBodyOptions(options);
  if (parsed.json !== undefined) {
    return parsed.json;
  }
  return { ...fallback, ...parseKeyValueOptions(options.set) };
}

function buildNamedBody(options: NamedCreateOptions): Record<string, unknown> {
  return stripUndefined({
    name: options.name,
    type: options.type,
  });
}

function buildAccountCreateBody(options: AccountCreateOptions): Record<string, unknown> {
  if (options.asset && options.liability) {
    throw new FireflyInputError('Use either --asset or --liability, not both.');
  }
  if (options.asset) {
    return buildAssetAccountBody(options);
  }
  if (options.liability) {
    return buildLiabilityAccountBody(options);
  }
  return buildNamedBody(options);
}

function buildAssetAccountBody(options: AccountCreateOptions): Record<string, unknown> {
  return stripUndefined({
    name: options.name,
    type: 'asset',
    account_role: 'defaultAsset',
    currency_code: options.currency,
    opening_balance: options.balance,
    opening_balance_date: options.date ?? today(),
    notes: options.notes,
  });
}

function buildLiabilityAccountBody(options: AccountCreateOptions): Record<string, unknown> {
  const liabilityType = options.liabilityType ?? 'debt';
  return stripUndefined({
    name: options.name,
    type: 'liability',
    liability_type: liabilityType,
    liability_direction: 'debit',
    currency_code: options.currency,
    opening_balance: options.debt ?? options.balance,
    opening_balance_date: options.date ?? today(),
    interest: '0',
    interest_period: liabilityType === 'loan' ? 'yearly' : 'monthly',
    notes: options.notes,
  });
}

async function buildTransactionBody(options: TransactionCreateOptions): Promise<unknown> {
  const parsed = await parseBodyOptions(options);
  if (parsed.json !== undefined) {
    return parsed.json;
  }

  const transaction = stripUndefined({
    type: options.type,
    source_id: options.source,
    destination_id: options.destination,
    amount: options.amount,
    description: options.description,
  });
  if (Object.keys(transaction).length === 0) {
    throw new FireflyInputError('Provide transaction fields or pass --json/--body.');
  }
  return { transactions: [transaction] };
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function today(): string {
  return new Date().toLocaleDateString('en-CA');
}
