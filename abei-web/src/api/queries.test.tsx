import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useCreateAccount,
  useCreateTransaction,
  useDeleteTransaction,
  useIgnoreBillTask,
  useImportBillTaskRows,
  useSubmitBillTaskSecret,
  useSyncBillInbox,
  useTriggerRecurrence,
  useUpdateBillStatementRow,
} from './queries'

const mocks = vi.hoisted(() => ({
  createAccount: vi.fn(),
  createTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
  ignoreBillTask: vi.fn(),
  importBillTaskRows: vi.fn(),
  submitBillTaskSecret: vi.fn(),
  syncBillInbox: vi.fn(),
  triggerRecurrence: vi.fn(),
  updateBillStatementRow: vi.fn(),
}))

vi.mock('./firefly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./firefly')>()),
  createAccount: mocks.createAccount,
  createTransaction: mocks.createTransaction,
  deleteTransaction: mocks.deleteTransaction,
  ignoreBillTask: mocks.ignoreBillTask,
  importBillTaskRows: mocks.importBillTaskRows,
  submitBillTaskSecret: mocks.submitBillTaskSecret,
  syncBillInbox: mocks.syncBillInbox,
  triggerRecurrence: mocks.triggerRecurrence,
  updateBillStatementRow: mocks.updateBillStatementRow,
}))

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

function invalidatedRoots(calls: unknown[][]): string[] {
  return calls.flatMap(([filters]) => {
    const key = (filters as { queryKey?: unknown[] } | undefined)?.queryKey
    return typeof key?.[0] === 'string' ? [key[0]] : []
  })
}

describe('financial mutation cache invalidation', () => {
  beforeEach(() => {
    mocks.createAccount.mockReset().mockResolvedValue({})
    mocks.createTransaction.mockReset().mockResolvedValue({})
    mocks.deleteTransaction.mockReset().mockResolvedValue(undefined)
    mocks.ignoreBillTask.mockReset().mockResolvedValue({})
    mocks.importBillTaskRows.mockReset().mockResolvedValue({})
    mocks.submitBillTaskSecret.mockReset().mockResolvedValue({})
    mocks.syncBillInbox.mockReset().mockResolvedValue({})
    mocks.triggerRecurrence.mockReset().mockResolvedValue({ data: [] })
    mocks.updateBillStatementRow.mockReset().mockResolvedValue({
      data: { attributes: { bill_task_id: '7' } },
    })
  })

  it('invalidates every transaction-derived report and search result', async () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useCreateTransaction(), { wrapper: wrapper(queryClient) })

    await act(() => result.current.mutateAsync({
      type: 'withdrawal',
      date: '2026-07-20',
      amount: '1',
      description: 'cache check',
      source_id: '1',
    }))

    expect(invalidatedRoots(invalidate.mock.calls as unknown[][])).toEqual(expect.arrayContaining([
      'transactions',
      'transaction',
      'summary-basic',
      'income-by-revenue',
      'expense-by-asset',
      'expense-by-tag',
      'expense-by-budget',
      'expense-without-category',
      'expense-without-budget',
      'financial-report',
      'search-transactions',
      'search-transaction-count',
      'search-accounts',
      'autocomplete-transactions',
      'autocomplete-accounts',
      'autocomplete-categories',
      'autocomplete-tags',
      'categories',
      'tags',
      'account-transactions',
    ]))
  })

  it('invalidates a cached transaction detail after deletion', async () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useDeleteTransaction(), { wrapper: wrapper(queryClient) })

    await act(() => result.current.mutateAsync('42'))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['transaction'] })
  })

  it('also invalidates account search and transaction-derived data after account writes', async () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useCreateAccount(), { wrapper: wrapper(queryClient) })

    await act(() => result.current.mutateAsync({ name: 'Cash', type: 'cash', currency_code: 'CNY' }))

    expect(invalidatedRoots(invalidate.mock.calls as unknown[][])).toEqual(expect.arrayContaining([
      'accounts',
      'account',
      'transactions',
      'financial-report',
      'search-accounts',
      'autocomplete-accounts',
    ]))
  })

  it('refreshes recurrence details and financial data after a manual trigger', async () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useTriggerRecurrence(), { wrapper: wrapper(queryClient) })

    await act(() => result.current.mutateAsync({ id: '9', date: '2026-07-20' }))

    expect(invalidatedRoots(invalidate.mock.calls as unknown[][])).toEqual(expect.arrayContaining([
      'recurrences',
      'transactions',
      'accounts',
      'budgets',
      'financial-report',
    ]))
  })

  it('refreshes the derived review after a bill row edit', async () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useUpdateBillStatementRow(), { wrapper: wrapper(queryClient) })

    await act(() => result.current.mutateAsync({ rowId: '3', input: { notes: 'checked' } }))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bill-task-review', '7'] })
  })

  it('refreshes a task event after a confirmed bill import', async () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useImportBillTaskRows(), { wrapper: wrapper(queryClient) })

    await act(() => result.current.mutateAsync({ taskId: '7', all: true, confirm: true }))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bill-task-events', '7'] })
  })

  it('refreshes all task evidence after submitting a bill secret', async () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useSubmitBillTaskSecret(), { wrapper: wrapper(queryClient) })

    await act(() => result.current.mutateAsync({ taskId: '7', value: 'secret', confirm: true }))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bill-task-review', '7'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bill-task-events', '7'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bill-task-artifacts', '7'] })
  })

  /** 干跑什么都没改，刷缓存等于骗人：界面会闪一下像是发生了什么。 */
  it('does not refresh anything when a bill secret is only previewed', async () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useSubmitBillTaskSecret(), { wrapper: wrapper(queryClient) })

    await act(() => result.current.mutateAsync({ taskId: '7', value: 'secret', confirm: false }))

    expect(mocks.submitBillTaskSecret).toHaveBeenCalledWith('7', 'secret', { dryRun: true })
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('refreshes all task evidence after mailbox sync processes tasks', async () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useSyncBillInbox(), { wrapper: wrapper(queryClient) })

    await act(() => result.current.mutateAsync({ limit: 25 }))

    expect(invalidatedRoots(invalidate.mock.calls as unknown[][])).toEqual(expect.arrayContaining([
      'bill-inbox-summary',
      'bill-tasks',
      'bill-task-rows',
      'bill-task-review',
      'bill-task-events',
      'bill-task-artifacts',
    ]))
  })

  it('refreshes task evidence after ignoring a task', async () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useIgnoreBillTask(), { wrapper: wrapper(queryClient) })

    await act(() => result.current.mutateAsync({ taskId: '7', confirm: true }))

    expect(mocks.ignoreBillTask).toHaveBeenCalledWith('7', { confirm: true })
    expect(invalidatedRoots(invalidate.mock.calls as unknown[][])).toEqual(expect.arrayContaining([
      'bill-inbox-summary',
      'bill-tasks',
      'bill-task-rows',
      'bill-task-review',
      'bill-task-events',
      'bill-task-artifacts',
    ]))
  })

  it('only previews when a task ignore is not confirmed', async () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useIgnoreBillTask(), { wrapper: wrapper(queryClient) })

    await act(() => result.current.mutateAsync({ taskId: '7', confirm: false }))

    expect(mocks.ignoreBillTask).toHaveBeenCalledWith('7', { dryRun: true })
    expect(invalidate).not.toHaveBeenCalled()
  })
})
