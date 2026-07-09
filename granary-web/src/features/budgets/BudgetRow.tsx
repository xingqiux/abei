import type { Budget } from '../../api/schemas'
import { ProgressBar } from '../../components/granary/ProgressBar'
import { formatAmount } from '../../lib/format'

/** 预算一行：名称 + 已花费/限额进度条（超支变 danger）+ 金额 mono */
export function BudgetRow({ budget, limitAmount }: { budget: Budget; limitAmount: number | null }) {
  const a = budget.attributes
  const symbol = a.currency_symbol ?? '¥'
  const spent = Math.abs(Number(a.spent?.[0]?.sum ?? 0))
  const hasLimit = limitAmount !== null && limitAmount > 0
  const pct = hasLimit ? (spent / limitAmount) * 100 : 0
  const over = hasLimit && spent > limitAmount

  return (
    <div className="flex h-8 items-center gap-3 rounded-[4px] px-2 text-[12.5px]">
      <div className="min-w-0 flex-1 truncate" style={{ color: 'var(--g-ink)' }}>
        {a.name}
      </div>

      <div className="flex w-[180px] shrink-0 items-center">
        {hasLimit ? (
          <ProgressBar pct={pct} colorVar={over ? 'var(--g-danger)' : 'var(--g-accent)'} />
        ) : (
          <span className="text-[11px]" style={{ color: 'var(--g-ink-2)' }}>
            未设限额
          </span>
        )}
      </div>

      <div
        className="font-num w-[170px] shrink-0 text-right"
        style={{ color: over ? 'var(--g-danger)' : 'var(--g-ink)' }}
      >
        {symbol}
        {formatAmount(spent)}
        {hasLimit && (
          <span style={{ color: 'var(--g-ink-2)' }}>
            {' '}
            / {symbol}
            {formatAmount(limitAmount)}
          </span>
        )}
      </div>
    </div>
  )
}
