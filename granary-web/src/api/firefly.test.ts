import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransactionSplits, getBudgetLimits, getCategories, getCurrencies, updateTransactionSplits } from './firefly'

const mocks = vi.hoisted(() => ({ fireflyFetch: vi.fn(), fireflyPost: vi.fn(), fireflyPut: vi.fn() }))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  fireflyFetch: mocks.fireflyFetch,
  fireflyPost: mocks.fireflyPost,
  fireflyPut: mocks.fireflyPut,
}))

beforeEach(() => {
  mocks.fireflyFetch.mockReset()
  mocks.fireflyPost.mockReset()
  mocks.fireflyPut.mockReset()
})

describe('transaction writes', () => {
  it('creates every split in one transaction group without dropping split metadata', async () => {
    mocks.fireflyPost.mockResolvedValueOnce({ data: { id: '42', attributes: { transactions: [] } } })

    await createTransactionSplits([
      {
        type: 'withdrawal',
        order: 0,
        date: '2026-07-20',
        amount: '10.25',
        description: 'Lunch',
        source_id: '1',
        destination_name: 'Cafe',
        category_id: '7',
        budget_id: '4',
        tags: ['work'],
      },
      {
        type: 'withdrawal',
        order: 1,
        date: '2026-07-20',
        amount: '3.50',
        description: 'Dessert',
        source_id: '1',
        destination_name: 'Bakery',
        foreign_currency_id: '2',
        foreign_amount: '0.49',
      },
    ], 'Team lunch')

    expect(mocks.fireflyPost).toHaveBeenCalledWith('/api/v1/transactions', {
      error_if_duplicate_hash: false,
      group_title: 'Team lunch',
      transactions: [
        expect.objectContaining({ order: 0, amount: '10.25', category_id: '7', budget_id: '4', tags: ['work'] }),
        expect.objectContaining({ order: 1, amount: '3.50', foreign_currency_id: '2', foreign_amount: '0.49' }),
      ],
    })
  })

  it('keeps the required group title when updating a multi-split transaction', async () => {
    mocks.fireflyPut.mockResolvedValueOnce({ data: { id: '42', attributes: { transactions: [] } } })

    await updateTransactionSplits('42', [
      { transaction_journal_id: '101', order: 0, description: 'Updated lunch', amount: '11.25' },
      { transaction_journal_id: '102', order: 1, description: 'Updated dessert', amount: '4.50' },
    ], 'Original team lunch')

    expect(mocks.fireflyPut).toHaveBeenCalledWith('/api/v1/transactions/42', {
      group_title: 'Original team lunch',
      transactions: [
        { transaction_journal_id: '101', order: 0, description: 'Updated lunch', amount: '11.25' },
        { transaction_journal_id: '102', order: 1, description: 'Updated dessert', amount: '4.50' },
      ],
    })
  })
})

describe('paginated collection APIs', () => {
  it('requests every page, merges data, and preserves the first response metadata', async () => {
    mocks.fireflyFetch
      .mockResolvedValueOnce({
        data: [{ id: '1', attributes: { name: 'Food' } }],
        meta: {
          pagination: { total: 2, count: 1, per_page: 1, current_page: 1, total_pages: 2 },
          source: 'first-page',
        },
        links: { self: 'page-one' },
      })
      .mockResolvedValueOnce({
        data: [{ id: '2', attributes: { name: 'Travel' } }],
        meta: {
          pagination: { total: 2, count: 1, per_page: 1, current_page: 2, total_pages: 2 },
        },
      })

    const result = await getCategories()

    expect(mocks.fireflyFetch).toHaveBeenNthCalledWith(1, '/api/v1/categories', { limit: 100, page: 1 })
    expect(mocks.fireflyFetch).toHaveBeenNthCalledWith(2, '/api/v1/categories', { limit: 100, page: 2 })
    expect(result.data.map(({ id }) => id)).toEqual(['1', '2'])
    expect(result.meta).toMatchObject({
      pagination: { current_page: 1, total_pages: 2 },
      source: 'first-page',
    })
    expect(result.links).toEqual({ self: 'page-one' })
  })

  it('derives the page count from total and per_page when total_pages is absent', async () => {
    mocks.fireflyFetch
      .mockResolvedValueOnce({
        data: [
          { id: '1', attributes: { name: 'Yuan', code: 'CNY', symbol: '¥' } },
          { id: '2', attributes: { name: 'Dollar', code: 'USD', symbol: '$' } },
        ],
        meta: { pagination: { total: 3, per_page: 2, current_page: 1 } },
      })
      .mockResolvedValueOnce({
        data: [{ id: '3', attributes: { name: 'Euro', code: 'EUR', symbol: 'EUR' } }],
        meta: { pagination: { total: 3, per_page: 2, current_page: 2 } },
      })

    const result = await getCurrencies()

    expect(mocks.fireflyFetch).toHaveBeenCalledTimes(2)
    expect(mocks.fireflyFetch).toHaveBeenLastCalledWith('/api/v1/currencies', { limit: 100, page: 2 })
    expect(result.data.map(({ id }) => id)).toEqual(['1', '2', '3'])
  })

  it('collects every matching budget limit without dropping the date range', async () => {
    mocks.fireflyFetch
      .mockResolvedValueOnce({
        data: [{ id: '10', attributes: { budget_id: '7', start: '2026-01-01', end: '2026-06-30', amount: '100', spent: [] } }],
        meta: { pagination: { total_pages: 2 } },
      })
      .mockResolvedValueOnce({
        data: [{ id: '11', attributes: { budget_id: '7', start: '2026-07-01', end: '2026-12-31', amount: '200', spent: [] } }],
        meta: { pagination: { total_pages: 2 } },
      })

    const result = await getBudgetLimits('7', { start: '2026-01-01', end: '2026-12-31' })

    expect(mocks.fireflyFetch).toHaveBeenNthCalledWith(1, '/api/v1/budgets/7/limits', {
      start: '2026-01-01',
      end: '2026-12-31',
      limit: 100,
      page: 1,
    })
    expect(mocks.fireflyFetch).toHaveBeenNthCalledWith(2, '/api/v1/budgets/7/limits', {
      start: '2026-01-01',
      end: '2026-12-31',
      limit: 100,
      page: 2,
    })
    expect(result.data.map(({ id }) => id)).toEqual(['10', '11'])
  })

  it('returns the first response when the API provides no usable pagination metadata', async () => {
    mocks.fireflyFetch.mockResolvedValueOnce({
      data: [{ id: '1', attributes: { name: 'Yuan', code: 'CNY', symbol: '¥' } }],
    })

    const result = await getCurrencies()

    expect(mocks.fireflyFetch).toHaveBeenCalledTimes(1)
    expect(result.data).toHaveLength(1)
  })
})
