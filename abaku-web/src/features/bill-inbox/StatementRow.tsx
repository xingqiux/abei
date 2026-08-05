import { useState } from 'react'
import { CheckIcon, PencilIcon, ScissorsIcon, XMarkIcon } from '@heroicons/react/24/outline'
import type { BillStatementRow } from '../../api/schemas'
import { useUpdateBillStatementRow } from '../../api/queries'
import { CategoryChip } from '../../components/abaku/CategoryChip'
import { StatusChip } from '../../components/abaku/StatusChip'
import { showToast } from '../../store/toastStore'
import { formatAmount, formatMonthDay } from '../../lib/format'
import { FireflyApiError } from '../../api/client'
import { directionColorClass, directionSign, isRowSelectable, rowBadge } from './billInboxHelpers'
import { SplitBillRowDialog } from './SplitBillRowDialog'
import { isPositiveDecimal, normalizeDecimalString } from '../../lib/decimal'

const inputStyle = {
  background: 'var(--surface-2)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
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

function rowDate(a: BillStatementRow['attributes']): string | null {
  return a.firefly_date ?? a.occurred_at
}

/**
 * 收件箱任务详情单行：只读展示 + pending/unique 行可补齐入账草稿。
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
  const effectiveDate = rowDate(a)
  const selectable = isRowSelectable(row)
  const badge = rowBadge(row)
  const canEdit = a.status === 'pending' // 待入账行可改（含 duplicate 仅不可勾选，仍可能要改后重判——先只开 unique 可编辑更安全）
  const editable = canEdit && a.duplicate_state === 'unique'

  const [editing, setEditing] = useState(false)
  const [desc, setDesc] = useState('')
  const [category, setCategory] = useState('')
  const [amount, setAmount] = useState('')
  const [transactionType, setTransactionType] = useState('')
  const [date, setDate] = useState('')
  const [source, setSource] = useState('')
  const [destination, setDestination] = useState('')
  const [splitOpen, setSplitOpen] = useState(false)
  const updateMutation = useUpdateBillStatementRow()

  function startEdit() {
    const d = rowDescription(a)
    setDesc(d === '--' ? '' : d)
    setCategory(asText(a.category_name))
    setAmount(rowAmount(a))
    setTransactionType(a.firefly_type ?? '')
    setDate(effectiveDate?.slice(0, 10) ?? '')
    setSource(asText(a.source_name))
    setDestination(asText(a.destination_name))
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
  }

  async function saveEdit() {
    const descTrim = desc.trim()
    const sourceTrim = source.trim()
    const destinationTrim = destination.trim()
    if (!transactionType || !date || !descTrim || !sourceTrim || !destinationTrim) {
      showToast({ message: '请补全类型、日期、描述和账户流向', kind: 'error' })
      return
    }
    try {
      if (!amount.trim() || !isPositiveDecimal(amount)) throw new Error('invalid amount')
    } catch {
      showToast({ message: '请输入大于 0 的金额', kind: 'error' })
      return
    }
    const amountStr = normalizeDecimalString(amount)
    try {
      await updateMutation.mutateAsync({
        rowId: row.id,
        input: {
          firefly_type: transactionType as 'withdrawal' | 'deposit' | 'transfer',
          firefly_date: date,
          firefly_description: descTrim,
          description: descTrim,
          source_name: sourceTrim,
          destination_name: destinationTrim,
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
        id={`bill-row-${row.id}`}
        className="flex min-h-8 flex-wrap items-center gap-2 rounded-[4px] px-2 py-1.5 text-[12.5px] bg-[var(--surface-hover)] "

      >
        <span className="w-4 shrink-0" aria-hidden />
        <select
          value={transactionType}
          onChange={(e) => setTransactionType(e.target.value)}
          aria-label="交易类型"
          className="w-[96px] shrink-0 rounded-[4px] px-1.5 py-0.5 text-[12px] outline-none"
          style={inputStyle}
        >
          <option value="">类型</option>
          <option value="withdrawal">支出</option>
          <option value="deposit">收入</option>
          <option value="transfer">转账</option>
        </select>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="交易日期"
          className="w-[126px] shrink-0 rounded-[4px] px-1.5 py-0.5 text-[12px] outline-none"
          style={inputStyle}
        />
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
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          aria-label="来源账户"
          placeholder="来源账户"
          className="w-[120px] shrink-0 rounded-[4px] px-1.5 py-0.5 text-[12px] outline-none"
          style={inputStyle}
        />
        <input
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          aria-label="目标账户"
          placeholder="目标账户"
          className="w-[120px] shrink-0 rounded-[4px] px-1.5 py-0.5 text-[12px] outline-none"
          style={inputStyle}
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          aria-label="金额"
          className="font-mono tabular-nums w-[90px] shrink-0 rounded-[4px] px-1.5 py-0.5 text-right text-[12.5px] outline-none"
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
            className="rounded p-1 disabled:opacity-50 text-[var(--brand)] "

          >
            <CheckIcon aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="取消"
            disabled={updateMutation.isPending}
            onClick={cancelEdit}
            className="rounded p-1 disabled:opacity-50 text-[var(--text-secondary)] "

          >
            <XMarkIcon aria-hidden className="size-3.5" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div id={`bill-row-${row.id}`} className="group flex h-8 items-center gap-2 rounded-[4px] px-2 text-[12.5px] transition-colors hover:bg-[var(--surface-hover)]">
      <input
        type="checkbox"
        aria-label="选择此行"
        disabled={!selectable}
        checked={selected}
        onChange={onToggle}
        className="shrink-0 disabled:opacity-30"
      />
      <span className="font-mono tabular-nums w-[48px] shrink-0 text-[var(--text-secondary)] ">
        {effectiveDate ? formatMonthDay(effectiveDate) : '--'}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)] ">
        {rowDescription(a)}
      </span>
      <span className="w-[80px] shrink-0">
        {a.category_name ? <CategoryChip label={a.category_name} /> : null}
      </span>
      <span className="w-[180px] shrink-0 truncate text-[11.5px] text-[var(--text-secondary)] ">
        {a.source_name ?? '?'} → {a.destination_name ?? '?'}
      </span>
      <span className={`font-mono tabular-nums w-[110px] shrink-0 text-right ${directionColorClass(a.direction)}`}>
        {directionSign(a.direction)}{a.currency_symbol ?? a.currency_code ?? ''}{formatAmount(rowAmount(a))}
      </span>
      <span className="flex w-[64px] shrink-0 items-center justify-end gap-0.5">
        {badge && <StatusChip label={badge.label} kind={badge.kind} />}
        {a.status === 'needs_split' && (
          <button type="button" title="拆分组合支付" aria-label="拆分组合支付" onClick={() => setSplitOpen(true)} className="rounded p-1 text-[var(--brand)] ">
            <ScissorsIcon aria-hidden className="size-3.5" />
          </button>
        )}
        {editable && (
          <button
            type="button"
            aria-label="编辑行"
            onClick={startEdit}
            className="rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 text-[var(--text-secondary)] "

          >
            <PencilIcon aria-hidden className="size-3.5" />
          </button>
        )}
      </span>
      <SplitBillRowDialog row={row} open={splitOpen} onClose={() => setSplitOpen(false)} />
    </div>
  )
}
