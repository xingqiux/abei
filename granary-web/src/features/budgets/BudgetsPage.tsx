import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { useBills, useCreateBudget, useCreateBudgetLimit, usePiggyBanks } from '../../api/queries'
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
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [limitAmount, setLimitAmount] = useState('')
  const createBudget = useCreateBudget()
  const createLimit = useCreateBudgetLimit()

  async function handleCreate() {
    const n = name.trim()
    if (!n) {
      showToast({ message: '请输入预算名称', kind: 'error' })
      return
    }
    try {
      const res = await createBudget.mutateAsync({ name: n, active: true })
      const lim = Number(limitAmount)
      if (limitAmount.trim() && Number.isFinite(lim) && lim > 0) {
        await createLimit.mutateAsync({
          budgetId: res.data.id,
          input: { start: range.start, end: range.end, amount: lim.toFixed(2) },
        })
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
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1 rounded-[6px] px-2.5 py-1 text-[12px]"
          style={{
            background: 'var(--g-accent)',
            color: 'var(--g-accent-ink)',
            fontWeight: 'var(--g-weight-demibold)',
          }}
        >
          <Plus size={13} />
          新建预算
        </button>
      </div>
      {budgetsQuery.isLoading ? (
        <ListSkeleton />
      ) : budgets.length === 0 ? (
        <EmptyState message="还没有预算——点右上角新建，或在 CLI 里创建" />
      ) : (
        <div ref={listRef} className="flex flex-col">
          {budgets.map((b) => (
            <BudgetRow key={b.id} budget={b} limitInfo={limitByBudget.get(b.id) ?? null} range={range} />
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
              style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
            >
              取消
            </button>
            <button
              type="button"
              disabled={createBudget.isPending || createLimit.isPending}
              onClick={() => void handleCreate()}
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50"
              style={{
                background: 'var(--g-accent)',
                color: 'var(--g-accent-ink)',
                fontWeight: 'var(--g-weight-demibold)',
              }}
            >
              {createBudget.isPending || createLimit.isPending ? '创建中…' : '创建'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-[12.5px]">
          <label className="flex flex-col gap-1">
            <span style={{ color: 'var(--g-ink-2)' }}>名称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-[6px] px-2.5 py-1.5 outline-none"
              style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)', border: '1px solid var(--g-border)' }}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1">
            <span style={{ color: 'var(--g-ink-2)' }}>
              当期限额（可选，范围 {range.start} → {range.end}）
            </span>
            <input
              value={limitAmount}
              onChange={(e) => setLimitAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="如 2000"
              className="font-num rounded-[6px] px-2.5 py-1.5 outline-none"
              style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)', border: '1px solid var(--g-border)' }}
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
