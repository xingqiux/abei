import { useEffect, useMemo, useState } from 'react'
import type { AccountType } from '../../api/firefly'
import { useAccountsByType } from '../../api/queries'
import { EmptyState } from '../../components/granary/EmptyState'
import { Skeleton } from '../../components/granary/Skeleton'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { formatAmount } from '../../lib/format'
import { AccountRow } from './AccountRow'

const LIMIT_STEP = 40

const TABS: { key: AccountType; label: string; emptyMessage: string; balanceColorVar: string }[] = [
  { key: 'asset', label: '资产', emptyMessage: '还没有资产账户', balanceColorVar: 'var(--g-ink)' },
  { key: 'expense', label: '支出', emptyMessage: '还没有支出账户', balanceColorVar: 'var(--g-ink)' },
  { key: 'revenue', label: '收入', emptyMessage: '还没有收入账户', balanceColorVar: 'var(--g-ink)' },
  { key: 'liabilities', label: '负债', emptyMessage: '还没有负债账户', balanceColorVar: 'var(--g-expense)' },
]

export function AccountsPage() {
  const [activeTab, setActiveTab] = useState<AccountType>('asset')
  const [limit, setLimit] = useState(LIMIT_STEP)

  useEffect(() => {
    setLimit(LIMIT_STEP)
  }, [activeTab])

  const tabConfig = TABS.find((t) => t.key === activeTab)!
  const query = useAccountsByType(activeTab, { limit })
  const accounts = query.data?.data ?? []
  const total = query.data?.meta?.pagination?.total ?? accounts.length
  const hasMore = total > accounts.length

  const listRef = useStaggerIn<HTMLDivElement>([query.isSuccess, activeTab])

  // 资产合计只在「已加载全部资产账户」时才准确；资产账户数量通常很少，默认 limit 足够覆盖全量
  const assetSubtotal = useMemo(() => {
    if (activeTab !== 'asset' || hasMore) return null
    return accounts.reduce((acc, a) => acc + Number(a.attributes.current_balance ?? 0), 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, hasMore, query.data])

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[18px]" style={{ fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}>
          账户
        </h1>
        {query.data && (
          <div className="text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>
            共 <span className="font-num">{total}</span> 个
          </div>
        )}
      </div>

      <div className="flex gap-1" style={{ borderBottom: '1px solid var(--g-border)' }}>
        {TABS.map((tab) => {
          const isActive = tab.key === activeTab
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className="relative px-3 py-2 text-[12.5px]"
              style={{
                color: isActive ? 'var(--g-ink)' : 'var(--g-ink-2)',
                fontWeight: isActive ? 'var(--g-weight-demibold)' : 'var(--g-weight-regular)',
              }}
            >
              {tab.label}
              {isActive && <span className="absolute inset-x-0 -bottom-px h-[2px]" style={{ background: 'var(--g-accent)' }} />}
            </button>
          )
        })}
      </div>

      {activeTab === 'asset' && assetSubtotal !== null && (
        <div className="rounded-[10px] p-3.5" style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}>
          <div
            className="text-[11px]"
            style={{ color: 'var(--g-ink-2)', letterSpacing: '.04em', textTransform: 'uppercase' }}
          >
            资产余额合计
          </div>
          <div className="font-num mt-1.5" style={{ fontSize: 20, fontWeight: 600, color: 'var(--g-ink)' }}>
            ¥{formatAmount(assetSubtotal)}
          </div>
        </div>
      )}

      <div className="rounded-[10px] p-2" style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}>
        {query.isLoading ? (
          <div className="flex flex-col gap-1 p-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : accounts.length === 0 ? (
          <EmptyState message={tabConfig.emptyMessage} />
        ) : (
          <div ref={listRef} className="flex flex-col">
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} balanceColorVar={tabConfig.balanceColorVar} />
            ))}
          </div>
        )}

        {hasMore && (
          <div className="flex justify-center p-3">
            <button
              type="button"
              disabled={query.isFetching}
              onClick={() => setLimit((l) => l + LIMIT_STEP)}
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
