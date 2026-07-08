import type { FireflyHttpClient } from '../core/http-client.js';

/**
 * Category names that, by convention in this accounting setup, mark a
 * withdrawal-type transaction as NOT real day-to-day spending (internal
 * transfers modeled as withdrawals, cash withdrawals, balance corrections,
 * refunds, and credit borrow/repay movements). They are excluded from
 * `dailyConsumption` and the top-category/merchant/account breakdowns by
 * default. Callers can add more via --exclude-category.
 */
export const DEFAULT_EXCLUDE_CATEGORIES = ['账户转账', '提现', '余额调整', '退钱', '信用借还'];

export interface SummaryTransactionRow {
  type: string;
  date: string;
  amount: string;
  currency_code?: string;
  category_name?: string;
  description?: string;
  source_id?: string;
  source_name?: string;
  destination_id?: string;
  destination_name?: string;
}

export interface TransactionSummaryOptions {
  /** Category names to exclude from daily-consumption, in addition to DEFAULT_EXCLUDE_CATEGORIES. */
  excludeCategories?: string[];
}

export interface TransactionSummaryRange {
  start?: string;
  end?: string;
}

export interface TransactionSummaryCount {
  count: number;
  total: string;
}

export interface TransactionSummaryReport {
  range: TransactionSummaryRange;
  excludedCategories: string[];
  totals: {
    count: number;
    byType: Record<string, TransactionSummaryCount>;
  };
  dailyConsumption: TransactionSummaryCount;
  topCategories: Array<{ category: string; count: number; total: string }>;
  topMerchants: Array<{ merchant: string; count: number; total: string }>;
  paymentAccounts: Array<{ account: string; count: number; total: string }>;
  daily: Array<{ date: string; count: number; total: string }>;
}

const DEFAULT_TOP_LIMIT = 10;
const PAGE_LIMIT = 500;
const MAX_PAGES = 1000;

/**
 * Fetches every transaction in the given date range from Firefly, paging
 * through /api/v1/transactions until Firefly reports there are no more
 * pages (or the response stops returning rows).
 */
export async function fetchTransactionsForSummary(
  client: FireflyHttpClient,
  range: TransactionSummaryRange = {},
): Promise<SummaryTransactionRow[]> {
  const rows: SummaryTransactionRow[] = [];
  let page = 1;

  for (let fetched = 0; fetched < MAX_PAGES; fetched += 1) {
    const response = await client.request('GET', '/api/v1/transactions', {
      query: {
        start: range.start,
        end: range.end,
        limit: PAGE_LIMIT,
        page,
      },
    });
    const pageRows = extractSummaryTransactions(response);
    if (pageRows.length === 0) {
      break;
    }
    rows.push(...pageRows);

    const totalPages = extractTotalPages(response);
    if (page >= totalPages) {
      break;
    }
    page += 1;
  }

  return rows;
}

/** Flattens a Firefly JSON:API transaction-group list response into flat rows. */
export function extractSummaryTransactions(response: unknown): SummaryTransactionRow[] {
  if (!isRecord(response) || !Array.isArray(response.data)) {
    return [];
  }

  const rows: SummaryTransactionRow[] = [];
  for (const group of response.data) {
    if (!isRecord(group)) {
      continue;
    }
    const attributes = isRecord(group.attributes) ? group.attributes : {};
    const nested = Array.isArray(attributes.transactions) ? attributes.transactions : [attributes];
    for (const item of nested) {
      if (!isRecord(item)) {
        continue;
      }
      const type = stringValue(item.type);
      const date = stringValue(item.date);
      const amount = stringValue(item.amount);
      if (!type || !date || !amount) {
        continue;
      }
      rows.push({
        type: type.toLowerCase(),
        date,
        amount,
        currency_code: stringValue(item.currency_code),
        category_name: stringValue(item.category_name),
        description: stringValue(item.description),
        source_id: stringValue(item.source_id),
        source_name: stringValue(item.source_name),
        destination_id: stringValue(item.destination_id),
        destination_name: stringValue(item.destination_name),
      });
    }
  }
  return rows;
}

/**
 * Pure aggregation over already-fetched transaction rows. Kept free of any
 * HTTP/IO so it can be unit tested directly against fixture data.
 */
export function summarizeTransactions(
  rows: SummaryTransactionRow[],
  options: TransactionSummaryOptions = {},
  range: TransactionSummaryRange = {},
): TransactionSummaryReport {
  const excludedCategories = mergeExcludeCategories(options.excludeCategories);
  const excludedSet = new Set(excludedCategories.map(normalizeCategory));

  const byType = new Map<string, { count: number; total: number }>();
  for (const row of rows) {
    addToBucket(byType, row.type || 'unknown', toNumber(row.amount));
  }

  const consumptionRows = rows.filter(
    (row) => row.type === 'withdrawal' && !excludedSet.has(normalizeCategory(row.category_name)),
  );
  const dailyConsumptionTotal = consumptionRows.reduce((sum, row) => sum + toNumber(row.amount), 0);

  const categoryBuckets = new Map<string, { count: number; total: number }>();
  const merchantBuckets = new Map<string, { count: number; total: number }>();
  const accountBuckets = new Map<string, { count: number; total: number }>();
  const dailyBuckets = new Map<string, { count: number; total: number }>();
  for (const row of consumptionRows) {
    addToBucket(categoryBuckets, row.category_name || '(uncategorized)', toNumber(row.amount));
    addToBucket(
      merchantBuckets,
      row.destination_name || row.destination_id || '(unknown)',
      toNumber(row.amount),
    );
    addToBucket(
      accountBuckets,
      row.source_name || row.source_id || '(unknown)',
      toNumber(row.amount),
    );
    addToBucket(dailyBuckets, dateOnly(row.date), toNumber(row.amount));
  }

  return {
    range,
    excludedCategories,
    totals: {
      count: rows.length,
      byType: mapToRecord(byType),
    },
    dailyConsumption: {
      count: consumptionRows.length,
      total: formatAmount(dailyConsumptionTotal),
    },
    topCategories: sortedByTotal(categoryBuckets)
      .slice(0, DEFAULT_TOP_LIMIT)
      .map(({ name, count, total }) => ({ category: name, count, total: formatAmount(total) })),
    topMerchants: sortedByTotal(merchantBuckets)
      .slice(0, DEFAULT_TOP_LIMIT)
      .map(({ name, count, total }) => ({ merchant: name, count, total: formatAmount(total) })),
    paymentAccounts: sortedByTotal(accountBuckets).map(({ name, count, total }) => ({
      account: name,
      count,
      total: formatAmount(total),
    })),
    daily: sortedByKey(dailyBuckets).map(({ name, count, total }) => ({
      date: name,
      count,
      total: formatAmount(total),
    })),
  };
}

function mergeExcludeCategories(extra: string[] = []): string[] {
  const merged = [...DEFAULT_EXCLUDE_CATEGORIES];
  for (const category of extra) {
    const trimmed = category.trim();
    if (
      trimmed !== '' &&
      !merged.some((existing) => normalizeCategory(existing) === normalizeCategory(trimmed))
    ) {
      merged.push(trimmed);
    }
  }
  return merged;
}

function addToBucket(
  buckets: Map<string, { count: number; total: number }>,
  key: string,
  amount: number,
): void {
  const bucket = buckets.get(key) ?? { count: 0, total: 0 };
  bucket.count += 1;
  bucket.total += amount;
  buckets.set(key, bucket);
}

function mapToRecord(
  buckets: Map<string, { count: number; total: number }>,
): Record<string, TransactionSummaryCount> {
  const record: Record<string, TransactionSummaryCount> = {};
  for (const [key, value] of buckets) {
    record[key] = { count: value.count, total: formatAmount(value.total) };
  }
  return record;
}

interface Bucket {
  name: string;
  count: number;
  total: number;
}

function toBucketList(buckets: Map<string, { count: number; total: number }>): Bucket[] {
  return [...buckets.entries()].map(([name, value]) => ({
    name,
    count: value.count,
    total: value.total,
  }));
}

/** Highest total first. */
function sortedByTotal(buckets: Map<string, { count: number; total: number }>): Bucket[] {
  return toBucketList(buckets).sort((a, b) => b.total - a.total);
}

/** Ascending by name (used for per-day buckets, where name is a date). */
function sortedByKey(buckets: Map<string, { count: number; total: number }>): Bucket[] {
  return toBucketList(buckets).sort((a, b) => a.name.localeCompare(b.name));
}

function extractTotalPages(response: unknown): number {
  if (!isRecord(response) || !isRecord(response.meta) || !isRecord(response.meta.pagination)) {
    return 1;
  }
  const totalPages = Number((response.meta.pagination as Record<string, unknown>).total_pages);
  return Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1;
}

function toNumber(value?: string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatAmount(value: number): string {
  return value.toFixed(2);
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function normalizeCategory(value?: string): string {
  return (value ?? '').trim().toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const stringified = String(value).trim();
  return stringified === '' ? undefined : stringified;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
