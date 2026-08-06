import { useEffect, useMemo, useState } from 'react'
import type { BillStatementRow } from '../../api/schemas'
import { useSplitBillStatementRow } from '../../api/queries'
import { Modal } from '../../components/abaku/Modal'
import { compareDecimalStrings, isPositiveDecimal, normalizeDecimalString, sumDecimalStrings } from '../../lib/decimal'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { PlusIcon, TrashIcon } from '@heroicons/react/20/solid'
import { Button, IconButton } from '../../components/ui/Button'
import { Input } from '../../components/ui/Field'

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
      <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
      <Button variant="primary" size="md" disabled={!valid || mutation.isPending} onClick={() => void submit()}>
        {mutation.isPending ? '拆分中…' : '确认拆分'}
      </Button>
    </>}>
      <div className="flex flex-col gap-3">
        {parts.map((part, index) => (
          <fieldset key={index} className="grid grid-cols-[1fr_1fr_100px_28px] gap-2 rounded-lg border border-[var(--border-subtle)] p-2">
            <legend className="px-1 text-xs text-[var(--text-tertiary)]">第 {index + 1} 项</legend>
            <Input aria-label={`拆分 ${index + 1} 支付方式`} placeholder="支付方式" value={part.payment_method} onChange={(event) => update(index, 'payment_method', event.target.value)} />
            <Input aria-label={`拆分 ${index + 1} 账户`} placeholder="扣款账户" value={part.source_name} onChange={(event) => update(index, 'source_name', event.target.value)} />
            <Input aria-label={`拆分 ${index + 1} 金额`} inputMode="decimal" placeholder="金额" value={part.amount} onChange={(event) => update(index, 'amount', event.target.value.replace(/[^0-9.]/g, ''))} className="text-right font-mono tabular-nums" />
            <IconButton
              label={`删除拆分 ${index + 1}`}
              variant="ghost-danger"
              disabled={parts.length <= 2}
              onClick={() => setParts((current) => current.filter((_, partIndex) => partIndex !== index))}
            >
              <TrashIcon aria-hidden className="size-4" />
            </IconButton>
            <Input className="col-span-2" aria-label={`拆分 ${index + 1} 描述`} placeholder="描述" value={part.description} onChange={(event) => update(index, 'description', event.target.value)} />
            <Input className="col-span-2" aria-label={`拆分 ${index + 1} 分类`} placeholder="分类（可选）" value={part.category_name} onChange={(event) => update(index, 'category_name', event.target.value)} />
          </fieldset>
        ))}
        <div className="flex items-center justify-between gap-3 pt-1">
          <Button variant="secondary" size="sm" onClick={() => setParts((current) => [...current, emptyPart(row)])}>
            <PlusIcon aria-hidden className="size-4" />
            添加一项
          </Button>
          {/* 合计对不上是提交前唯一的硬约束，所以写成一句能读的话而不是纯数字对比。
              role=status 让金额一改读屏就播报，不用等提交才知道差多少 */}
          <span
            role="status"
            className={`text-xs font-medium ${valid ? 'text-[var(--done)]' : 'text-[var(--danger)]'}`}
          >
            合计 <span className="font-mono tabular-nums">{total ?? '--'}</span> / 原金额{' '}
            <span className="font-mono tabular-nums">{target || '--'}</span>
            {!valid && '（必须相等）'}
          </span>
        </div>
      </div>
    </Modal>
  )
}
