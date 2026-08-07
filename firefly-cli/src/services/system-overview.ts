import type { FireflyHttpClient } from '../core/http-client.js';

export interface SystemOverview {
  status: 'connected';
  connection: {
    profile: string;
    baseUrl: string;
    email?: string;
    role?: string;
  };
  period: {
    start: string;
    end: string;
  };
  finances: Array<{
    currency: string;
    symbol: string;
    decimals: number;
    income: string;
    expense: string;
    cashflow: string;
    netWorth: string;
    unpaidSubscriptions: string;
  }>;
  tasks: {
    billInbox: {
      total: number;
      pending: number;
      review: number;
      needsCode: number;
      unprocessed: number;
      failed: number;
      rowsReady: number;
    };
    reconciliation: {
      daysUnreconciled: number;
      lastReconciledDate: string | null;
    };
  };
  capabilities: Array<{ name: string; command: string }>;
}

const CAPABILITIES = [
  { name: '记账与查询', command: 'ffc transactions --help' },
  { name: '账单收件箱', command: 'ffc bill-inbox --help' },
  { name: '消费汇总', command: 'ffc transactions summary --help' },
  { name: '账户与预算', command: 'ffc accounts --help / ffc budgets --help' },
];

export async function loadSystemOverview(
  client: FireflyHttpClient,
  connection: { profile: string; baseUrl: string },
  now = new Date(),
): Promise<SystemOverview> {
  const period = currentMonth(now);
  const [user, summary, inbox, reconciliation] = await Promise.all([
    client.request('GET', '/api/v1/about/user'),
    client.request('GET', '/api/v1/summary/basic', { query: period }),
    client.request('GET', '/api/v1/bill-inbox/summary'),
    client.request('GET', '/api/v1/daily-reconciliation/summary', { query: { days: 30 } }),
  ]);

  const userAttributes = nestedRecord(user, 'data', 'attributes');
  const inboxRecord = asRecord(inbox);
  const channels = Array.isArray(inboxRecord.channels) ? inboxRecord.channels : [];
  const review = sumChannelNumber(channels, 'parsed');

  return {
    status: 'connected',
    connection: {
      ...connection,
      email: stringValue(userAttributes.email),
      role: stringValue(userAttributes.role),
    },
    period,
    finances: parseFinances(summary),
    tasks: {
      billInbox: {
        total: numberValue(inboxRecord.pending_total) + review,
        pending: numberValue(inboxRecord.pending_total),
        review,
        needsCode: numberValue(inboxRecord.needs_code),
        unprocessed: numberValue(inboxRecord.unprocessed),
        failed: numberValue(inboxRecord.failed),
        rowsReady: sumChannelNumber(channels, 'to_store'),
      },
      reconciliation: {
        daysUnreconciled: numberValue(asRecord(reconciliation).days_unreconciled),
        lastReconciledDate: stringValue(asRecord(reconciliation).last_reconciled_date) ?? null,
      },
    },
    capabilities: CAPABILITIES,
  };
}

function currentMonth(now: Date): { start: string; end: string } {
  const year = now.getFullYear();
  const month = now.getMonth();
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  return {
    start: `${prefix}-01`,
    end: `${prefix}-${String(new Date(year, month + 1, 0).getDate()).padStart(2, '0')}`,
  };
}

function parseFinances(value: unknown): SystemOverview['finances'] {
  const buckets = new Map<string, SystemOverview['finances'][number]>();
  for (const entry of Object.values(asRecord(value))) {
    const item = asRecord(entry);
    const key = stringValue(item.key);
    if (!key) {
      continue;
    }
    const currency = stringValue(item.currency_code) ?? key.split('-in-')[1];
    if (!currency) {
      continue;
    }
    const bucket = buckets.get(currency) ?? {
      currency,
      symbol: stringValue(item.currency_symbol) ?? currency,
      decimals: numberValue(item.currency_decimal_places, 2),
      income: '0',
      expense: '0',
      cashflow: '0',
      netWorth: '0',
      unpaidSubscriptions: '0',
    };
    const amount = stringValue(item.monetary_value) ?? '0';
    if (key.startsWith('earned-in-')) bucket.income = amount;
    if (key.startsWith('spent-in-')) bucket.expense = amount;
    if (key.startsWith('balance-in-')) bucket.cashflow = amount;
    if (key.startsWith('net-worth-in-')) bucket.netWorth = amount;
    if (key.startsWith('bills-unpaid-in-')) bucket.unpaidSubscriptions = amount;
    buckets.set(currency, bucket);
  }
  return [...buckets.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

function sumChannelNumber(channels: unknown[], key: string): number {
  return channels.reduce<number>((sum, channel) => sum + numberValue(asRecord(channel)[key]), 0);
}

function nestedRecord(value: unknown, ...keys: string[]): Record<string, unknown> {
  let current = asRecord(value);
  for (const key of keys) {
    current = asRecord(current[key]);
  }
  return current;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
