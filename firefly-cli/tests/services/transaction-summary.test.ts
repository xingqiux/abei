import { describe, expect, test, vi } from 'vitest';

import { FireflyHttpClient } from '../../src/core/http-client.js';
import {
  DEFAULT_EXCLUDE_CATEGORIES,
  extractSummaryTransactions,
  fetchTransactionsForSummary,
  summarizeTransactions,
  type SummaryTransactionRow,
} from '../../src/services/transaction-summary.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function row(overrides: Partial<SummaryTransactionRow> = {}): SummaryTransactionRow {
  return {
    type: 'withdrawal',
    date: '2026-06-01T00:00:00+08:00',
    amount: '10.00',
    ...overrides,
  };
}

describe('summarizeTransactions', () => {
  test('splits totals by type and computes daily consumption excluding default categories', () => {
    const rows: SummaryTransactionRow[] = [
      row({
        amount: '18.00',
        category_name: 'Food',
        destination_name: 'Coffee Shop',
        source_name: 'WeChat Wallet',
        date: '2026-06-01T09:00:00+08:00',
      }),
      row({
        amount: '45.50',
        category_name: 'Shopping',
        destination_name: 'Bookstore',
        source_name: 'WeChat Wallet',
        date: '2026-06-02T09:00:00+08:00',
      }),
      row({
        amount: '2000.00',
        category_name: '账户转账',
        destination_name: '招商银行',
        source_name: 'WeChat Wallet',
        date: '2026-06-02T09:00:00+08:00',
      }),
      row({ type: 'deposit', amount: '5000.00', date: '2026-06-03T09:00:00+08:00' }),
      row({ type: 'transfer', amount: '1000.00', date: '2026-06-03T09:00:00+08:00' }),
    ];

    const result = summarizeTransactions(rows, {}, { start: '2026-06-01', end: '2026-06-03' });

    expect(result.range).toEqual({ start: '2026-06-01', end: '2026-06-03' });
    expect(result.excludedCategories).toEqual(DEFAULT_EXCLUDE_CATEGORIES);
    expect(result.totals).toEqual({
      count: 5,
      byType: {
        withdrawal: { count: 3, total: '2063.50' },
        deposit: { count: 1, total: '5000.00' },
        transfer: { count: 1, total: '1000.00' },
      },
    });
    expect(result.dailyConsumption).toEqual({ count: 2, total: '63.50' });
    expect(result.topCategories).toEqual([
      { category: 'Shopping', count: 1, total: '45.50' },
      { category: 'Food', count: 1, total: '18.00' },
    ]);
    expect(result.topMerchants).toEqual([
      { merchant: 'Bookstore', count: 1, total: '45.50' },
      { merchant: 'Coffee Shop', count: 1, total: '18.00' },
    ]);
    expect(result.paymentAccounts).toEqual([
      { account: 'WeChat Wallet', count: 2, total: '63.50' },
    ]);
    expect(result.daily).toEqual([
      { date: '2026-06-01', count: 1, total: '18.00' },
      { date: '2026-06-02', count: 1, total: '45.50' },
    ]);
  });

  test('supports additional --exclude-category values on top of the defaults', () => {
    const rows: SummaryTransactionRow[] = [
      row({ amount: '100.00', category_name: 'Rent' }),
      row({ amount: '18.00', category_name: 'Food' }),
    ];

    const result = summarizeTransactions(rows, { excludeCategories: ['Rent'] });

    expect(result.excludedCategories).toEqual([...DEFAULT_EXCLUDE_CATEGORIES, 'Rent']);
    expect(result.dailyConsumption).toEqual({ count: 1, total: '18.00' });
  });

  test('does not add a duplicate when --exclude-category repeats a default (case/whitespace-insensitive)', () => {
    const result = summarizeTransactions([], { excludeCategories: [' 提现 ', 'Custom'] });
    expect(result.excludedCategories).toEqual([...DEFAULT_EXCLUDE_CATEGORIES, 'Custom']);
  });

  test('caps top categories and merchants at 10 but reports the full payment-account distribution', () => {
    const rows: SummaryTransactionRow[] = Array.from({ length: 12 }, (_, index) =>
      row({
        amount: `${index + 1}.00`,
        category_name: `Category ${index}`,
        destination_name: `Merchant ${index}`,
        source_name: `Account ${index}`,
      }),
    );

    const result = summarizeTransactions(rows);

    expect(result.topCategories).toHaveLength(10);
    expect(result.topMerchants).toHaveLength(10);
    expect(result.paymentAccounts).toHaveLength(12);
  });

  test('treats excluded category names case/whitespace-insensitively', () => {
    const rows: SummaryTransactionRow[] = [row({ amount: '9.99', category_name: '  账户转账  ' })];
    const result = summarizeTransactions(rows);
    expect(result.dailyConsumption).toEqual({ count: 0, total: '0.00' });
  });

  test('falls back to (uncategorized)/(unknown) labels when fields are missing', () => {
    const rows: SummaryTransactionRow[] = [row({ amount: '9.99' })];
    const result = summarizeTransactions(rows);
    expect(result.topCategories).toEqual([
      { category: '(uncategorized)', count: 1, total: '9.99' },
    ]);
    expect(result.topMerchants).toEqual([{ merchant: '(unknown)', count: 1, total: '9.99' }]);
    expect(result.paymentAccounts).toEqual([{ account: '(unknown)', count: 1, total: '9.99' }]);
  });

  test('returns zeroed-out results for an empty input', () => {
    const result = summarizeTransactions([]);
    expect(result.totals).toEqual({ count: 0, byType: {} });
    expect(result.dailyConsumption).toEqual({ count: 0, total: '0.00' });
    expect(result.topCategories).toEqual([]);
    expect(result.topMerchants).toEqual([]);
    expect(result.paymentAccounts).toEqual([]);
    expect(result.daily).toEqual([]);
  });
});

describe('extractSummaryTransactions', () => {
  test('flattens grouped transactions and skips invalid or incomplete entries', () => {
    const response = {
      data: [
        {
          id: '1',
          attributes: {
            transactions: [
              {
                type: 'Withdrawal',
                date: '2026-06-01T00:00:00+08:00',
                amount: '18.00',
                category_name: 'Food',
                destination_name: 'Coffee Shop',
                source_name: 'WeChat',
              },
              { type: 'withdrawal' },
            ],
          },
        },
        'not-a-record',
        {
          id: '2',
          attributes: { type: 'deposit', date: '2026-06-02T00:00:00+08:00', amount: '5.00' },
        },
      ],
    };

    const rows = extractSummaryTransactions(response);
    expect(rows).toEqual([
      {
        type: 'withdrawal',
        date: '2026-06-01T00:00:00+08:00',
        amount: '18.00',
        category_name: 'Food',
        destination_name: 'Coffee Shop',
        source_name: 'WeChat',
      },
      {
        type: 'deposit',
        date: '2026-06-02T00:00:00+08:00',
        amount: '5.00',
      },
    ]);
  });

  test('returns an empty array for non-JSON:API-shaped responses', () => {
    expect(extractSummaryTransactions(undefined)).toEqual([]);
    expect(extractSummaryTransactions({ data: 'nope' })).toEqual([]);
  });
});

describe('fetchTransactionsForSummary', () => {
  test('pages through /api/v1/transactions until Firefly reports no more pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: '1',
              attributes: { type: 'withdrawal', date: '2026-06-01T00:00:00+08:00', amount: '1.00' },
            },
          ],
          meta: { pagination: { total_pages: 2, current_page: 1 } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: '2',
              attributes: { type: 'withdrawal', date: '2026-06-02T00:00:00+08:00', amount: '2.00' },
            },
          ],
          meta: { pagination: { total_pages: 2, current_page: 2 } },
        }),
      );

    const client = new FireflyHttpClient({
      baseUrl: 'http://127.0.0.1:8000',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const rows = await fetchTransactionsForSummary(client, {
      start: '2026-06-01',
      end: '2026-06-02',
    });

    expect(rows).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8000/api/v1/transactions?start=2026-06-01&end=2026-06-02&limit=500&page=1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8000/api/v1/transactions?start=2026-06-01&end=2026-06-02&limit=500&page=2',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('stops as soon as a page comes back empty', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: [] }));
    const client = new FireflyHttpClient({
      baseUrl: 'http://127.0.0.1:8000',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const rows = await fetchTransactionsForSummary(client, {});
    expect(rows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('stops after a single page when meta.pagination is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: '1',
            attributes: { type: 'withdrawal', date: '2026-06-01T00:00:00+08:00', amount: '1.00' },
          },
        ],
      }),
    );
    const client = new FireflyHttpClient({
      baseUrl: 'http://127.0.0.1:8000',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const rows = await fetchTransactionsForSummary(client, {});
    expect(rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
