import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransactionSplits, getBudgetLimits, getCategories, getCurrencies, updateTransactionSplits } from './firefly'
import { setActiveBookId } from './granary'

const mocks = vi.hoisted(() => ({
  fireflyFetch: vi.fn(),
  fireflyPost: vi.fn(),
  fireflyPut: vi.fn(),
  granaryGet: vi.fn(),
  granaryPost: vi.fn(),
}))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  fireflyFetch: mocks.fireflyFetch,
  fireflyPost: mocks.fireflyPost,
  fireflyPut: mocks.fireflyPut,
}))
vi.mock('./granary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./granary')>()),
  granaryGet: mocks.granaryGet,
  granaryPost: mocks.granaryPost,
}))

beforeEach(() => {
  sessionStorage.clear()
  setActiveBookId(7)
  mocks.fireflyFetch.mockReset()
  mocks.fireflyPost.mockReset()
  mocks.fireflyPut.mockReset()
  mocks.granaryGet.mockReset()
  mocks.granaryPost.mockReset()
})

describe('transaction writes', () => {
  it('maps split transactions to the selected Granary book', async () => {
    mocks.granaryGet
      .mockResolvedValueOnce([
        { id: 7, name: '餐饮', kind: 'expense', parent_id: null, version: 1, archived_at: null },
        { id: 8, name: '甜点', kind: 'expense', parent_id: null, version: 1, archived_at: null },
      ])
      .mockResolvedValueOnce([{ id: 3, name: 'work', color: null, version: 1, archived_at: null }])
      .mockResolvedValueOnce([{ id: 9, name: 'Cafe', kind: 'merchant', review_status: 'confirmed', notes: null, version: 1, archived_at: null }])
      .mockResolvedValueOnce([{ id: 1, name: 'Checking', class: 'asset', role: 'bank', currency_code: 'CNY', balance: '100.00', version: 1, archived_at: null }])
      .mockResolvedValueOnce([{ id: 7, base_currency_code: 'CNY' }])
    mocks.granaryPost.mockResolvedValueOnce({
      id: 42,
      status: 'posted',
      transaction_type: 'withdrawal',
      occurred_at: '2026-07-20T12:00:00Z',
      description: 'Team lunch',
      counterparty_id: 9,
      counterparty_name: 'Cafe',
      version: 1,
      postings: [
        { id: 1, account_id: 1, account_name: 'Checking', account_class: 'asset', currency_code: 'CNY', category_id: null, category_name: null, budget_id: null, budget_name: null, amount: '-13.75', book_amount: '-13.75', memo: null, cleared_at: null },
        { id: 2, account_id: 70, account_name: '餐饮', account_class: 'expense', currency_code: 'CNY', category_id: 7, category_name: '餐饮', budget_id: null, budget_name: null, amount: '10.25', book_amount: '10.25', memo: null, cleared_at: null },
        { id: 3, account_id: 80, account_name: '甜点', account_class: 'expense', currency_code: 'CNY', category_id: 8, category_name: '甜点', budget_id: null, budget_name: null, amount: '3.50', book_amount: '3.50', memo: null, cleared_at: null },
      ],
      tags: [{ id: 3, name: 'work', archived: false }],
    })

    const result = await createTransactionSplits([
      {
        type: 'withdrawal',
        order: 0,
        date: '2026-07-20',
        amount: '10.25',
        description: 'Lunch',
        source_id: '1',
        destination_name: 'Cafe',
        category_id: '7',
        tags: ['work'],
      },
      {
        type: 'withdrawal',
        order: 1,
        date: '2026-07-20',
        amount: '3.50',
        description: 'Dessert',
        source_id: '1',
        destination_name: 'Cafe',
        category_id: '8',
        tags: ['work'],
      },
    ], 'Team lunch')

    expect(mocks.granaryPost).toHaveBeenCalledWith('/api/v1/books/7/transactions', expect.objectContaining({
      type: 'withdrawal',
      description: 'Team lunch',
      counterparty_id: 9,
      account_id: 1,
      amount: '13.75',
      book_amount: '13.75',
      tag_ids: [3],
      splits: [
        expect.objectContaining({ category_id: 7, amount: '10.25', book_amount: '10.25' }),
        expect.objectContaining({ category_id: 8, amount: '3.50', book_amount: '3.50' }),
      ],
    }))
    expect(result.data.id).toBe('42')
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
  it('loads categories from the selected Granary book', async () => {
    mocks.granaryGet.mockResolvedValueOnce([
      { id: 1, name: 'Food', kind: 'expense', parent_id: null, version: 1, archived_at: null },
      { id: 2, name: 'Travel', kind: 'expense', parent_id: null, version: 1, archived_at: null },
    ])

    const result = await getCategories()

    expect(mocks.granaryGet).toHaveBeenCalledWith('/api/v1/books/7/categories')
    expect(result.data.map(({ id }) => id)).toEqual(['1', '2'])
    expect(result.meta?.pagination?.total).toBe(2)
  })

  it('marks the current book base currency as default', async () => {
    mocks.granaryGet
      .mockResolvedValueOnce([
        { code: 'CNY', name: 'Chinese Yuan', symbol: 'CN¥', minor_units: 2, enabled_by_default: true },
        { code: 'USD', name: 'US Dollar', symbol: '$', minor_units: 2, enabled_by_default: true },
      ])
      .mockResolvedValueOnce([{ id: 7, base_currency_code: 'CNY' }])

    const result = await getCurrencies()

    expect(mocks.granaryGet).toHaveBeenNthCalledWith(1, '/api/v1/currencies')
    expect(mocks.granaryGet).toHaveBeenNthCalledWith(2, '/api/v1/books')
    expect(result.data.map(({ id }) => id)).toEqual(['CNY', 'USD'])
    expect(result.data.find(({ id }) => id === 'CNY')?.attributes.default).toBe(true)
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

})
