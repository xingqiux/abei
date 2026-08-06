import { useMemo, useState } from 'react'
import { PlusIcon } from '@heroicons/react/20/solid'
import type { AccountType } from '../../api/firefly'
import { useInfiniteAccountsByType, useUpdateAccount } from '../../api/queries'
import type { Account } from '../../api/schemas'
import { EmptyState } from '../../components/abaku/EmptyState'
import { ErrorState } from '../../components/abaku/ErrorState'
import { Skeleton } from '../../components/abaku/Skeleton'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Tabs } from '../../components/ui/Tabs'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { formatAmount } from '../../lib/format'
import { AccountRow, type BalanceTone } from './AccountRow'
import { AccountDialog } from './AccountDialog'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { sumDecimalStrings } from '../../lib/decimal'

const LIMIT_STEP = 40

const TABS: { key: AccountType; label: string; emptyMessage: string; balanceTone: BalanceTone }[] = [
  { key: 'asset', label: '资产', emptyMessage: '还没有资产账户', balanceTone: 'neutral' },
  { key: 'cash', label: '现金', emptyMessage: '还没有现金账户', balanceTone: 'neutral' },
  { key: 'liabilities', label: '负债', emptyMessage: '还没有负债账户', balanceTone: 'danger' },
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">账户</h1>
        <div className="flex items-center gap-3">
          {query.data && (
            <div className="text-[13px] text-[var(--text-secondary)]">
              共 <span className="font-mono tabular-nums">{total}</span> 个
            </div>
          )}
          <label className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-secondary)]">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="size-4 accent-[var(--brand)]" />
            显示已归档
          </label>
          <Button variant="primary" size="sm" onClick={() => { setEditing(null); setDialogOpen(true) }}>
            <PlusIcon aria-hidden className="size-4" />
            新建账户
          </Button>
        </div>
      </div>

      <Tabs
        aria-label="账户类型"
        tabs={TABS.map((tab) => ({ value: tab.key, label: tab.label }))}
        value={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === 'asset' && assetSubtotals !== null && (
        <Card>
          <div className="text-[11px] font-medium tracking-wide text-[var(--text-tertiary)] uppercase">
            资产余额合计
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xl font-semibold tabular-nums text-[var(--text-primary)]">
            {assetSubtotals.map((subtotal) => <span key={subtotal.code || subtotal.symbol} title={subtotal.code}>{subtotal.symbol}{formatAmount(subtotal.amount)}</span>)}
            {assetSubtotals.length === 0 && <span>--</span>}
          </div>
        </Card>
      )}

      <Card padded={false} className="p-2">
        {query.isLoading ? (
          <div className="flex flex-col gap-1 p-2" role="status" aria-label="账户加载中">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : query.isError ? (
          <ErrorState message="账户加载失败" onRetry={() => void query.refetch()} />
        ) : accounts.length === 0 ? (
          <EmptyState
            art="empty-wallet"
            message={tabConfig.emptyMessage}
            actionLabel="新建账户"
            onAction={() => { setEditing(null); setDialogOpen(true) }}
          />
        ) : (
          <div ref={listRef} className="flex flex-col">
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} balanceTone={tabConfig.balanceTone} onEdit={() => { setEditing(a); setDialogOpen(true) }} onToggleArchive={() => void toggleArchive(a)} />
            ))}
          </div>
        )}

        {hasMore && (
          <div className="flex justify-center p-3">
            <Button variant="secondary" size="md" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {query.isFetchingNextPage ? '加载中…' : '加载更多'}
            </Button>
          </div>
        )}
      </Card>

      <AccountDialog open={dialogOpen} type={activeTab} account={editing} onClose={() => setDialogOpen(false)} />
    </div>
  )
}
