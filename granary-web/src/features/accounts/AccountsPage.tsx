import { useMemo, useState } from 'react'
import { PlusIcon } from '@heroicons/react/20/solid'
import type { AccountType } from '../../api/firefly'
import { useDeleteAccount, useInfiniteAccountsByType } from '../../api/queries'
import type { Account } from '../../api/schemas'
import { EmptyState } from '../../components/granary/EmptyState'
import { Skeleton } from '../../components/granary/Skeleton'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { formatAmount } from '../../lib/format'
import { AccountRow } from './AccountRow'
import { AccountDialog } from './AccountDialog'
import { Modal } from '../../components/granary/Modal'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { sumDecimalStrings } from '../../lib/decimal'

const LIMIT_STEP = 40

const TABS: { key: AccountType; label: string; emptyMessage: string; balanceColorVar: string }[] = [
  { key: 'asset', label: '资产', emptyMessage: '还没有资产账户', balanceColorVar: 'light-dark(var(--color-gray-900), var(--color-gray-100))' },
  { key: 'cash', label: '现金', emptyMessage: '还没有现金账户', balanceColorVar: 'light-dark(var(--color-gray-900), var(--color-gray-100))' },
  { key: 'liabilities', label: '负债', emptyMessage: '还没有负债账户', balanceColorVar: 'light-dark(var(--color-red-600), var(--color-red-400))' },
]

export function AccountsPage() {
  const [activeTab, setActiveTab] = useState<AccountType>('asset')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Account | null>(null)
  const [deleting, setDeleting] = useState<Account | null>(null)
  const deleteMutation = useDeleteAccount()

  async function confirmDelete() {
    if (!deleting) return
    try {
      await deleteMutation.mutateAsync(deleting.id)
      showToast({ kind: 'success', message: '账户已归档' })
      setDeleting(null)
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '账户归档失败', duration: 6000 })
    }
  }

  const tabConfig = TABS.find((t) => t.key === activeTab)!
  const query = useInfiniteAccountsByType(activeTab, { limit: LIMIT_STEP })
  const accounts = query.data?.pages.flatMap((page) => page.data) ?? []
  const total = query.data?.pages[0]?.meta?.pagination?.total ?? accounts.length
  const hasMore = !!query.hasNextPage

  const listRef = useStaggerIn<HTMLDivElement>([query.isSuccess, activeTab])

  // 资产合计只在「已加载全部资产账户」时才准确；资产账户数量通常很少，默认 limit 足够覆盖全量
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
  }, [activeTab, hasMore, query.data])

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          账户
        </h1>
        <div className="flex items-center gap-2">
          {query.data && <div className="text-[13px] text-gray-500 dark:text-gray-400">共 <span className="font-mono">{total}</span> 个</div>}
          <button type="button" title="新建账户" aria-label="新建账户" onClick={() => { setEditing(null); setDialogOpen(true) }} className="rounded-md bg-indigo-600 p-1.5 text-white shadow-sm hover:bg-indigo-500"><PlusIcon aria-hidden className="size-4" /></button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {TABS.map((tab) => {
          const isActive = tab.key === activeTab
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${
                isActive
                  ? 'border-indigo-600 font-semibold text-gray-900 dark:border-indigo-400 dark:text-gray-100'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:hover:border-gray-600 dark:hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {activeTab === 'asset' && assetSubtotals !== null && (
        <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-gray-700">
          <div
            className="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
          >
            资产余额合计
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xl font-semibold text-gray-900 dark:text-gray-100">
            {assetSubtotals.map((subtotal) => <span key={subtotal.code || subtotal.symbol} title={subtotal.code}>{subtotal.symbol}{formatAmount(subtotal.amount)}</span>)}
            {assetSubtotals.length === 0 && <span>--</span>}
          </div>
        </div>
      )}

      <div className="rounded-xl bg-white p-2 shadow-sm ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-gray-700">
        {query.isLoading ? (
          <div className="flex flex-col gap-1 p-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : query.isError ? (
          <div className="flex items-center justify-between px-3 py-8 text-[13px] text-red-600 dark:text-red-400"><span>账户加载失败</span><button type="button" onClick={() => void query.refetch()} className="text-indigo-600 dark:text-indigo-400">重试</button></div>
        ) : accounts.length === 0 ? (
          <EmptyState message={tabConfig.emptyMessage} />
        ) : (
          <div ref={listRef} className="flex flex-col">
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} balanceColorVar={tabConfig.balanceColorVar} onEdit={() => { setEditing(a); setDialogOpen(true) }} onDelete={() => setDeleting(a)} />
            ))}
          </div>
        )}

        {hasMore && (
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

      <AccountDialog open={dialogOpen} type={activeTab} account={editing} onClose={() => setDialogOpen(false)} />
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="归档账户" width={420} footer={<>
        <button type="button" onClick={() => setDeleting(null)} className="rounded-md px-3 py-1.5 text-[13px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">取消</button>
        <button type="button" disabled={deleteMutation.isPending} onClick={() => void confirmDelete()} className="rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-semibold text-white shadow-sm hover:bg-red-500 disabled:opacity-50">{deleteMutation.isPending ? '归档中…' : '归档'}</button>
      </>}><p className="text-[13px] text-gray-900 dark:text-gray-100">确认归档“{deleting?.attributes.name}”？归档后不再出现在日常账户列表中。</p></Modal>
    </div>
  )
}
