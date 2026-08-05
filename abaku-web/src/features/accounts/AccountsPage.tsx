import { useMemo, useState } from 'react'
import { PlusIcon } from '@heroicons/react/20/solid'
import type { AccountType } from '../../api/firefly'
import { useInfiniteAccountsByType, useUpdateAccount } from '../../api/queries'
import type { Account } from '../../api/schemas'
import { EmptyState } from '../../components/abaku/EmptyState'
import { Skeleton } from '../../components/abaku/Skeleton'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { formatAmount } from '../../lib/format'
import { AccountRow } from './AccountRow'
import { AccountDialog } from './AccountDialog'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { sumDecimalStrings } from '../../lib/decimal'

const LIMIT_STEP = 40

const TABS: { key: AccountType; label: string; emptyMessage: string; balanceColorVar: string }[] = [
  { key: 'asset', label: '资产', emptyMessage: '还没有资产账户', balanceColorVar: 'var(--text-primary)' },
  { key: 'cash', label: '现金', emptyMessage: '还没有现金账户', balanceColorVar: 'var(--text-primary)' },
  { key: 'liabilities', label: '负债', emptyMessage: '还没有负债账户', balanceColorVar: 'var(--danger)' },
]

export function AccountsPage() {
  const [activeTab, setActiveTab] = useState<AccountType>('asset')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Account | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const archiveMutation = useUpdateAccount()

  async function toggleArchive(account: Account) {
    try {
      const archived = account.attributes.active === false
      // 已归档的点一下是恢复（active=true），在用的点一下是归档（active=false）。
      await archiveMutation.mutateAsync({
        accountId: account.id,
        input: { name: account.attributes.name, active: archived },
      })
      showToast({ kind: 'success', message: archived ? '账户已恢复' : '账户已归档，数据都还在' })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '操作失败', duration: 6000 })
    }
  }

  const tabConfig = TABS.find((t) => t.key === activeTab)!
  const query = useInfiniteAccountsByType(activeTab, { limit: LIMIT_STEP })
  const allAccounts = useMemo(() => query.data?.pages.flatMap((page) => page.data) ?? [], [query.data])
  const accounts = useMemo(
    () => allAccounts.filter((a) => showArchived || a.attributes.active !== false),
    [allAccounts, showArchived],
  )
  const total = query.data?.pages[0]?.meta?.pagination?.total ?? accounts.length
  const hasMore = !!query.hasNextPage

  const listRef = useStaggerIn<HTMLDivElement>([query.isSuccess, activeTab])

  // 资产合计只在「已加载全部资产账户」时才准确；资产账户数量通常很少，默认 limit 足够覆盖全量
  const assetSubtotals = useMemo(() => {
    if (activeTab !== 'asset' || hasMore) return null
    const byCurrency = new Map<string, { code: string; symbol: string; values: string[] }>()
    for (const account of allAccounts) {
      const attrs = account.attributes
      const code = attrs.currency_code ?? ''
      const current = byCurrency.get(code)
      if (current) current.values.push(attrs.current_balance ?? '0')
      else byCurrency.set(code, { code, symbol: attrs.currency_symbol ?? code, values: [attrs.current_balance ?? '0'] })
    }
    return Array.from(byCurrency.values(), ({ code, symbol, values }) => ({ code, symbol, amount: sumDecimalStrings(values) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, hasMore, allAccounts])

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-[var(--text-primary)] ">
          账户
        </h1>
        <div className="flex items-center gap-2">
          {query.data && <div className="text-[13px] text-[var(--text-secondary)] ">共 <span className="font-mono">{total}</span> 个</div>}
          <label className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-secondary)] ">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="size-4 accent-[var(--brand)]" />
            显示已归档
          </label>
          <button type="button" title="新建账户" aria-label="新建账户" onClick={() => { setEditing(null); setDialogOpen(true) }} className="rounded-md bg-[var(--brand)] p-1.5 text-white shadow-sm hover:bg-[var(--brand-hover)]"><PlusIcon aria-hidden className="size-4" /></button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-[var(--border-subtle)] ">
        {TABS.map((tab) => {
          const isActive = tab.key === activeTab
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${
                isActive
                  ? 'border-[var(--brand)] font-semibold text-[var(--text-primary)]  '
                  : 'border-transparent text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]  '
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {activeTab === 'asset' && assetSubtotals !== null && (
        <div className="rounded-xl bg-[var(--surface-1)] p-4 shadow-sm ring-1 ring-[var(--border-subtle)]  ">
          <div
            className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)] "
          >
            资产余额合计
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xl font-semibold text-[var(--text-primary)] ">
            {assetSubtotals.map((subtotal) => <span key={subtotal.code || subtotal.symbol} title={subtotal.code}>{subtotal.symbol}{formatAmount(subtotal.amount)}</span>)}
            {assetSubtotals.length === 0 && <span>--</span>}
          </div>
        </div>
      )}

      <div className="rounded-xl bg-[var(--surface-1)] p-2 shadow-sm ring-1 ring-[var(--border-subtle)]  ">
        {query.isLoading ? (
          <div className="flex flex-col gap-1 p-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : query.isError ? (
          <div className="flex items-center justify-between px-3 py-8 text-[13px] text-[var(--danger)] "><span>账户加载失败</span><button type="button" onClick={() => void query.refetch()} className="text-[var(--brand)] ">重试</button></div>
        ) : accounts.length === 0 ? (
          <EmptyState art="empty-wallet" message={tabConfig.emptyMessage} />
        ) : (
          <div ref={listRef} className="flex flex-col">
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} balanceColorVar={tabConfig.balanceColorVar} onEdit={() => { setEditing(a); setDialogOpen(true) }} onToggleArchive={() => void toggleArchive(a)} />
            ))}
          </div>
        )}

        {hasMore && (
          <div className="flex justify-center p-3">
            <button
              type="button"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              className="rounded-md bg-[var(--surface-hover)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--surface-selected)] disabled:opacity-60   "
            >
              {query.isFetchingNextPage ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}
      </div>

      <AccountDialog open={dialogOpen} type={activeTab} account={editing} onClose={() => setDialogOpen(false)} />
    </div>
  )
}
