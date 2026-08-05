import { useMemo, useState } from 'react'
import { PlusIcon } from '@heroicons/react/20/solid'
import { useSearch, useNavigate } from '@tanstack/react-router'
import { useCreateBudget, useCreateBudgetWithLimit, useCurrencies } from '../../api/queries'
import { useBudgetsData } from './useBudgetsData'
import { EmptyState } from '../../components/abaku/EmptyState'
import { Skeleton } from '../../components/abaku/Skeleton'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { usePageRange } from '../../store/dateRangeStore'
import { BudgetRow } from './BudgetRow'
import { BUDGETS_TAB_CONFIG, type BudgetsTab } from './budgetsHelpers'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { Modal } from '../../components/abaku/Modal'
import { isPositiveDecimal, normalizeDecimalString } from '../../lib/decimal'
import { SubscriptionsTab } from './SubscriptionsTab'

function TabBar({ active, onChange }: { active: BudgetsTab; onChange: (tab: BudgetsTab) => void }) {
  return (
    <div className="flex gap-1 border-b border-[var(--border-subtle)] ">
      {BUDGETS_TAB_CONFIG.map((tab) => {
        const isActive = tab.key === active
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            className="relative px-3 py-2 text-[12.5px]"
            style={{
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: isActive ? '600' : '400',
            }}
          >
            {tab.label}
            {isActive && <span className="absolute inset-x-0 -bottom-px h-[2px] bg-[var(--brand)] "  />}
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
  const range = usePageRange('budgets')
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
          className="flex items-center gap-1 rounded-[6px] px-2.5 py-1 text-[12px] bg-[var(--brand)]  text-white font-semibold"

        >
          <PlusIcon aria-hidden className="size-3.5" />
          新建预算
        </button>
      </div>
      {budgetsQuery.isLoading ? (
        <ListSkeleton />
      ) : budgetsQuery.isError ? (
        <div className="px-2 py-8 text-center text-[12.5px] text-[var(--danger)] ">
          预算加载失败
          <div className="mt-1 text-[11.5px] text-[var(--text-secondary)] ">
            {budgetsQuery.error instanceof Error ? budgetsQuery.error.message : '请检查 API 或刷新重试'}
          </div>
          <button
            type="button"
            onClick={() => void budgetsQuery.refetch()}
            className="mt-3 rounded-[6px] px-3 py-1.5 text-[12px] bg-[var(--surface-hover)]  text-[var(--text-primary)] "

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
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] bg-[var(--surface-hover)]  text-[var(--text-primary)] "

            >
              取消
            </button>
            <button
              type="button"
              disabled={createBudget.isPending || createWithLimit.isPending}
              onClick={() => void handleCreate()}
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50 bg-[var(--brand)]  text-white font-semibold"

            >
              {createBudget.isPending || createWithLimit.isPending ? '创建中…' : '创建'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-[12.5px]">
          <label className="flex flex-col gap-1">
            <span style={{ color: 'var(--text-secondary)' }}>名称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-[6px] px-2.5 py-1.5 outline-none bg-[var(--surface-hover)]  text-[var(--text-primary)] "
              style={{ border: '1px solid var(--border-subtle)' }}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1">
            <span style={{ color: 'var(--text-secondary)' }}>限额币种</span>
            <select value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value)} className="font-mono tabular-nums rounded-[6px] px-2.5 py-1.5 outline-none bg-[var(--surface-hover)]  text-[var(--text-primary)] " style={{ border: '1px solid var(--border-subtle)' }}>
              <option value="">选择币种…</option>
              {(currenciesQuery.data?.data ?? []).filter((currency) => currency.attributes.enabled !== false).map((currency) => <option key={currency.id} value={currency.attributes.code}>{currency.attributes.code} · {currency.attributes.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span style={{ color: 'var(--text-secondary)' }}>
              当期限额（可选，范围 {range.start} → {range.end}）
            </span>
            <input
              value={limitAmount}
              onChange={(e) => setLimitAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="如 2000"
              className="font-mono tabular-nums rounded-[6px] px-2.5 py-1.5 outline-none bg-[var(--surface-hover)]  text-[var(--text-primary)] "
              style={{ border: '1px solid var(--border-subtle)' }}
            />
          </label>
        </div>
      </Modal>
    </>
  )
}

export function BudgetsPage() {
  const search = useSearch({ from: '/budgets' })
  const navigate = useNavigate({ from: '/budgets' })
  const [activeTab, setActiveTab] = useState<BudgetsTab>(search.tab === 'subscriptions' ? 'subscriptions' : 'budgets')

  const content = useMemo(() => {
    if (activeTab === 'budgets') return <BudgetsTabContent />
    return <SubscriptionsTab />
  }, [activeTab])

  function changeTab(tab: BudgetsTab) {
    setActiveTab(tab)
    void navigate({ search: { tab: tab === 'budgets' ? undefined : tab }, replace: true })
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[18px] font-semibold text-[var(--text-primary)] ">
          预算
        </h1>
      </div>

      <TabBar active={activeTab} onChange={changeTab} />

      <div className="rounded-[10px] p-2 bg-[var(--surface-1)]  shadow-sm">
        {content}
      </div>
    </div>
  )
}
