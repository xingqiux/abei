import { useMemo, useState } from 'react'
import { Plus } from '@phosphor-icons/react'
import type { AccountType } from '../../api/firefly'
import { useInfiniteAccountsByType, useUpdateAccount } from '../../api/queries'
import type { Account } from '../../api/schemas'
import { EmptyState } from '../../components/abei/EmptyState'
import { ErrorState } from '../../components/abei/ErrorState'
import { Skeleton } from '../../components/abei/Skeleton'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Tabs } from '../../components/ui/Tabs'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { formatAmount } from '../../lib/format'
import { AccountRow, type BalanceTone } from './AccountRow'
import { AccountDialog } from './AccountDialog'
import { AbeiApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { sumDecimalStrings } from '../../lib/decimal'

const LIMIT_STEP = 40

const TABS: { key: AccountType; label: string; emptyMessage: string; balanceTone: BalanceTone }[] = [
  { key: 'asset', label: '资产', emptyMessage: '还没有资产账户', balanceTone: 'neutral' },
  { key: 'cash', label: '现金', emptyMessage: '还没有现金账户', balanceTone: 'neutral' },
  { key: 'liabilities', label: '负债', emptyMessage: '还没有负债账户', balanceTone: 'liability' },
]

/** 账户页只管账户。预算与订阅是 /budgets 的事，那两个 tab v0.2 已经删掉。 */
export function AccountsPage() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">账户</h1>
      <AccountList />
    </div>
  )
}

function AccountList() {
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
      showToast({ kind: 'error', message: error instanceof AbeiApiError ? error.message : '操作失败', duration: 6000 })
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

  // 资产合计只在「已加载全部资产账户」时才准确；资产账户数量通常很少，默认 limit 足够覆盖全量。
  // 加总的必须是列表里那份 accounts：列表按 showArchived 过滤，合计原先用未过滤的 allAccounts，
  // 于是不勾「显示已归档」时合计里悄悄含着看不见的已归档账户，两个数字对不上。
  const assetSubtotals = useMemo(() => {
    if (activeTab !== 'asset' || hasMore) return null
    const byCurrency = new Map<string, { code: string; symbol: string; values: string[] }>()
    for (const account of accounts) {
      const attrs = account.attributes
      const code = attrs.currency_code ?? ''
      const current = byCurrency.get(code)
      if (current) current.values.push(attrs.current_balance ?? '0')
      else byCurrency.set(code, { code, symbol: attrs.currency_symbol ?? code, values: [attrs.current_balance ?? '0'] })
    }
    return Array.from(byCurrency.values(), ({ code, symbol, values }) => ({ code, symbol, amount: sumDecimalStrings(values) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, hasMore, accounts])

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex items-center gap-3">
          {query.data && (
            <div className="text-[13px] text-[var(--text-secondary)]">
              共 <span className="num">{total}</span> 个
            </div>
          )}
          <label className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-secondary)]">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="size-4 accent-[var(--brand)]" />
            显示已归档
          </label>
          <Button variant="primary" size="sm" onClick={() => { setEditing(null); setDialogOpen(true) }}>
            <Plus aria-hidden className="size-4" />
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
          <div className="num mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xl font-semibold text-[var(--text-primary)]">
            {assetSubtotals.map((subtotal) => <span key={subtotal.code || subtotal.symbol} title={subtotal.code}>{subtotal.symbol}{formatAmount(subtotal.amount)}</span>)}
            {assetSubtotals.length === 0 && <span>--</span>}
          </div>
          {/* 数字带口径：合计跟着上面那个勾走，不说清楚就会被当成「全部资产」 */}
          <div className="mt-1 text-[11px] text-[var(--text-secondary)]">
            {showArchived ? '含已归档账户' : '不含已归档账户'} · 按币种分开合计
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
          <ErrorState message="账户加载失败" error={query.error} onRetry={() => void query.refetch()} />
        ) : accounts.length === 0 ? (
          <EmptyState
            message={tabConfig.emptyMessage}
            action={{ label: '新建账户', onClick: () => { setEditing(null); setDialogOpen(true) } }}
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
