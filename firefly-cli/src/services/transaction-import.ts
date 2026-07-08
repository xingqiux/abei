import { readFile } from 'node:fs/promises';

import { FireflyInputError } from '../core/errors.js';
import type { FireflyHttpClient } from '../core/http-client.js';

export interface TransactionImportOptions {
  input: string;
  mode: 'dry-run' | 'confirm';
  timezone?: string;
}

export interface TransactionImportReport {
  mode: 'dry-run' | 'confirm';
  timezone?: string;
  summary: {
    total: number;
    create: number;
    duplicate: number;
    ambiguous: number;
    submitted?: number;
    created?: number;
    failed?: number;
  };
  rows: TransactionImportRowReport[];
  /** Present when exactly one row was submitted to Firefly. */
  response?: unknown;
  /**
   * Present when more than one row was submitted to Firefly. One entry per
   * submitted row, in the same order as `createRows`/the submitted rows.
   * A row that failed to create has `null` in its slot here; see that row's
   * `error` field in `rows` for the failure reason.
   */
  responses?: Array<unknown | null>;
}

export interface TransactionImportRowReport {
  row: number;
  status: 'create' | 'duplicate' | 'ambiguous' | 'created' | 'failed';
  transaction: FireflyTransactionImportRow;
  originalDate?: string;
  fireflyDate?: string;
  reasons?: string[];
  duplicateIds?: string[];
  /** Raw Firefly response for this row's own POST, when it was created. */
  response?: unknown;
  /** Failure message for this row's own POST, when it could not be created. */
  error?: string;
}

export interface FireflyTransactionImportRow {
  type?: string;
  date?: string;
  original_date?: string;
  source_id?: string;
  source_name?: string;
  destination_id?: string;
  destination_name?: string;
  amount?: string;
  description?: string;
  category_name?: string;
  notes?: string;
  tags?: string[];
}

interface ExistingTransaction {
  id: string;
  date?: string;
  source_id?: string;
  source_name?: string;
  destination_id?: string;
  destination_name?: string;
  amount?: string;
  description?: string;
}

export async function importTransactions(
  client: FireflyHttpClient,
  options: TransactionImportOptions,
): Promise<TransactionImportReport> {
  const transactions = applyTimezone(await readTransactions(options.input), options.timezone);
  const existing = await fetchExistingTransactions(client, transactions, options.mode);
  const rows = transactions.map((transaction, index) =>
    classifyTransaction(index + 1, transaction, existing),
  );
  const summary = summarize(rows);

  if (options.mode === 'dry-run') {
    return stripUndefined({ mode: options.mode, timezone: options.timezone, summary, rows });
  }

  const createRows = rows.filter((row) => row.status === 'create');
  if (createRows.length === 0) {
    return {
      mode: options.mode,
      timezone: options.timezone,
      summary: { ...summary, submitted: 0, created: 0, failed: 0 },
      rows,
    };
  }

  return submitCreateRows(client, options, rows, createRows, summary);
}

/**
 * Submits each independent create row as its own Firefly transaction group,
 * i.e. one POST /api/v1/transactions per row with a single-element
 * `transactions` array. Firefly treats every transaction inside a single
 * POST as a split of ONE group, which requires a `group_title` once there is
 * more than one -- these rows are independent transactions, not splits, so
 * each gets its own group and its own request.
 *
 * Rows are submitted sequentially so that a failure on one row never stops
 * the others from being attempted, and so the report can say exactly which
 * rows were created and which were not.
 */
async function submitCreateRows(
  client: FireflyHttpClient,
  options: TransactionImportOptions,
  rows: TransactionImportRowReport[],
  createRows: TransactionImportRowReport[],
  summary: TransactionImportReport['summary'],
): Promise<TransactionImportReport> {
  const updatedRows = [...rows];
  const responses: Array<unknown | null> = [];
  let created = 0;
  let failed = 0;

  for (const createRow of createRows) {
    const index = createRow.row - 1;
    try {
      const response = await client.request('POST', '/api/v1/transactions', {
        json: { transactions: [buildFireflyTransaction(createRow.transaction)] },
      });
      updatedRows[index] = { ...createRow, status: 'created', response };
      responses.push(response);
      created += 1;
    } catch (error) {
      updatedRows[index] = {
        ...createRow,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
      responses.push(null);
      failed += 1;
    }
  }

  return {
    mode: options.mode,
    timezone: options.timezone,
    summary: { ...summary, submitted: createRows.length, created, failed },
    rows: updatedRows,
    ...(createRows.length === 1
      ? responses[0] !== null
        ? { response: responses[0] }
        : {}
      : { responses }),
  };
}

async function readTransactions(path: string): Promise<FireflyTransactionImportRow[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new FireflyInputError(
      `Could not read transaction import file at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const rows = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.transactions : undefined;
  if (!Array.isArray(rows)) {
    throw new FireflyInputError(
      'Transaction import file must be a JSON array or an object with a transactions array.',
    );
  }

  return rows.map((row, index) => normalizeImportRow(row, index + 1));
}

function normalizeImportRow(row: unknown, index: number): FireflyTransactionImportRow {
  if (!isRecord(row)) {
    throw new FireflyInputError(`Transaction import row ${index} must be an object.`);
  }

  return stripUndefined({
    type: stringValue(row.type),
    date: stringValue(row.date),
    source_id: stringValue(row.source_id ?? row.source),
    source_name: stringValue(row.source_name),
    destination_id: stringValue(row.destination_id ?? row.destination),
    destination_name: stringValue(row.destination_name ?? row.merchant),
    amount: stringValue(row.amount),
    description: stringValue(row.description),
    category_name: stringValue(row.category_name ?? row.category),
    notes: stringValue(row.notes),
    tags: Array.isArray(row.tags) ? row.tags.map((tag) => String(tag)) : undefined,
  });
}

async function fetchExistingTransactions(
  client: FireflyHttpClient,
  transactions: FireflyTransactionImportRow[],
  mode: 'dry-run' | 'confirm',
): Promise<ExistingTransaction[]> {
  const dates = transactions
    .map((transaction) => transaction.date)
    .filter(isNonEmptyString)
    .map(dateOnly)
    .sort();
  if (dates.length === 0) {
    return [];
  }

  let response: unknown;
  try {
    response = await client.request('GET', '/api/v1/transactions', {
      query: {
        start: dates[0],
        end: dates.at(-1),
        limit: 500,
      },
    });
  } catch (error) {
    // This lookup always runs before any create request, so a failure here
    // means the import never got a chance to submit anything. Make that
    // explicit instead of leaving the operator to guess at partial state
    // from a bare error message.
    if (mode === 'confirm' && error instanceof Error) {
      error.message = `${error.message}\nNo transactions were created: the import failed before any row could be submitted.`;
    }
    throw error;
  }

  return extractExistingTransactions(response);
}

function extractExistingTransactions(response: unknown): ExistingTransaction[] {
  if (!isRecord(response) || !Array.isArray(response.data)) {
    return [];
  }

  const transactions: ExistingTransaction[] = [];
  for (const group of response.data) {
    if (!isRecord(group)) {
      continue;
    }
    const groupId = stringValue(group.id);
    const attributes = isRecord(group.attributes) ? group.attributes : {};
    const nested = Array.isArray(attributes.transactions) ? attributes.transactions : [attributes];
    for (const item of nested) {
      if (!isRecord(item)) {
        continue;
      }
      transactions.push({
        id: groupId ?? stringValue(item.transaction_journal_id) ?? '',
        date: stringValue(item.date),
        source_id: stringValue(item.source_id),
        source_name: stringValue(item.source_name),
        destination_id: stringValue(item.destination_id),
        destination_name: stringValue(item.destination_name),
        amount: stringValue(item.amount),
        description: stringValue(item.description),
      });
    }
  }
  return transactions.filter((transaction) => transaction.id !== '');
}

function classifyTransaction(
  row: number,
  transaction: FireflyTransactionImportRow,
  existing: ExistingTransaction[],
): TransactionImportRowReport {
  const reasons = validateTransaction(transaction);
  const dates = extractDateMetadata(transaction);
  if (reasons.length > 0) {
    return { row, status: 'ambiguous', transaction, ...dates, reasons };
  }

  const duplicateIds = existing
    .filter((candidate) => isLikelyDuplicate(transaction, candidate))
    .map((candidate) => candidate.id);
  if (duplicateIds.length > 0) {
    return { row, status: 'duplicate', transaction, ...dates, duplicateIds };
  }

  return { row, status: 'create', transaction, ...dates };
}

function applyTimezone(
  transactions: FireflyTransactionImportRow[],
  timezone?: string,
): FireflyTransactionImportRow[] {
  if (!timezone) {
    return transactions;
  }
  return transactions.map((transaction) => {
    if (!transaction.date) {
      return transaction;
    }
    return {
      ...transaction,
      original_date: transaction.date,
      date: convertLocalDateToFireflyDate(transaction.date, timezone),
    };
  });
}

function buildFireflyTransaction(
  transaction: FireflyTransactionImportRow,
): FireflyTransactionImportRow {
  const fireflyTransaction = { ...transaction };
  delete fireflyTransaction.original_date;
  return fireflyTransaction;
}

function convertLocalDateToFireflyDate(value: string, timezone: string): string {
  const offset = timezoneOffset(timezone);
  const normalized = value.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return `${normalized}T00:00:00${offset}`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
    return `${normalized}:00${offset}`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return `${normalized}${offset}`;
  }
  return value;
}

function timezoneOffset(timezone: string): string {
  if (timezone === 'Asia/Shanghai') {
    return '+08:00';
  }
  throw new FireflyInputError(
    `Unsupported timezone "${timezone}". Supported timezones: Asia/Shanghai.`,
  );
}

function extractDateMetadata(
  transaction: FireflyTransactionImportRow & { original_date?: string },
): Pick<TransactionImportRowReport, 'originalDate' | 'fireflyDate'> {
  if (!transaction.original_date) {
    return {};
  }
  return {
    originalDate: transaction.original_date,
    fireflyDate: transaction.date,
  };
}

function validateTransaction(transaction: FireflyTransactionImportRow): string[] {
  const reasons: string[] = [];
  if (!isNonEmptyString(transaction.type)) {
    reasons.push('type is required');
  }
  if (!isNonEmptyString(transaction.date)) {
    reasons.push('date is required');
  }
  if (!isNonEmptyString(transaction.amount)) {
    reasons.push('amount is required');
  }
  if (!isNonEmptyString(transaction.description)) {
    reasons.push('description is required');
  }
  if (!isNonEmptyString(transaction.source_id) && !isNonEmptyString(transaction.source_name)) {
    reasons.push('source_id or source_name is required');
  }
  if (
    !isNonEmptyString(transaction.destination_id) &&
    !isNonEmptyString(transaction.destination_name)
  ) {
    reasons.push('destination_id or destination_name is required');
  }
  return reasons;
}

function isLikelyDuplicate(
  transaction: FireflyTransactionImportRow,
  existing: ExistingTransaction,
): boolean {
  if (dateOnly(transaction.date) !== dateOnly(existing.date)) {
    return false;
  }
  if (normalizeAmount(transaction.amount) !== normalizeAmount(existing.amount)) {
    return false;
  }
  if (
    !matchesEither(
      transaction.source_id,
      existing.source_id,
      transaction.source_name,
      existing.source_name,
    )
  ) {
    return false;
  }
  const destinationMatches = matchesEither(
    transaction.destination_id,
    existing.destination_id,
    transaction.destination_name,
    existing.destination_name,
  );
  const descriptionMatches =
    normalizeText(transaction.description) === normalizeText(existing.description);
  return destinationMatches || descriptionMatches;
}

function matchesEither(
  leftId?: string,
  rightId?: string,
  leftName?: string,
  rightName?: string,
): boolean {
  if (isNonEmptyString(leftId) && isNonEmptyString(rightId)) {
    return leftId === rightId;
  }
  if (isNonEmptyString(leftName) && isNonEmptyString(rightName)) {
    return normalizeText(leftName) === normalizeText(rightName);
  }
  return true;
}

function summarize(rows: TransactionImportRowReport[]): TransactionImportReport['summary'] {
  return {
    total: rows.length,
    create: rows.filter((row) => row.status === 'create').length,
    duplicate: rows.filter((row) => row.status === 'duplicate').length,
    ambiguous: rows.filter((row) => row.status === 'ambiguous').length,
  };
}

function dateOnly(value?: string): string {
  return value?.slice(0, 10) ?? '';
}

function normalizeAmount(value?: string): string {
  if (!isNonEmptyString(value)) {
    return '';
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : value;
}

function normalizeText(value?: string): string {
  return value?.trim().toLowerCase() ?? '';
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const stringified = String(value).trim();
  return stringified === '' ? undefined : stringified;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function stripUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
