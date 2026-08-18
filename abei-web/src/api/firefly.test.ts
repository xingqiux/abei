import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransactionSplits, getBillRows, getBudgetLimits, getCategories, getCurrencies, undoBillImport, updateTransactionSplits } from './firefly'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: mocks.apiPut,
}))

beforeEach(() => {
  sessionStorage.clear()
  mocks.apiGet.mockReset()
  mocks.apiPost.mockReset()
  mocks.apiPut.mockReset()
})

describe('transaction writes', () => {
  it('posts splits to Firefly with JSON:API-compatible write payload', async () => {
    mocks.apiPost.mockResolvedValueOnce({
      data: {
        id: '42',
        attributes: {
          group_title: 'Team lunch',
          transactions: [
            {
              transaction_journal_id: '101', description: 'Lunch', amount: '10.25', type: 'withdrawal',
              date: '2026-07-20', currency_symbol: '¥', source_name: 'Checking', destination_name: 'Cafe', category_name: null,
            },
            {
              transaction_journal_id: '102', description: 'Dessert', amount: '3.50', type: 'withdrawal',
              date: '2026-07-20', currency_symbol: '¥', source_name: 'Checking', destination_name: 'Cafe', category_name: null,
            },
          ],
        },
      },
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

    expect(mocks.apiPost).toHaveBeenCalledWith('/v1/firefly/api/v1/transactions', {
      error_if_duplicate_hash: false,
      group_title: 'Team lunch',
      transactions: [
        expect.objectContaining({ type: 'withdrawal', amount: '10.25', source_id: '1', destination_name: 'Cafe', category_id: '7', tags: ['work'] }),
        expect.objectContaining({ type: 'withdrawal', amount: '3.50', source_id: '1', destination_name: 'Cafe', category_id: '8', tags: ['work'] }),
      ],
    })
    expect(result.data.id).toBe('42')
  })

  it('keeps an optional category on a transfer without turning it into income or expense', async () => {
    mocks.apiPost.mockResolvedValueOnce({
      data: {
        id: '43',
        attributes: {
          transactions: [
            {
              transaction_journal_id: '201', description: '提现', amount: '20.00', type: 'transfer',
              date: '2026-07-20', currency_symbol: '¥', source_name: 'A', destination_name: 'B',
              category_name: '资金调拨',
            },
          ],
        },
      },
    })

    const result = await createTransactionSplits([{
      type: 'transfer',
      date: '2026-07-20',
      amount: '20.00',
      description: '提现',
      source_id: '1',
      destination_id: '2',
      category_id: '7',
    }])

    expect(mocks.apiPost).toHaveBeenCalledWith('/v1/firefly/api/v1/transactions', {
      error_if_duplicate_hash: false,
      group_title: undefined,
      transactions: [
        expect.objectContaining({ type: 'transfer', source_id: '1', destination_id: '2', category_id: '7' }),
      ],
    })
    expect(result.data.attributes.transactions[0]?.category_name).toBe('资金调拨')
  })

  it('keeps the required group title when updating a multi-split transaction', async () => {
    mocks.apiPut.mockResolvedValueOnce({ data: { id: '42', attributes: { transactions: [] } } })

    await updateTransactionSplits('42', [
      { transaction_journal_id: '101', order: 0, description: 'Updated lunch', amount: '11.25' },
      { transaction_journal_id: '102', order: 1, description: 'Updated dessert', amount: '4.50' },
    ], 'Original team lunch')

    expect(mocks.apiPut).toHaveBeenCalledWith('/v1/firefly/api/v1/transactions/42', {
      group_title: 'Original team lunch',
      transactions: [
        { transaction_journal_id: '101', order: 0, description: 'Updated lunch', amount: '11.25' },
        { transaction_journal_id: '102', order: 1, description: 'Updated dessert', amount: '4.50' },
      ],
    })
  })
})

describe('getBillRows', () => {
  it('把「只看某封邮件」当成 document_id 交给服务端过滤', async () => {
    mocks.apiGet.mockResolvedValueOnce({ data: [], meta: { pagination: { total: 0, total_pages: 1 } } })
    await getBillRows({ group: 'attention', source: 'cmb', documentId: '42', page: 2, limit: 50 })
    expect(mocks.apiGet).toHaveBeenCalledWith('/v1/bill-rows', {
      group: 'attention',
      source: 'cmb',
      document_id: '42',
      page: 2,
      limit: 50,
    })
  })

  it('没选邮件时不带 document_id（undefined 参数会被丢掉）', async () => {
    mocks.apiGet.mockResolvedValueOnce({ data: [], meta: { pagination: { total: 0, total_pages: 1 } } })
    await getBillRows({ group: 'importable' })
    expect(mocks.apiGet).toHaveBeenCalledWith('/v1/bill-rows', {
      group: 'importable',
      source: undefined,
      document_id: undefined,
      page: 1,
      limit: 200,
    })
  })
})

describe('paginated collection APIs', () => {
  it('loads categories from Firefly', async () => {
    mocks.apiGet.mockResolvedValueOnce({
      data: [
        { id: '1', attributes: { name: 'Food' } },
        { id: '2', attributes: { name: 'Travel' } },
      ],
      meta: { pagination: { total: 2, count: 2, per_page: 100, current_page: 1, total_pages: 1 } },
    })

    const result = await getCategories()

    expect(mocks.apiGet).toHaveBeenCalledWith('/v1/firefly/api/v1/categories', { limit: 100, page: 1 })
    expect(result.data.map(({ id }) => id)).toEqual(['1', '2'])
    expect(result.meta?.pagination?.total).toBe(2)
  })

  it('loads currencies from Firefly', async () => {
    mocks.apiGet.mockResolvedValueOnce({
      data: [
        { id: 'CNY', attributes: { name: 'Chinese Yuan', code: 'CNY', symbol: 'CN¥', default: true, enabled: true } },
        { id: 'USD', attributes: { name: 'US Dollar', code: 'USD', symbol: '$', default: false, enabled: true } },
      ],
      meta: { pagination: { total: 2, count: 2, per_page: 100, current_page: 1, total_pages: 1 } },
    })

    const result = await getCurrencies()

    expect(mocks.apiGet).toHaveBeenCalledWith('/v1/firefly/api/v1/currencies', { limit: 100, page: 1 })
    expect(result.data.map(({ id }) => id)).toEqual(['CNY', 'USD'])
    expect(result.data.find(({ id }) => id === 'CNY')?.attributes.default).toBe(true)
  })

  it('collects every matching budget limit without dropping the date range', async () => {
    mocks.apiGet
      .mockResolvedValueOnce({
        data: [{ id: '10', attributes: { budget_id: '7', start: '2026-01-01', end: '2026-06-30', amount: '100', spent: [] } }],
        meta: { pagination: { total_pages: 2 } },
      })
      .mockResolvedValueOnce({
        data: [{ id: '11', attributes: { budget_id: '7', start: '2026-07-01', end: '2026-12-31', amount: '200', spent: [] } }],
        meta: { pagination: { total_pages: 2 } },
      })

    const result = await getBudgetLimits('7', { start: '2026-01-01', end: '2026-12-31' })

    expect(mocks.apiGet).toHaveBeenNthCalledWith(1, '/v1/firefly/api/v1/budgets/7/limits', {
      start: '2026-01-01',
      end: '2026-12-31',
      limit: 100,
      page: 1,
    })
    expect(mocks.apiGet).toHaveBeenNthCalledWith(2, '/v1/firefly/api/v1/budgets/7/limits', {
      start: '2026-01-01',
      end: '2026-12-31',
      limit: 100,
      page: 2,
    })
    expect(result.data.map(({ id }) => id)).toEqual(['10', '11'])
  })
})

describe('undoBillImport', () => {
  it('把行号发给服务端撤销通道，并带上确认闸', async () => {
    mocks.apiPost.mockResolvedValueOnce({
      data: {
        rows: [
          { row_id: '11', outcome: 'undone', transaction_group_id: '900' },
          { row_id: '12', outcome: 'failed', error: 'Firefly 不让删' },
        ],
        summary: { total: 2, undone: 1, not_imported: 0, not_found: 0, failed: 1 },
      },
    })

    const result = await undoBillImport(['11', '12'])

    // 撤销的对象是行不是交易组：交易删完还要把行放回队列，只有服务端做得到。
    const [path, body, params] = mocks.apiPost.mock.calls[0] as [string, unknown, Record<string, unknown>]
    expect(path).toBe('/v1/bill-rows/undo-import')
    expect(body).toEqual({ row_ids: [11, 12] })
    expect(params).toMatchObject({ confirm: true })
    // 一批里每行下场可能不同，逐行结局得原样透给界面。
    expect(result.data.summary.undone).toBe(1)
    expect(result.data.rows[1].outcome).toBe('failed')
  })
})
