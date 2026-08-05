import { useEffect, useMemo, useState } from 'react'
import type { BillStatementRow } from '../../api/schemas'
import { useSplitBillStatementRow } from '../../api/queries'
import { Modal } from '../../components/abaku/Modal'
import { compareDecimalStrings, isPositiveDecimal, normalizeDecimalString, sumDecimalStrings } from '../../lib/decimal'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'

interface Part {
  payment_method: string
  source_name: string
  amount: string
  description: string
  category_name: string
}

const emptyPart = (row?: BillStatementRow): Part => ({
  payment_method: '',
  source_name: '',
  amount: '',
  description: row?.attributes.firefly_description ?? row?.attributes.counterparty ?? '',
  category_name: row?.attributes.category_name ?? '',
})

export function SplitBillRowDialog({ row, open, onClose }: { row: BillStatementRow; open: boolean; onClose: () => void }) {
  const [parts, setParts] = useState<Part[]>([emptyPart(row), emptyPart(row)])
  const mutation = useSplitBillStatementRow()
  const target = row.attributes.amount?.trim() ?? ''
  const validTarget = (() => {
    try {
      return !!target && isPositiveDecimal(target)
    } catch {
      return false
    }
  })()

  useEffect(() => {
    if (open) setParts([emptyPart(row), emptyPart(row)])
  }, [open, row])

  const total = useMemo(() => {
    try {
      return sumDecimalStrings(parts.map((part) => part.amount || '0'))
    } catch {
      return null
    }
  }, [parts])
  const valid = validTarget && total !== null && (() => {
    try {
      return compareDecimalStrings(total, target) === 0
    } catch {
      return false
    }
  })()

  function update(index: number, key: keyof Part, value: string) {
    setParts((current) => current.map((part, partIndex) => partIndex === index ? { ...part, [key]: value } : part))
  }

  async function submit() {
    const invalidPart = parts.some((part) => {
      if (!part.source_name.trim() || !part.amount.trim() || !part.description.trim()) return true
      try {
        return !isPositiveDecimal(part.amount)
      } catch {
        return true
      }
    })
    if (!valid || invalidPart) {
      showToast({ kind: 'error', message: '每项账户和正金额必填，合计必须等于原金额' })
      return
    }
    try {
      await mutation.mutateAsync({
        rowId: row.id,
        splits: parts.map((part) => ({
          ...part,
          amount: normalizeDecimalString(part.amount),
          description: part.description.trim(),
          category_name: part.category_name.trim() || undefined,
        })),
      })
      showToast({ kind: 'success', message: '组合支付已拆分' })
      onClose()
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '拆分失败', duration: 6000 })
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="拆分组合支付" width={600} footer={<>
      <button type="button" onClick={onClose} className="rounded-[6px] px-3 py-1.5 text-[12.5px] text-[var(--text-secondary)] ">取消</button>
      <button type="button" disabled={!valid || mutation.isPending} onClick={() => void submit()} className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50 bg-[var(--brand)]  text-white">{mutation.isPending ? '拆分中…' : '确认拆分'}</button>
    </>}>
      <div className="flex flex-col gap-2">
        {parts.map((part, index) => (
          <div key={index} className="grid grid-cols-[1fr_1fr_100px_28px] gap-2">
            <input aria-label={`拆分 ${index + 1} 支付方式`} placeholder="支付方式" value={part.payment_method} onChange={(event) => update(index, 'payment_method', event.target.value)} className="rounded-[6px] px-2 py-1.5 text-[12px] bg-[var(--surface-hover)]  text-[var(--text-primary)] " style={{ border: '1px solid var(--border-subtle)' }} />
            <input aria-label={`拆分 ${index + 1} 账户`} placeholder="扣款账户" value={part.source_name} onChange={(event) => update(index, 'source_name', event.target.value)} className="rounded-[6px] px-2 py-1.5 text-[12px] bg-[var(--surface-hover)]  text-[var(--text-primary)] " style={{ border: '1px solid var(--border-subtle)' }} />
            <input aria-label={`拆分 ${index + 1} 金额`} inputMode="decimal" placeholder="金额" value={part.amount} onChange={(event) => update(index, 'amount', event.target.value.replace(/[^0-9.]/g, ''))} className="font-mono tabular-nums rounded-[6px] px-2 py-1.5 text-right text-[12px] bg-[var(--surface-hover)]  text-[var(--text-primary)] " style={{ border: '1px solid var(--border-subtle)' }} />
            <button type="button" aria-label={`删除拆分 ${index + 1}`} disabled={parts.length <= 2} onClick={() => setParts((current) => current.filter((_, partIndex) => partIndex !== index))} className="disabled:opacity-30 text-[var(--danger)] ">×</button>
            <input aria-label={`拆分 ${index + 1} 描述`} placeholder="描述" value={part.description} onChange={(event) => update(index, 'description', event.target.value)} className="col-span-2 rounded-[6px] px-2 py-1.5 text-[12px] bg-[var(--surface-hover)]  text-[var(--text-primary)] " style={{ border: '1px solid var(--border-subtle)' }} />
            <input aria-label={`拆分 ${index + 1} 分类`} placeholder="分类（可选）" value={part.category_name} onChange={(event) => update(index, 'category_name', event.target.value)} className="col-span-2 rounded-[6px] px-2 py-1.5 text-[12px] bg-[var(--surface-hover)]  text-[var(--text-primary)] " style={{ border: '1px solid var(--border-subtle)' }} />
          </div>
        ))}
        <div className="flex items-center justify-between pt-1 text-[12px]">
          <button type="button" onClick={() => setParts((current) => [...current, emptyPart(row)])} style={{ color: 'var(--brand)' }}>添加一项</button>
          <span className="font-mono tabular-nums" style={{ color: valid ? 'var(--done)' : 'var(--danger)' }}>合计 {total ?? '--'} / {target || '--'}</span>
        </div>
      </div>
    </Modal>
  )
}
