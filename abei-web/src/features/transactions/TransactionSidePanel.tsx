import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, PencilSimple, Trash } from '@phosphor-icons/react'
import { useUpdateTransaction } from '../../api/queries'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Field, Input } from '../../components/ui/Field'
import { CategoryPicker } from '../../components/abei/CategoryPicker'
import { formatDateLabel, formatSignedAmount, semanticColorClass } from '../../lib/format'
import { splitSemantic, type TransactionSplitRow } from '../../lib/transactionGroup'
import { showToast } from '../../store/toastStore'
import { useRecordTxStore } from '../../store/recordTxStore'
import { AbeiApiError } from '../../api/client'
import { buildEditPayload, isEditableTransactionType } from '../record-transaction/editPayload'
import { parseTags, splitToUpdateInput } from './updateInput'

const TYPE_LABELS: Record<string, string> = {
  withdrawal: '支出',
  deposit: '收入',
  transfer: '转账',
  reconciliation: '对账调整',
  'opening balance': '期初余额',
}

/**
 * 右侧详情面板：选中一笔就在这里看细节、改分类和标签，改完直接走下一笔。
 *
 * 归几十笔未分类时，弹窗要开→改→关→再开，一笔四步；面板只有「改→下一笔」两步。
 * 只处理单条拆分的组：PUT 是整组替换，多拆分的组必须走完整编辑表单。
 */
export function TransactionSidePanel({
  row,
  splitCount,
  selected,
  onToggleSelect,
  onPrev,
  onNext,
  onDelete,
}: {
  row: TransactionSplitRow
  splitCount: number
  selected: boolean
  onToggleSelect: () => void
  onPrev: () => void
  onNext: () => void
  onDelete: () => void
}) {
  const tx = row.tx
  const updateMutation = useUpdateTransaction()
  const openEdit = useRecordTxStore((state) => state.openEdit)
  const [category, setCategory] = useState<string | null>(tx.category_name ?? null)
  const [tags, setTags] = useState((tx.tags ?? []).join('、'))

  // 换了一笔就把草稿换掉，否则上一笔没保存的输入会挂到下一笔头上
  useEffect(() => {
    setCategory(tx.category_name ?? null)
    setTags((tx.tags ?? []).join('、'))
  }, [row.groupId, row.splitIndex, tx.category_name, tx.tags])

  const semantic = splitSemantic(tx)
  const editable = isEditableTransactionType(tx.type)
  const quickEditable = editable && splitCount === 1

  async function save(thenNext: boolean) {
    try {
      await updateMutation.mutateAsync({
        groupId: row.groupId,
        input: splitToUpdateInput(tx, { categoryName: category, tags: parseTags(tags) }),
      })
      showToast({ kind: 'success', message: category ? `已归到「${category}」` : '已保存' })
      if (thenNext) onNext()
    } catch (error) {
      const message = error instanceof AbeiApiError || error instanceof Error ? error.message : '保存失败，请重试'
      showToast({ kind: 'error', message, duration: 6000 })
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <span className="flex-1 text-[11px] font-medium tracking-wide text-[var(--text-secondary)] uppercase">
          单笔详情
        </span>
        <Button variant="ghost" size="xs" onClick={onPrev} aria-label="上一笔">
          <ArrowUp aria-hidden className="size-3.5" />
        </Button>
        <Button variant="ghost" size="xs" onClick={onNext} aria-label="下一笔">
          <ArrowDown aria-hidden className="size-3.5" />
        </Button>
        <Button variant="ghost" size="xs" onClick={onToggleSelect}>
          {selected ? '取消勾选' : '勾选'}
        </Button>
      </div>

      <div>
        <div className="text-[14px] font-semibold text-[var(--text-primary)]">{tx.description}</div>
        <div className={`num text-lg font-semibold ${semanticColorClass(semantic)}`}>
          {formatSignedAmount(tx.amount, semantic, tx.currency_symbol)}
        </div>
      </div>

      <dl className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-2.5 gap-y-1 text-[12.5px]">
        <dt className="text-[var(--text-secondary)]">日期</dt>
        <dd className="num m-0 text-[var(--text-primary)]">{formatDateLabel(tx.date.slice(0, 10))}</dd>
        <dt className="text-[var(--text-secondary)]">类型</dt>
        <dd className="m-0 text-[var(--text-primary)]">{TYPE_LABELS[tx.type] ?? tx.type}</dd>
        <dt className="text-[var(--text-secondary)]">来源</dt>
        <dd className="m-0 truncate text-[var(--text-primary)]">{tx.source_name || '未记录'}</dd>
        <dt className="text-[var(--text-secondary)]">去向</dt>
        <dd className="m-0 truncate text-[var(--text-primary)]">{tx.destination_name || '未记录'}</dd>
      </dl>

      <hr className="border-t border-[var(--border-subtle)]" />

      {quickEditable ? (
        <>
          <Field label="分类">
            <CategoryPicker value={category} onChange={setCategory} aria-label="分类" />
          </Field>
          <Field label="标签" hint="逗号分隔">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              className="flex-1"
              disabled={updateMutation.isPending}
              onClick={() => void save(true)}
            >
              {updateMutation.isPending ? '保存中…' : '保存并下一笔'}
            </Button>
            <Button variant="secondary" size="sm" disabled={updateMutation.isPending} onClick={() => void save(false)}>
              保存
            </Button>
          </div>
          <p className="num text-[11px] text-[var(--text-tertiary)]">↑↓ 选行 · Enter 打开 · 空格 勾选</p>
        </>
      ) : (
        <p className="text-[11.5px] text-[var(--text-secondary)]">
          {splitCount > 1
            ? `含 ${splitCount} 项明细，需在编辑表单中修改`
            : '该类型交易不支持在此修改'}
        </p>
      )}

      <div className="flex items-center gap-2">
        {editable && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openEdit(buildEditPayload(row.groupId, tx, splitCount))}
          >
            <PencilSimple aria-hidden className="size-4" />
            编辑交易
          </Button>
        )}
        <Button variant="ghost-danger" size="sm" className="ml-auto" onClick={onDelete} aria-label="删除这笔">
          <Trash aria-hidden className="size-4" />
        </Button>
      </div>
    </Card>
  )
}
