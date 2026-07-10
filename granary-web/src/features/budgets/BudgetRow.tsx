import { useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import type { Budget } from '../../api/schemas'
import type { DateRange } from '../../api/firefly'
import { useCreateBudgetLimit, useUpdateBudgetLimit } from '../../api/queries'
import { ProgressBar } from '../../components/granary/ProgressBar'
import { formatAmount } from '../../lib/format'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import type { BudgetLimitInfo } from './useBudgetsData'

const inputStyle = {
  background: 'var(--g-surface)',
  color: 'var(--g-ink)',
  border: '1px solid var(--g-border)',
} as const

/** 预算一行：名称 + 进度 + 已花费/限额；可编辑当期限额（POST 新建或 PUT 更新） */
export function BudgetRow({
  budget,
  limitInfo,
  range,
}: {
  budget: Budget
  limitInfo: BudgetLimitInfo | null
  range: DateRange
}) {
  const a = budget.attributes
  const symbol = a.currency_symbol ?? '¥'
  const spent = Math.abs(Number(a.spent?.[0]?.sum ?? 0))
  const limitAmount = limitInfo?.amount ?? null
  const hasLimit = limitAmount !== null && limitAmount > 0
  const pct = hasLimit ? (spent / (limitAmount as number)) * 100 : 0
  const over = hasLimit && spent > (limitAmount as number)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const createLimit = useCreateBudgetLimit()
  const updateLimit = useUpdateBudgetLimit()
  const pending = createLimit.isPending || updateLimit.isPending

  function startEdit() {
    setDraft(hasLimit ? String(limitAmount) : '')
    setEditing(true)
  }

  async function save() {
    const n = Number(draft)
    if (!draft.trim() || !Number.isFinite(n) || n <= 0) {
      showToast({ message: '请输入大于 0 的限额', kind: 'error' })
      return
    }
    const amount = n.toFixed(2)
    try {
      if (limitInfo?.limitId) {
        await updateLimit.mutateAsync({
          budgetId: budget.id,
          limitId: limitInfo.limitId,
          input: { amount, start: range.start, end: range.end },
        })
      } else {
        await createLimit.mutateAsync({
          budgetId: budget.id,
          input: { start: range.start, end: range.end, amount },
        })
      }
      setEditing(false)
      showToast({ message: '限额已更新', kind: 'success' })
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '保存失败，请重试'
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

  return (
    <div className="group flex h-8 items-center gap-3 rounded-[4px] px-2 text-[12.5px] hover:bg-[var(--g-surface-2)]">
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

      {editing ? (
        <div className="flex w-[170px] shrink-0 items-center justify-end gap-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
            aria-label="限额金额"
            className="font-num w-[90px] rounded-[4px] px-1.5 py-0.5 text-right text-[12.5px] outline-none"
            style={inputStyle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              if (e.key === 'Escape') setEditing(false)
            }}
            autoFocus
          />
          <button type="button" aria-label="保存限额" disabled={pending} onClick={() => void save()} className="rounded p-1" style={{ color: 'var(--g-accent)' }}>
            <Check size={14} />
          </button>
          <button type="button" aria-label="取消" disabled={pending} onClick={() => setEditing(false)} className="rounded p-1" style={{ color: 'var(--g-ink-2)' }}>
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="flex w-[170px] shrink-0 items-center justify-end gap-1">
          <div className="font-num text-right" style={{ color: over ? 'var(--g-danger)' : 'var(--g-ink)' }}>
            {symbol}
            {formatAmount(spent)}
            {hasLimit && (
              <span style={{ color: 'var(--g-ink-2)' }}>
                {' '}
                / {symbol}
                {formatAmount(limitAmount as number)}
              </span>
            )}
          </div>
          <button
            type="button"
            aria-label="编辑限额"
            onClick={startEdit}
            className="rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
            style={{ color: 'var(--g-ink-2)' }}
          >
            <Pencil size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
