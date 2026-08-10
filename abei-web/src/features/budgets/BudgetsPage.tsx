import { useMemo, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { CaretRight } from '@phosphor-icons/react'
import { useBudgetGroups, useSetGroupBudget } from '../../api/queries'
import type { BudgetGroup } from '../../api/schemas'
import { Card } from '../../components/ui/Card'
import { Tabs } from '../../components/ui/Tabs'
import { BUDGETS_TAB_CONFIG, type BudgetsTab } from './budgetsHelpers'
import { SubscriptionsTab } from './SubscriptionsTab'
import { CategoryIcon } from '../../components/abei/CategoryIcon'
import { EmptyState } from '../../components/abei/EmptyState'
import { ErrorState } from '../../components/abei/ErrorState'
import { Skeleton } from '../../components/abei/Skeleton'
import { Button } from '../../components/ui/Button'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { usePageRange } from '../../store/dateRangeStore'
import { showToast } from '../../store/toastStore'
import { AbeiApiError } from '../../api/client'
import { formatAmount } from '../../lib/format'
import {
  absoluteDecimalString,
  compareDecimalStrings,
  isPositiveDecimal,
  normalizeDecimalString,
  subtractDecimalStrings,
} from '../../lib/decimal'

/**
 * 预算与订阅（设计稿 01 §4）。预算按支出域的「组」设，叶子自动汇总进组，
 * 不再逐笔挂 budget_id。订阅那半边不动。
 */
export function BudgetsPage() {
  const search = useSearch({ from: '/budgets' })
  const navigate = useNavigate({ from: '/budgets' })
  const view: BudgetsTab = search.view ?? 'budgets'

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">预算</h1>

      <Tabs
        aria-label="预算与订阅"
        tabs={BUDGETS_TAB_CONFIG.map((tab) => ({ value: tab.key, label: tab.label }))}
        value={view}
        onChange={(next) => void navigate({ search: { view: next === 'budgets' ? undefined : next }, replace: true })}
      />

      <Card padded={false} className="p-2">
        {view === 'budgets' ? <GroupBudgetsTab /> : <SubscriptionsTab />}
      </Card>
    </div>
  )
}

function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1 p-2" role="status" aria-label="加载中">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-11" />
      ))}
    </div>
  )
}

/** 色板号 "1"~"12"；缺失或非法一律回落 12 灰 */
function catIndex(color: string | null | undefined): number {
  const n = Number(color)
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 12
}

export function GroupBudgetsTab() {
  const range = usePageRange('budgets')
  const groupsQuery = useBudgetGroups({ start: range.start, end: range.end })
  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data])
  const listRef = useStaggerIn<HTMLDivElement>([groupsQuery.isSuccess])
  const [unsetOpen, setUnsetOpen] = useState(false)

  const withBudget = groups.filter((g) => g.amount != null && g.amount !== '')
  const withoutBudget = groups.filter((g) => g.amount == null || g.amount === '')

  if (groupsQuery.isLoading) return <ListSkeleton />
  if (groupsQuery.isError) {
    return (
      <ErrorState
        message={
          groupsQuery.error instanceof Error
            ? `预算加载失败：${groupsQuery.error.message}`
            : '预算加载失败，请检查 API 或刷新重试'
        }
        error={groupsQuery.error}
        onRetry={() => void groupsQuery.refetch()}
      />
    )
  }
  if (groups.length === 0) {
    return <EmptyState message="没有支出分类" action={{ label: '去分类页', to: '/reference-data' }} />
  }

  return (
    <div className="flex flex-col">
      <div className="px-1 pb-1 text-[11px] text-[var(--text-secondary)]">
        口径：{range.start} → {range.end}，按组统计该组全部子分类的支出
      </div>

      {withBudget.length === 0 ? (
        <EmptyState
          message="尚未设置任何预算"
          action={{ label: '展开未设预算', onClick: () => setUnsetOpen(true) }}
        />
      ) : (
        <div ref={listRef} className="flex flex-col">
          {withBudget.map((group) => (
            <GroupBudgetRow key={group.category_id} group={group} />
          ))}
        </div>
      )}

      {withoutBudget.length > 0 && (
        <div className="mt-2 border-t border-[var(--border-subtle)] pt-2">
          <button
            type="button"
            aria-expanded={unsetOpen}
            onClick={() => setUnsetOpen((v) => !v)}
            className="flex min-h-11 w-full items-center gap-2 rounded-[4px] px-2 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)]"
          >
            <CaretRight aria-hidden weight="bold" className={`size-3.5 transition-transform ${unsetOpen ? 'rotate-90' : ''}`} />
            未设预算（<span className="num">{withoutBudget.length}</span> 组）
          </button>
          {unsetOpen && (
            <div className="flex flex-col">
              {withoutBudget.map((group) => (
                <GroupBudgetRow key={group.category_id} group={group} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GroupBudgetRow({ group }: { group: BudgetGroup }) {
  const setBudget = useSetGroupBudget()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const amount = group.amount != null && group.amount !== '' ? group.amount : null
  const spent = group.spent && group.spent !== '' ? group.spent : '0'
  const cat = catIndex(group.color)

  function startEdit() {
    setDraft(amount ?? '')
    setEditing(true)
  }

  async function save(next: string | null) {
    try {
      await setBudget.mutateAsync({ categoryId: group.category_id, amount: next })
      setEditing(false)
      showToast({ kind: 'success', message: next == null ? `已清除「${group.name}」的预算` : `已设「${group.name}」预算` })
    } catch (err) {
      const message = err instanceof AbeiApiError || err instanceof Error ? err.message : '保存失败，请重试'
      showToast({ kind: 'error', message, duration: 6000 })
    }
  }

  function submit() {
    const raw = draft.trim()
    if (raw === '') {
      void save(null)
      return
    }
    let normalized: string
    try {
      if (!isPositiveDecimal(raw)) throw new Error('invalid')
      normalized = normalizeDecimalString(raw)
    } catch {
      showToast({ kind: 'error', message: '预算金额要大于 0，留空表示不设预算', duration: 6000 })
      return
    }
    void save(normalized)
  }

  const remaining = amount == null ? null : subtractDecimalStrings(amount, spent)
  const over = remaining != null && compareDecimalStrings(remaining, '0') < 0

  return (
    <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12.5px] transition-colors hover:bg-[var(--surface-hover)]">
      <CategoryIcon icon={group.icon} color={group.color} size={20} />
      <span className="w-[92px] shrink-0 truncate text-[var(--text-primary)]">{group.name}</span>

      {editing ? (
        <div className="flex flex-1 items-center gap-1.5">
          <input
            autoFocus
            inputMode="decimal"
            aria-label={`${group.name} 预算金额`}
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setEditing(false)
              }
            }}
            placeholder="留空 = 不设"
            className="num w-28 rounded px-1.5 py-1 text-right text-xs bg-[var(--surface-2)] text-[var(--text-primary)] outline-1 -outline-offset-1 outline-[var(--border-strong)] placeholder:text-[var(--text-tertiary)] focus:outline-2 focus:-outline-offset-2 focus:outline-[var(--focus-ring)]"
          />
          <Button size="xs" variant="primary" disabled={setBudget.isPending} onClick={submit}>
            {setBudget.isPending ? '保存中…' : '保存'}
          </Button>
          <Button size="xs" variant="ghost" disabled={setBudget.isPending} onClick={() => setEditing(false)}>
            取消
          </Button>
        </div>
      ) : amount == null ? (
        <div className="flex flex-1 items-center gap-2">
          <span className="flex-1 text-[var(--text-secondary)]">
            这段时间花了 <span className="num">{formatAmount(spent)}</span>
          </span>
          <Button size="xs" variant="soft" onClick={startEdit}>
            设预算
          </Button>
        </div>
      ) : (
        <>
          <SpendBar spent={spent} amount={amount} cat={cat} label={`${group.name}预算已用`} />
          <span
            className="num w-[104px] shrink-0 text-right"
            style={over ? { color: 'var(--danger)' } : undefined}
            title={group.currency_code}
          >
            {over ? '超支 ' : '剩 '}
            {formatAmount(absoluteDecimalString(remaining ?? '0'))}
          </span>
          <Button size="xs" variant="ghost" onClick={startEdit}>
            改
          </Button>
        </>
      )}
    </div>
  )
}

/**
 * 进度条：底色用该组色板的 soft，进度用实色，超出预算那一段用 --danger。
 * 宽度是运行时算的，只能走内联样式；色板号也是运行时的，同理。
 */
function SpendBar({ spent, amount, cat, label }: { spent: string; amount: string; cat: number; label: string }) {
  const over = compareDecimalStrings(spent, amount) > 0
  const ratio = safeRatio(spent, amount)
  // 超支时把条子按「已花」重新缩放：预算那一段实色，超出去那一段红色
  const basePct = over ? (ratio === 0 ? 0 : (100 / ratio) * 100) : Math.min(100, ratio)
  const overPct = over ? 100 - basePct : 0

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(ratio)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${Math.round(ratio)}%`}
      className="flex h-2 min-w-[80px] flex-1 overflow-hidden rounded-full"
      style={{ backgroundColor: `var(--cat-${cat}-soft)` }}
    >
      <div
        className="h-full transition-[width] duration-240 motion-reduce:transition-none"
        style={{ width: `${basePct}%`, backgroundColor: `var(--cat-${cat})` }}
      />
      {overPct > 0 && (
        <div
          className="h-full transition-[width] duration-240 motion-reduce:transition-none"
          style={{ width: `${overPct}%`, backgroundColor: 'var(--danger)' }}
        />
      )}
    </div>
  )
}

/** 已花 / 预算的百分比，可以超过 100（decimalPercentage 会截到 100，这里要看到超支多少） */
function safeRatio(spent: string, amount: string): number {
  const a = Number(spent)
  const b = Number(amount)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return 0
  return (a / b) * 100
}
