import { useMemo, useState } from 'react'
import { PlusIcon } from '@heroicons/react/20/solid'
import { useBills, useCreateBudget, useCreateBudgetWithLimit, useCurrencies, usePiggyBanks } from '../../api/queries'
import { useBudgetsData } from './useBudgetsData'
import { EmptyState } from '../../components/granary/EmptyState'
import { Skeleton } from '../../components/granary/Skeleton'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { BudgetRow } from './BudgetRow'
import { BillRow } from './BillRow'
import { PiggyRow } from './PiggyRow'
import { BUDGETS_TAB_CONFIG, type BudgetsTab } from './budgetsHelpers'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { Modal } from '../../components/granary/Modal'
import { ErrorState } from '../../components/granary/ErrorState'
import { isPositiveDecimal, normalizeDecimalString } from '../../lib/decimal'

function TabBar({ active, onChange }: { active: BudgetsTab; onChange: (tab: BudgetsTab) => void }) {
  return (
    <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
      {BUDGETS_TAB_CONFIG.map((tab) => {
        const isActive = tab.key === active
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            className="relative px-3 py-2 text-[12.5px]"
            style={{
              color: isActive ? 'light-dark(var(--color-gray-900), var(--color-gray-100))' : 'light-dark(var(--color-gray-500), var(--color-gray-400))',
              fontWeight: isActive ? '600' : '400',
            }}
          >
            {tab.label}
            {isActive && <span className="absolute inset-x-0 -bottom-px h-[2px]" style={{ background: 'light-dark(var(--color-indigo-600), var(--color-indigo-500))' }} />}
          </button>
        )
      })}
    </div>
  )
}

function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1 p-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-8" />
      ))}
    </div>
  )
}

function BudgetsTabContent() {
  const range = useDateRangeStore()
  const { budgetsQuery, limitsByBudget, limitStateByBudget } = useBudgetsData(range)
  const budgets = budgetsQuery.data?.data ?? []
  const listRef = useStaggerIn<HTMLDivElement>([budgetsQuery.isSuccess])
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [limitAmount, setLimitAmount] = useState('')
  const [currencyCode, setCurrencyCode] = useState('')
  const createBudget = useCreateBudget()
  const createWithLimit = useCreateBudgetWithLimit()
  const currenciesQuery = useCurrencies()

  const openCreate = () => {
    const currencies = currenciesQuery.data?.data ?? []
    setCurrencyCode(
      currencies.find((currency) => currency.attributes.default && currency.attributes.enabled !== false)?.attributes.code
      ?? currencies.find((currency) => currency.attributes.enabled !== false)?.attributes.code
      ?? '',
    )
    setCreateOpen(true)
  }

  async function handleCreate() {
    const n = name.trim()
    if (!n) {
      showToast({ message: '请输入预算名称', kind: 'error' })
      return
    }
    try {
      let hasValidLimit = false
      try {
        hasValidLimit = limitAmount.trim() !== '' && isPositiveDecimal(limitAmount)
      } catch {
        hasValidLimit = false
      }
      if (limitAmount.trim() && !hasValidLimit) {
        showToast({ message: '限额必须是大于 0 的有效金额', kind: 'error' })
        return
      }
      if (hasValidLimit) {
        if (!currencyCode) {
          showToast({ message: '请选择限额币种', kind: 'error' })
          return
        }
        await createWithLimit.mutateAsync({
          name: n,
          active: true,
          limit: { start: range.start, end: range.end, amount: normalizeDecimalString(limitAmount), currency_code: currencyCode },
        })
      } else {
        await createBudget.mutateAsync({ name: n, active: true })
      }
      setCreateOpen(false)
      setName('')
      setLimitAmount('')
      showToast({ message: '预算已创建', kind: 'success' })
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '创建失败，请重试'
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

  return (
    <>
      <div className="mb-2 flex justify-end px-1">
        <button
          type="button"
          onClick={openCreate}
          className="flex items-center gap-1 rounded-[6px] px-2.5 py-1 text-[12px]"
          style={{
            background: 'light-dark(var(--color-indigo-600), var(--color-indigo-500))',
            color: 'var(--color-white)',
            fontWeight: '600',
          }}
        >
          <PlusIcon aria-hidden className="size-3.5" />
          新建预算
        </button>
      </div>
      {budgetsQuery.isLoading ? (
        <ListSkeleton />
      ) : budgetsQuery.isError ? (
        <div className="px-2 py-8 text-center text-[12.5px] text-red-600 dark:text-red-400">
          预算加载失败
          <div className="mt-1 text-[11.5px] text-gray-500 dark:text-gray-400">
            {budgetsQuery.error instanceof Error ? budgetsQuery.error.message : '请检查 API 或刷新重试'}
          </div>
          <button
            type="button"
            onClick={() => void budgetsQuery.refetch()}
            className="mt-3 rounded-[6px] px-3 py-1.5 text-[12px]"
            style={{ background: 'light-dark(var(--color-gray-100), var(--color-gray-700))', color: 'light-dark(var(--color-gray-900), var(--color-gray-100))' }}
          >
            重试
          </button>
        </div>
      ) : budgets.length === 0 ? (
        <EmptyState message="还没有预算——点右上角新建，或在 CLI 里创建" />
      ) : (
        <div ref={listRef} className="flex flex-col">
          {budgets.map((b) => (
            <BudgetRow key={b.id} budget={b} limits={limitsByBudget.get(b.id) ?? []} range={range} limitsLoading={limitStateByBudget.get(b.id)?.isLoading} limitsError={limitStateByBudget.get(b.id)?.isError} onRetryLimits={() => void limitStateByBudget.get(b.id)?.refetch?.()} />
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建预算"
        width={400}
        footer={
          <>
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="rounded-[6px] px-3 py-1.5 text-[12.5px]"
              style={{ background: 'light-dark(var(--color-gray-100), var(--color-gray-700))', color: 'light-dark(var(--color-gray-900), var(--color-gray-100))' }}
            >
              取消
            </button>
            <button
              type="button"
              disabled={createBudget.isPending || createWithLimit.isPending}
              onClick={() => void handleCreate()}
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50"
              style={{
                background: 'light-dark(var(--color-indigo-600), var(--color-indigo-500))',
                color: 'var(--color-white)',
                fontWeight: '600',
              }}
            >
              {createBudget.isPending || createWithLimit.isPending ? '创建中…' : '创建'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-[12.5px]">
          <label className="flex flex-col gap-1">
            <span style={{ color: 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}>名称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-[6px] px-2.5 py-1.5 outline-none"
              style={{ background: 'light-dark(var(--color-gray-100), var(--color-gray-700))', color: 'light-dark(var(--color-gray-900), var(--color-gray-100))', border: '1px solid light-dark(var(--color-gray-200), var(--color-gray-600))' }}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1">
            <span style={{ color: 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}>限额币种</span>
            <select value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value)} className="font-mono tabular-nums rounded-[6px] px-2.5 py-1.5 outline-none" style={{ background: 'light-dark(var(--color-gray-100), var(--color-gray-700))', color: 'light-dark(var(--color-gray-900), var(--color-gray-100))', border: '1px solid light-dark(var(--color-gray-200), var(--color-gray-600))' }}>
              <option value="">选择币种…</option>
              {(currenciesQuery.data?.data ?? []).filter((currency) => currency.attributes.enabled !== false).map((currency) => <option key={currency.id} value={currency.attributes.code}>{currency.attributes.code} · {currency.attributes.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span style={{ color: 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}>
              当期限额（可选，范围 {range.start} → {range.end}）
            </span>
            <input
              value={limitAmount}
              onChange={(e) => setLimitAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="如 2000"
              className="font-mono tabular-nums rounded-[6px] px-2.5 py-1.5 outline-none"
              style={{ background: 'light-dark(var(--color-gray-100), var(--color-gray-700))', color: 'light-dark(var(--color-gray-900), var(--color-gray-100))', border: '1px solid light-dark(var(--color-gray-200), var(--color-gray-600))' }}
            />
          </label>
        </div>
      </Modal>
    </>
  )
}

function BillsTabContent() {
  const billsQuery = useBills()
  const bills = billsQuery.data?.data ?? []
  const listRef = useStaggerIn<HTMLDivElement>([billsQuery.isSuccess])

  if (billsQuery.isLoading) return <ListSkeleton />
  if (billsQuery.isError) return <ErrorState message="订阅加载失败" onRetry={() => void billsQuery.refetch()} />
  if (bills.length === 0) {
    return <EmptyState message="还没有订阅——订阅账单主要由 CLI 或账单收件箱创建，这里先看" />
  }
  return (
    <div ref={listRef} className="flex flex-col">
      {bills.map((b) => (
        <BillRow key={b.id} bill={b} />
      ))}
    </div>
  )
}

function PiggyTabContent() {
  const piggyQuery = usePiggyBanks()
  const piggyBanks = piggyQuery.data?.data ?? []
  const listRef = useStaggerIn<HTMLDivElement>([piggyQuery.isSuccess])

  if (piggyQuery.isLoading) return <ListSkeleton />
  if (piggyQuery.isError) return <ErrorState message="储蓄罐加载失败" onRetry={() => void piggyQuery.refetch()} />
  if (piggyBanks.length === 0) {
    return <EmptyState message="还没有储蓄罐——储蓄罐主要由 CLI 管理，这里先看" />
  }
  return (
    <div ref={listRef} className="flex flex-col">
      {piggyBanks.map((p) => (
        <PiggyRow key={p.id} piggyBank={p} />
      ))}
    </div>
  )
}

export function BudgetsPage() {
  const [activeTab, setActiveTab] = useState<BudgetsTab>('budgets')

  const content = useMemo(() => {
    if (activeTab === 'budgets') return <BudgetsTabContent />
    if (activeTab === 'bills') return <BillsTabContent />
    return <PiggyTabContent />
  }, [activeTab])

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[18px]" style={{ fontWeight: '600', color: 'light-dark(var(--color-gray-900), var(--color-gray-100))' }}>
          预算与订阅
        </h1>
      </div>

      <TabBar active={activeTab} onChange={setActiveTab} />

      <div className="rounded-[10px] p-2" style={{ background: 'light-dark(var(--color-white), var(--color-gray-800))', boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05), 0 1px 3px 0 rgb(0 0 0 / 0.08)' }}>
        {content}
      </div>
    </div>
  )
}
