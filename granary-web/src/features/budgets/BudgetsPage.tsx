import { useMemo, useState } from 'react'
import { useBills, usePiggyBanks } from '../../api/queries'
import { useBudgetsData } from './useBudgetsData'
import { EmptyState } from '../../components/granary/EmptyState'
import { Skeleton } from '../../components/granary/Skeleton'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { BudgetRow } from './BudgetRow'
import { BillRow } from './BillRow'
import { PiggyRow } from './PiggyRow'
import { BUDGETS_TAB_CONFIG, type BudgetsTab } from './budgetsHelpers'

function TabBar({ active, onChange }: { active: BudgetsTab; onChange: (tab: BudgetsTab) => void }) {
  return (
    <div className="flex gap-1" style={{ borderBottom: '1px solid var(--g-border)' }}>
      {BUDGETS_TAB_CONFIG.map((tab) => {
        const isActive = tab.key === active
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
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
  const { budgetsQuery, limitByBudget } = useBudgetsData(range)
  const budgets = budgetsQuery.data?.data ?? []
  const listRef = useStaggerIn<HTMLDivElement>([budgetsQuery.isSuccess])

  if (budgetsQuery.isLoading) return <ListSkeleton />
  if (budgets.length === 0) {
    return <EmptyState message="还没有预算——预算功能主要由 CLI 管理，这里先看" />
  }
  return (
    <div ref={listRef} className="flex flex-col">
      {budgets.map((b) => (
        <BudgetRow key={b.id} budget={b} limitAmount={limitByBudget.get(b.id) ?? null} />
      ))}
    </div>
  )
}

function BillsTabContent() {
  const billsQuery = useBills()
  const bills = billsQuery.data?.data ?? []
  const listRef = useStaggerIn<HTMLDivElement>([billsQuery.isSuccess])

  if (billsQuery.isLoading) return <ListSkeleton />
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
        <h1 className="text-[18px]" style={{ fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}>
          预算与订阅
        </h1>
      </div>

      <TabBar active={activeTab} onChange={setActiveTab} />

      <div className="rounded-[10px] p-2" style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}>
        {content}
      </div>
    </div>
  )
}
