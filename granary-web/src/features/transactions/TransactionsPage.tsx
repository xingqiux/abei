import { useMemo, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { useDeleteTransaction, useInfiniteTransactions } from '../../api/queries'
import type { TransactionTypeFilter } from '../../api/firefly'
import { TransactionRow } from '../../components/granary/TransactionRow'
import { DeleteTransactionDialog } from '../../components/granary/DeleteTransactionDialog'
import { Skeleton } from '../../components/granary/Skeleton'
import { EmptyState } from '../../components/granary/EmptyState'
import { BanknotesIcon } from '@heroicons/react/24/outline'
import { formatAmount, formatDayGroupLabel } from '../../lib/format'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { isEditableTransactionType } from '../record-transaction/editPayload'
import { flattenTransactionGroups, signedSplitAmount, type TransactionSplitRow } from '../../lib/transactionGroup'
import { absoluteDecimalString, compareDecimalStrings, sumDecimalStrings } from '../../lib/decimal'
import { TransactionDetailModal } from './TransactionDetailModal'

const TABS: { label: string; value: TransactionTypeFilter }[] = [
  { label: '全部', value: 'all' },
  { label: '支出', value: 'withdrawal' },
  { label: '收入', value: 'deposit' },
  { label: '转账', value: 'transfer' },
]

const PAGE_SIZE = 80

type LoadedRow = TransactionSplitRow

export function TransactionsPage() {
  const search = useSearch({ from: '/transactions' })
  const navigate = useNavigate({ from: '/transactions' })
  const range = useDateRangeStore()
  const [type, setType] = useState<TransactionTypeFilter>('all')
  const [pendingDelete, setPendingDelete] = useState<LoadedRow | null>(null)
  const detailGroupId = search.transaction == null ? null : String(search.transaction)

  const deleteMutation = useDeleteTransaction()
  const query = useInfiniteTransactions(range, { limit: PAGE_SIZE, type })
  const loaded = useMemo(
    () => flattenTransactionGroups(query.data?.pages.flatMap((page) => page.data) ?? []),
    [query.data],
  )
  const canLoadMore = !!query.hasNextPage
  const pendingDeleteSplits = pendingDelete
    ? loaded.filter((row) => row.groupId === pendingDelete.groupId).map((row) => row.tx)
    : []

  const groups = useMemo(() => {
    const map = new Map<string, LoadedRow[]>()
    for (const row of loaded) {
      const day = row.tx.date.slice(0, 10)
      const arr = map.get(day)
      if (arr) arr.push(row)
      else map.set(day, [row])
    }
    return Array.from(map.entries())
  }, [loaded])

  const listRef = useStaggerIn<HTMLDivElement>([
    query.isSuccess && (query.data?.pages.length ?? 0) === 1,
  ])

  async function confirmDelete() {
    if (!pendingDelete) return
    try {
      await deleteMutation.mutateAsync(pendingDelete.groupId)
      showToast({ kind: 'success', message: '交易已移入回收站' })
      setPendingDelete(null)
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '移入回收站失败，请重试'
      showToast({ kind: 'error', message, duration: 6000 })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {TABS.map((tab) => {
          const active = tab.value === type
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => setType(tab.value)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${
                active
                  ? 'border-indigo-600 font-semibold text-gray-900 dark:border-indigo-400 dark:text-gray-100'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:hover:border-gray-600 dark:hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      <div className="rounded-xl bg-white p-2 shadow-sm ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-gray-700">
        {query.isLoading ? (
          <div className="flex flex-col gap-1 p-2">
            {Array.from({ length: 14 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : query.isError ? (
          <div className="flex flex-col items-center gap-2 py-8 text-[13px] text-red-600 dark:text-red-400">
            <span>交易加载失败</span>
            <button type="button" onClick={() => void query.refetch()} className="text-indigo-600 dark:text-indigo-400">
              重试
            </button>
          </div>
        ) : loaded.length === 0 ? (
          query.isFetching ? (
            <EmptyState lottie="loading" message="加载中…" />
          ) : (
            <EmptyState icon={<BanknotesIcon className="size-9 text-gray-400" />} message="所选范围内暂无交易" />
          )
        ) : (
          <div ref={listRef} className="flex flex-col">
            {groups.map(([day, rows]) => {
              const subtotalGroups = new Map<string, { symbol: string; values: string[] }>()
              for (const row of rows) {
                const code = String((row.tx as typeof row.tx & { currency_code?: string }).currency_code ?? '')
                const key = code || row.tx.currency_symbol
                const current = subtotalGroups.get(key)
                if (current) current.values.push(signedSplitAmount(row.tx))
                else subtotalGroups.set(key, { symbol: row.tx.currency_symbol, values: [signedSplitAmount(row.tx)] })
              }
              const subtotals = Array.from(subtotalGroups.values(), ({ symbol, values }) => ({
                symbol,
                amount: sumDecimalStrings(values),
              }))
              return (
                <div key={day}>
                  <div
                    className="flex h-7 items-center justify-between rounded-md bg-gray-50 px-2 text-[11.5px] text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                  >
                    <span>{formatDayGroupLabel(day)}</span>
                    <span className="font-num flex gap-2">
                      {subtotals.map((subtotal) => {
                        const comparison = compareDecimalStrings(subtotal.amount, '0')
                        return (
                          <span
                            key={`${subtotal.symbol}-${subtotal.amount}`}
                            style={{
                              color:
                                comparison < 0
                                  ? 'rgb(220 38 38 / 1)'
                                  : comparison > 0
                                    ? 'rgb(5 150 105 / 1)'
                                    : 'rgb(107 114 128 / 1)',
                            }}
                          >
                            {comparison > 0 ? '+' : comparison < 0 ? '-' : ''}
                            {subtotal.symbol}{formatAmount(absoluteDecimalString(subtotal.amount))}
                          </span>
                        )
                      })}
                    </span>
                  </div>
                  {rows.map((row) => {
                    // Opening balance / Reconciliation 等不可行操作（避免误改初始余额）
                    const deletable = row.splitIndex === 0 && row.splitCount > 0 && isEditableTransactionType(row.tx.type)
                    return (
                      <TransactionRow
                        key={`${row.groupId}-${row.tx.transaction_journal_id ?? row.splitIndex}`}
                        tx={row.tx}
                        ids={{ groupId: row.groupId, journalId: String(row.tx.transaction_journal_id ?? row.groupId) }}
                        onDelete={deletable ? () => setPendingDelete(row) : undefined}
                      />
                    )
                  })}
                </div>
              )
            })}
          </div>
        )}

        {canLoadMore && (
          <div className="flex justify-center p-3">
            <button
              type="button"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              className="rounded-md bg-gray-100 px-3 py-1.5 text-[13px] text-gray-900 hover:bg-gray-200 disabled:opacity-60 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              {query.isFetchingNextPage ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}
      </div>

      <DeleteTransactionDialog
        open={!!pendingDelete}
        splits={pendingDeleteSplits}
        pending={deleteMutation.isPending}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
      <TransactionDetailModal
        groupId={detailGroupId}
        onClose={() => void navigate({ search: { transaction: undefined }, replace: true })}
      />
    </div>
  )
}
