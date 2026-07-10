import { useEffect, useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import type { BillStatementRow } from '../../api/schemas'
import { useUpdateBillStatementRow } from '../../api/queries'
import { CategoryChip } from '../../components/granary/CategoryChip'
import { StatusChip } from '../../components/granary/StatusChip'
import { showToast } from '../../store/toastStore'
import { formatAmount, formatMonthDay } from '../../lib/format'
import { FireflyApiError } from '../../api/client'
import { directionColorVar, directionSign, isRowSelectable, rowBadge } from './billInboxHelpers'

const inputStyle = {
  background: 'var(--g-surface)',
  color: 'var(--g-ink)',
  border: '1px solid var(--g-border)',
} as const

function asText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function rowDescription(a: BillStatementRow['attributes']): string {
  return (
    asText(a.firefly_description) ||
    asText(a.counterparty) ||
    asText((a as { description?: unknown }).description) ||
    '--'
  )
}

function rowAmount(a: BillStatementRow['attributes']): string {
  const raw = a.firefly_amount ?? a.amount
  return raw == null || raw === '' ? '0' : String(raw)
}

/**
 * 收件箱任务详情单行：只读展示 + pending/unique 行可行内改描述/分类/金额。
 * 保存走 PATCH /api/v1/bill-statement-rows/{id}。
 */
export function StatementRow({
  row,
  selected,
  onToggle,
}: {
  row: BillStatementRow
  selected: boolean
  onToggle: () => void
}) {
  const a = row.attributes
  const selectable = isRowSelectable(row)
  const badge = rowBadge(row)
  const canEdit = a.status === 'pending' // 待入账行可改（含 duplicate 仅不可勾选，仍可能要改后重判——先只开 unique 可编辑更安全）
  const editable = canEdit && a.duplicate_state === 'unique'

  const [editing, setEditing] = useState(false)
  const [desc, setDesc] = useState('')
  const [category, setCategory] = useState('')
  const [amount, setAmount] = useState('')
  const updateMutation = useUpdateBillStatementRow()

  useEffect(() => {
    if (!editing) return
    setDesc(rowDescription(a) === '--' ? '' : rowDescription(a))
    setCategory(asText(a.category_name))
    setAmount(rowAmount(a))
  }, [editing, row.id]) // eslint-disable-line react-hooks/exhaustive-deps -- 进入编辑时灌当前行

  function startEdit() {
    const d = rowDescription(a)
    setDesc(d === '--' ? '' : d)
    setCategory(asText(a.category_name))
    setAmount(rowAmount(a))
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
  }

  async function saveEdit() {
    const amountNum = Number(amount)
    if (!amount.trim() || !Number.isFinite(amountNum) || amountNum < 0) {
      showToast({ message: '请输入有效金额', kind: 'error' })
      return
    }
    const descTrim = desc.trim()
    if (!descTrim) {
      showToast({ message: '描述不能为空', kind: 'error' })
      return
    }
    const amountStr = amountNum.toFixed(2)
    try {
      await updateMutation.mutateAsync({
        rowId: row.id,
        input: {
          firefly_description: descTrim,
          description: descTrim,
          category_name: category.trim() || null,
          amount: amountStr,
          firefly_amount: amountStr,
        },
      })
      setEditing(false)
      showToast({ message: '行已更新', kind: 'success' })
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '保存失败，请重试'
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

  if (editing) {
    return (
      <div
        className="flex min-h-8 flex-wrap items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12.5px]"
        style={{ background: 'var(--g-surface-2)' }}
      >
        <span className="w-4 shrink-0" aria-hidden />
        <span className="font-num w-[48px] shrink-0" style={{ color: 'var(--g-ink-2)' }}>
          {formatMonthDay(a.occurred_at)}
        </span>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          aria-label="描述"
          className="min-w-[120px] flex-1 rounded-[4px] px-1.5 py-0.5 text-[12.5px] outline-none"
          style={inputStyle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveEdit()
            if (e.key === 'Escape') cancelEdit()
          }}
        />
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="分类"
          placeholder="分类"
          className="w-[80px] shrink-0 rounded-[4px] px-1.5 py-0.5 text-[12.5px] outline-none"
          style={inputStyle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveEdit()
            if (e.key === 'Escape') cancelEdit()
          }}
        />
        <span className="w-[180px] shrink-0 truncate text-[11.5px]" style={{ color: 'var(--g-ink-2)' }}>
          {a.source_name ?? '?'} → {a.destination_name ?? '?'}
        </span>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          aria-label="金额"
          className="font-num w-[90px] shrink-0 rounded-[4px] px-1.5 py-0.5 text-right text-[12.5px] outline-none"
          style={inputStyle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveEdit()
            if (e.key === 'Escape') cancelEdit()
          }}
        />
        <div className="flex w-[64px] shrink-0 items-center justify-end gap-0.5">
          <button
            type="button"
            aria-label="保存"
            disabled={updateMutation.isPending}
            onClick={() => void saveEdit()}
            className="rounded p-1 disabled:opacity-50"
            style={{ color: 'var(--g-accent)' }}
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            aria-label="取消"
            disabled={updateMutation.isPending}
            onClick={cancelEdit}
            className="rounded p-1 disabled:opacity-50"
            style={{ color: 'var(--g-ink-2)' }}
          >
            <X size={14} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="group flex h-8 items-center gap-2 rounded-[4px] px-2 text-[12.5px] transition-colors hover:bg-[var(--g-surface-2)]">
      <input
        type="checkbox"
        aria-label="选择此行"
        disabled={!selectable}
        checked={selected}
        onChange={onToggle}
        className="shrink-0 disabled:opacity-30"
      />
      <span className="font-num w-[48px] shrink-0" style={{ color: 'var(--g-ink-2)' }}>
        {formatMonthDay(a.occurred_at)}
      </span>
      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--g-ink)' }}>
        {rowDescription(a)}
      </span>
      <span className="w-[80px] shrink-0">
        {a.category_name ? <CategoryChip label={a.category_name} /> : null}
      </span>
      <span className="w-[180px] shrink-0 truncate text-[11.5px]" style={{ color: 'var(--g-ink-2)' }}>
        {a.source_name ?? '?'} → {a.destination_name ?? '?'}
      </span>
      <span className="font-num w-[110px] shrink-0 text-right" style={{ color: directionColorVar(a.direction) }}>
        {directionSign(a.direction)}¥{formatAmount(rowAmount(a))}
      </span>
      <span className="flex w-[64px] shrink-0 items-center justify-end gap-0.5">
        {badge && <StatusChip label={badge.label} kind={badge.kind} />}
        {editable && (
          <button
            type="button"
            aria-label="编辑行"
            onClick={startEdit}
            className="rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
            style={{ color: 'var(--g-ink-2)' }}
          >
            <Pencil size={13} />
          </button>
        )}
      </span>
    </div>
  )
}
