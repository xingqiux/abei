import { useEffect, useMemo, useState } from 'react'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { useDeleteTransaction, useTransactions } from '../../api/queries'
import type { TransactionSplit } from '../../api/schemas'
import type { TransactionTypeFilter } from '../../api/firefly'
import { TransactionRow } from '../../components/granary/TransactionRow'
import { DeleteTransactionDialog } from '../../components/granary/DeleteTransactionDialog'
import { Skeleton } from '../../components/granary/Skeleton'
import { EmptyState } from '../../components/granary/EmptyState'
import emptyWalletUrl from '../../assets/lottie/empty-wallet.json?url'
import { formatAmount, formatDayGroupLabel } from '../../lib/format'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { useRecordTxStore } from '../../store/recordTxStore'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { buildEditPayload } from '../record-transaction/editPayload'

const TABS: { label: string; value: TransactionTypeFilter }[] = [
  { label: '全部', value: 'all' },
  { label: '支出', value: 'withdrawal' },
  { label: '收入', value: 'deposit' },
  { label: '转账', value: 'transfer' },
]

const PAGE_SIZE = 80

interface LoadedRow {
  groupId: string
  splitCount: number
  tx: TransactionSplit
}

export function TransactionsPage() {
  const range = useDateRangeStore()
  const [type, setType] = useState<TransactionTypeFilter>('all')
  const [page, setPage] = useState(1)
  const [loaded, setLoaded] = useState<LoadedRow[]>([])
  const [pendingDelete, setPendingDelete] = useState<LoadedRow | null>(null)

  const openEdit = useRecordTxStore((s) => s.openEdit)
  const deleteMutation = useDeleteTransaction()
  const query = useTransactions(range, { limit: PAGE_SIZE, page, type })

  useEffect(() => {
    setPage(1)
    setLoaded([])
  }, [type, range.start, range.end])

  useEffect(() => {
    if (!query.data) return
    const rows: LoadedRow[] = query.data.data
      .map((g) => {
        const splits = g.attributes.transactions
        const tx = splits[0]
        if (!tx) return null
        return { groupId: g.id, splitCount: splits.length, tx }
      })
      .filter((r): r is LoadedRow => r !== null)
    setLoaded((prev) => (page === 1 ? rows : [...prev, ...rows]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data])

  const totalPages = query.data?.meta?.pagination?.total_pages ?? 1
  const canLoadMore = page < totalPages

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

  const listRef = useStaggerIn<HTMLDivElement>([query.isSuccess && page === 1])

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

      <div className="rounded-[10px] p-2" style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}>
        {query.isLoading && page === 1 ? (
          <div className="flex flex-col gap-1 p-2">
            {Array.from({ length: 14 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : loaded.length === 0 ? (
          query.isFetching ? (
            <EmptyState lottie="loading" message="加载中…" />
          ) : (
            <EmptyState lottieSrc={emptyWalletUrl} message="所选范围内暂无交易" />
          )
        ) : (
          <div ref={listRef} className="flex flex-col">
            {groups.map(([day, rows]) => {
              const subtotal = rows.reduce((acc, row) => {
                if (row.tx.type === 'withdrawal') return acc - Number(row.tx.amount)
                if (row.tx.type === 'deposit') return acc + Number(row.tx.amount)
                return acc
              }, 0)
              return (
                <div key={day}>
                  <div
                    className="flex h-7 items-center justify-between rounded-[4px] px-2 text-[11.5px]"
                    style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink-2)' }}
                  >
                    <span>{formatDayGroupLabel(day)}</span>
                    <span
                      className="font-num"
                      style={{
                        color:
                          subtotal < 0
                            ? 'var(--g-expense)'
                            : subtotal > 0
                              ? 'var(--g-income)'
                              : 'var(--g-ink-2)',
                      }}
                    >
                      {subtotal > 0 ? '+' : subtotal < 0 ? '-' : ''}¥{formatAmount(subtotal)}
                    </span>
                  </div>
                  {rows.map((row) => (
                    <TransactionRow
                      key={row.groupId}
                      tx={row.tx}
                      ids={{
                        groupId: row.groupId,
                        journalId: String(row.tx.transaction_journal_id ?? row.groupId),
                      }}
                      onEdit={() => handleEdit(row)}
                      onDelete={() => setPendingDelete(row)}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}

        {canLoadMore && (
          <div className="flex justify-center p-3">
            <button
              type="button"
              disabled={query.isFetching}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-60"
              style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
            >
              {query.isFetching ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}
      </div>

      <DeleteTransactionDialog
        open={!!pendingDelete}
        tx={pendingDelete?.tx ?? null}
        pending={deleteMutation.isPending}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
