import { Modal } from './Modal'
import type { TransactionSplit } from '../../api/schemas'
import { toTransactionGroupView } from '../../lib/transactionGroup'
import { formatAmount } from '../../lib/format'
import { Button } from '../ui/Button'

/**
 * 移入回收站确认框：正文展示描述和金额。
 */
export function DeleteTransactionDialog({
  open,
  splits,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean
  splits: TransactionSplit[]
  pending?: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const group = toTransactionGroupView({ id: 'pending-delete', attributes: { transactions: splits } })
  if (!group) return null
  const first = splits[0]

  const footer = (
    <>
      <Button variant="secondary" size="md" disabled={pending} onClick={onClose}>
        取消
      </Button>
      <Button variant="danger" size="md" disabled={pending} onClick={onConfirm}>
        {pending ? '移动中…' : '移入回收站'}
      </Button>
    </>
  )

  return (
    <Modal open={open} onClose={onClose} title="移入回收站" width={400} footer={footer}>
      <p className="m-0 leading-relaxed text-[var(--text-primary)] ">
        确定将整组交易「
        <span className="font-semibold">{first.description}</span>
        」移入回收站吗？
        {splits.length > 1 && <span>该组包含 {splits.length} 条拆分，</span>}
        合计 {group.totals.map((total) => `${total.currencySymbol || total.currencyCode || ''}${formatAmount(total.amount)}`).join('、')}。
        后续可在回收站中恢复。
      </p>
    </Modal>
  )
}
