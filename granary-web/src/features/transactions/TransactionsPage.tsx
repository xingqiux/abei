import { useEffect, useMemo, useState } from 'react'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { useTransactions } from '../../api/queries'
import type { TransactionSplit } from '../../api/schemas'
import type { TransactionTypeFilter } from '../../api/firefly'
import { TransactionRow } from '../../components/granary/TransactionRow'
import { Skeleton } from '../../components/granary/Skeleton'
import { EmptyState } from '../../components/granary/EmptyState'
import emptyWalletUrl from '../../assets/lottie/empty-wallet.json?url'
import { formatAmount, formatDayGroupLabel } from '../../lib/format'
import { useStaggerIn } from '../../motion/useStaggerIn'

const TABS: { label: string; value: TransactionTypeFilter }[] = [
  { label: '全部', value: 'all' },
  { label: '支出', value: 'withdrawal' },
  { label: '收入', value: 'deposit' },
  { label: '转账', value: 'transfer' },
]

const PAGE_SIZE = 80

export function TransactionsPage() {
  const range = useDateRangeStore()
  const [type, setType] = useState<TransactionTypeFilter>('all')
  const [page, setPage] = useState(1)
  const [loaded, setLoaded] = useState<TransactionSplit[]>([])

  const query = useTransactions(range, { limit: PAGE_SIZE, page, type })

  // 切换 tab 或日期范围时重置分页与已加载数据
  useEffect(() => {
    setPage(1)
    setLoaded([])
  }, [type, range.start, range.end])

  useEffect(() => {
    if (!query.data) return
    const rows = query.data.data.map((g) => g.attributes.transactions[0]).filter(Boolean)
    setLoaded((prev) => (page === 1 ? rows : [...prev, ...rows]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data])

  const totalPages = query.data?.meta?.pagination?.total_pages ?? 1
  const canLoadMore = page < totalPages

  const groups = useMemo(() => {
    const map = new Map<string, TransactionSplit[]>()
    for (const tx of loaded) {
      const day = tx.date.slice(0, 10)
      const arr = map.get(day)
      if (arr) arr.push(tx)
      else map.set(day, [tx])
    }
    return Array.from(map.entries())
  }, [loaded])

  const listRef = useStaggerIn<HTMLDivElement>([query.isSuccess && page === 1])

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
            {groups.map(([day, txs]) => {
              const subtotal = txs.reduce((acc, tx) => {
                if (tx.type === 'withdrawal') return acc - Number(tx.amount)
                if (tx.type === 'deposit') return acc + Number(tx.amount)
                return acc
              }, 0)
              return (
                <div key={day}>
                  <div
                    className="flex h-7 items-center justify-between rounded-[4px] px-2 text-[11.5px]"
                    style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink-2)' }}
                  >
                    <span>{formatDayGroupLabel(day)}</span>
                    <span className="font-num" style={{ color: subtotal < 0 ? 'var(--g-expense)' : subtotal > 0 ? 'var(--g-income)' : 'var(--g-ink-2)' }}>
                      {subtotal > 0 ? '+' : subtotal < 0 ? '-' : ''}¥{formatAmount(subtotal)}
                    </span>
                  </div>
                  {txs.map((tx, i) => (
                    <TransactionRow key={i} tx={tx} />
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
    </div>
  )
}
