import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { useDeleteTransaction, useInfiniteTransactions, useTransaction } from '../../api/queries'
import type { TransactionTypeFilter } from '../../api/firefly'
import { TransactionRow } from '../../components/granary/TransactionRow'
import { DeleteTransactionDialog } from '../../components/granary/DeleteTransactionDialog'
import { Skeleton } from '../../components/granary/Skeleton'
import { EmptyState } from '../../components/granary/EmptyState'
import { WalletCards } from 'lucide-react'
import { formatAmount, formatDayGroupLabel } from '../../lib/format'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { useRecordTxStore } from '../../store/recordTxStore'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { buildEditPayload, isEditableTransactionGroup, isEditableTransactionType } from '../record-transaction/editPayload'
import { flattenTransactionGroups, hasReconciledTransactionSplit, signedSplitAmount, type TransactionSplitRow } from '../../lib/transactionGroup'
import { absoluteDecimalString, compareDecimalStrings, sumDecimalStrings } from '../../lib/decimal'

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
  const deepLinkId = search.transaction == null ? null : String(search.transaction)
  const deepLinkQuery = useTransaction(deepLinkId)
  const openedDeepLink = useRef<string | null>(null)
  const range = useDateRangeStore()
  const [type, setType] = useState<TransactionTypeFilter>('all')
  const [pendingDelete, setPendingDelete] = useState<LoadedRow | null>(null)

  const openEdit = useRecordTxStore((s) => s.openEdit)
  const deleteMutation = useDeleteTransaction()
  const query = useInfiniteTransactions(range, { limit: PAGE_SIZE, type })

  useEffect(() => {
    const group = deepLinkQuery.data?.data
    if (!deepLinkId || !group || openedDeepLink.current === deepLinkId) return
    const first = group.attributes.transactions[0]
    if (!first || !isEditableTransactionGroup(first.type, hasReconciledTransactionSplit(group.attributes.transactions))) return
    openedDeepLink.current = deepLinkId
    openEdit(buildEditPayload(group.id, first, group.attributes.transactions.length))
  }, [deepLinkId, deepLinkQuery.data, openEdit])
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

  function handleEdit(row: LoadedRow) {
    openEdit(buildEditPayload(row.groupId, row.tx, row.splitCount))
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    try {
      await deleteMutation.mutateAsync(pendingDelete.groupId)
      showToast({ kind: 'success', message: '已删除交易' })
      setPendingDelete(null)
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '删除失败，请重试'
      showToast({ kind: 'error', message, duration: 6000 })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1" style={{ borderBottom: '1px solid var(--g-border)' }}>
        {TABS.map((tab) => {
          const active = tab.value === type
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => setType(tab.value)}
              className="relative px-3 py-2 text-[12.5px]"
              style={{
                color: active ? 'var(--g-ink)' : 'var(--g-ink-2)',
                fontWeight: active ? 'var(--g-weight-demibold)' : 'var(--g-weight-regular)',
              }}
            >
              {tab.label}
              {active && (
                <span
                  className="absolute inset-x-0 -bottom-px h-[2px]"
                  style={{ background: 'var(--g-accent)' }}
                />
              )}
            </button>
          )
        })}
      </div>

      {deepLinkQuery.isError && (
        <div className="flex items-center justify-between rounded-[6px] px-3 py-2 text-[12px]" style={{ background: 'var(--g-surface)', color: 'var(--g-danger)' }}>
          <span>指定交易加载失败或不存在</span>
          <button type="button" onClick={() => void deepLinkQuery.refetch()} style={{ color: 'var(--g-accent)' }}>重试</button>
        </div>
      )}

      <div className="rounded-[10px] p-2" style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}>
        {query.isLoading ? (
          <div className="flex flex-col gap-1 p-2">
            {Array.from({ length: 14 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : query.isError ? (
          <div className="flex flex-col items-center gap-2 py-8 text-[12.5px]" style={{ color: 'var(--g-danger)' }}>
            <span>交易加载失败</span>
            <button type="button" onClick={() => void query.refetch()} style={{ color: 'var(--g-accent)' }}>
              重试
            </button>
          </div>
        ) : loaded.length === 0 ? (
          query.isFetching ? (
            <EmptyState lottie="loading" message="加载中…" />
          ) : (
            <EmptyState icon={<WalletCards size={36} />} message="所选范围内暂无交易" />
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
                    className="flex h-7 items-center justify-between rounded-[4px] px-2 text-[11.5px]"
                    style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink-2)' }}
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
                                  ? 'var(--g-expense)'
                                  : comparison > 0
                                    ? 'var(--g-income)'
                                    : 'var(--g-ink-2)',
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
                    const editable = row.splitIndex === 0 && isEditableTransactionGroup(row.tx.type, row.hasReconciledSplit)
                    const deletable = row.splitIndex === 0 && row.splitCount > 0 && isEditableTransactionType(row.tx.type)
                    return (
                      <TransactionRow
                        key={`${row.groupId}-${row.tx.transaction_journal_id ?? row.splitIndex}`}
                        tx={row.tx}
                        ids={
                          editable || deletable
                            ? {
                                groupId: row.groupId,
                                journalId: String(row.tx.transaction_journal_id ?? row.groupId),
                              }
                            : undefined
                        }
                        onEdit={editable ? () => handleEdit(row) : undefined}
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
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-60"
              style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
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
    </div>
  )
}
