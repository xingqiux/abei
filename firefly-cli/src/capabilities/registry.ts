import { Type, type TSchema } from '@earendil-works/pi-ai';
import { Value } from 'typebox/value';

import { FireflyInputError } from '../core/errors.js';
import type { FireflyHttpClient } from '../core/http-client.js';
import { BillTaskService } from '../services/bill-task-service.js';
import {
  fetchTransactionsForSummary,
  summarizeTransactions,
} from '../services/transaction-summary.js';

export type CapabilityRisk = 'read' | 'draft' | 'confirm';

export interface FfcCapability {
  name: string;
  label: string;
  description: string;
  risk: CapabilityRisk;
  parameters: TSchema;
  userInputParameters?: TSchema;
  preview?: (client: FireflyHttpClient, input: Record<string, unknown>) => Promise<unknown>;
  execute: (
    client: FireflyHttpClient,
    input: Record<string, unknown>,
    userInput?: Record<string, unknown>,
  ) => Promise<unknown>;
}

const id = Type.String({ pattern: '^[1-9][0-9]*$', description: 'Firefly numeric identifier.' });
const date = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD.' });
const optionalText = (maxLength: number) =>
  Type.Optional(Type.Union([Type.String({ maxLength }), Type.Null()]));

const CAPABILITIES: FfcCapability[] = [
  {
    name: 'list_bill_tasks',
    label: '查看账单任务',
    description: 'List bill inbox tasks, optionally filtered by source or status.',
    risk: 'read',
    parameters: Type.Object(
      {
        source: Type.Optional(Type.String({ maxLength: 64 })),
        status: Type.Optional(Type.String({ maxLength: 64 })),
        page: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_536 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      },
      { additionalProperties: false },
    ),
    execute: (client, input) =>
      new BillTaskService(client).list({
        source: input.source as string | undefined,
        status: input.status as string | undefined,
        page: input.page as number | undefined,
        limit: input.limit as number | undefined,
      }),
  },
  {
    name: 'review_bill_task',
    label: '审阅账单',
    description:
      'Read the server-classified, redacted review buckets for a bill task before editing rows.',
    risk: 'read',
    parameters: Type.Object({ task_id: id }, { additionalProperties: false }),
    execute: (client, input) => new BillTaskService(client).review(String(input.task_id)),
  },
  {
    name: 'update_bill_row',
    label: '填写账单建议',
    description:
      'Update editable fields on a pending bill row. Changes are always marked as AI suggestions.',
    risk: 'draft',
    parameters: Type.Object(
      {
        row_id: id,
        values: Type.Object(
          {
            firefly_type: optionalText(32),
            firefly_date: Type.Optional(Type.Union([date, Type.Null()])),
            firefly_amount: optionalText(64),
            firefly_description: optionalText(1000),
            source_name: optionalText(255),
            destination_name: optionalText(255),
            category_name: optionalText(255),
            notes: optionalText(32768),
            tags: Type.Optional(
              Type.Union([Type.Array(Type.String({ maxLength: 255 })), Type.Null()]),
            ),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
      },
      { additionalProperties: false },
    ),
    execute: (client, input) =>
      new BillTaskService(client).updateRow(String(input.row_id), {
        ...(input.values as Record<string, unknown>),
        as_suggestion: true,
      }),
  },
  {
    name: 'split_bill_row',
    label: '拆分组合支付',
    description: 'Split one pending combo-payment row into two or more draft rows.',
    risk: 'draft',
    parameters: Type.Object(
      {
        row_id: id,
        splits: Type.Array(
          Type.Object(
            {
              payment_method: Type.Optional(Type.String({ maxLength: 255 })),
              source_name: Type.Optional(Type.String({ maxLength: 255 })),
              amount: Type.String({ pattern: '^[0-9]+(?:\\.[0-9]{1,8})?$' }),
            },
            { additionalProperties: false },
          ),
          { minItems: 2, maxItems: 20 },
        ),
      },
      { additionalProperties: false },
    ),
    execute: (client, input) =>
      new BillTaskService(client).splitRow(
        String(input.row_id),
        input.splits as Array<{ payment_method?: string; source_name?: string; amount: string }>,
      ),
  },
  {
    name: 'import_bill_task',
    label: '导入账单',
    description:
      'Dry-run selected bill rows and request human approval before creating Firefly transactions.',
    risk: 'confirm',
    parameters: Type.Object(
      {
        task_id: id,
        all: Type.Optional(Type.Boolean()),
        row_ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 })),
        include_payload: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    preview: (client, input) => importBillRows(client, input, false),
    execute: (client, input) => importBillRows(client, input, true),
  },
  {
    name: 'submit_bill_secret',
    label: '提交账单密码',
    description:
      'Request a bill password from the user. The secret is entered in trusted UI and never shown to the model.',
    risk: 'confirm',
    parameters: Type.Object({ task_id: id }, { additionalProperties: false }),
    userInputParameters: Type.Object(
      { secret: Type.String({ minLength: 1, maxLength: 512 }) },
      { additionalProperties: false },
    ),
    execute: (client, input, userInput) =>
      new BillTaskService(client).submitSecret(String(input.task_id), String(userInput?.secret)),
  },
  {
    name: 'search_transactions',
    label: '搜索历史交易',
    description: 'Search existing Firefly transactions to find prior merchants and categories.',
    risk: 'read',
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 1000 }),
        page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      },
      { additionalProperties: false },
    ),
    execute: (client, input) =>
      client.request('GET', '/api/v1/search/transactions', {
        query: {
          query: String(input.query),
          page: input.page as number | undefined,
          limit: input.limit as number | undefined,
        },
      }),
  },
  {
    name: 'spending_summary',
    label: '汇总消费',
    description:
      'Calculate read-only spending totals, categories, merchants, accounts and daily breakdown.',
    risk: 'read',
    parameters: Type.Object(
      {
        start: Type.Optional(date),
        end: Type.Optional(date),
        exclude_categories: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 255 }), { maxItems: 50 }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (client, input) => {
      const range = {
        start: input.start as string | undefined,
        end: input.end as string | undefined,
      };
      const rows = await fetchTransactionsForSummary(client, range);
      return summarizeTransactions(
        rows,
        { excludeCategories: input.exclude_categories as string[] | undefined },
        range,
      );
    },
  },
];

const BY_NAME = new Map(CAPABILITIES.map((capability) => [capability.name, capability]));

export function listCapabilities(): readonly FfcCapability[] {
  return CAPABILITIES;
}

export function getCapability(name: string): FfcCapability {
  const capability = BY_NAME.get(name);
  if (!capability) {
    throw new FireflyInputError(`Unknown FFC capability: ${name}`);
  }
  return capability;
}

export function validateCapabilityInput(
  capability: FfcCapability,
  input: unknown,
): asserts input is Record<string, unknown> {
  if (!Value.Check(capability.parameters, input)) {
    throw new FireflyInputError(`Invalid input for ${capability.name}.`);
  }
}

export function validateCapabilityUserInput(
  capability: FfcCapability,
  userInput: unknown,
): asserts userInput is Record<string, unknown> {
  if (!capability.userInputParameters || !Value.Check(capability.userInputParameters, userInput)) {
    throw new FireflyInputError(`Missing or invalid user input for ${capability.name}.`);
  }
}

function importBillRows(
  client: FireflyHttpClient,
  input: Record<string, unknown>,
  confirm: boolean,
): Promise<unknown> {
  const all = input.all === true;
  const rowIds = input.row_ids as number[] | undefined;
  if (all === Boolean(rowIds?.length)) {
    throw new FireflyInputError('Pass either all=true or row_ids, not both.');
  }
  return new BillTaskService(client).importRows(String(input.task_id), {
    all,
    rowIds,
    confirm,
    includePayload: input.include_payload === true,
  });
}
