import { ConfirmDialog } from './ConfirmDialog'
import type { TransactionSplit } from '../../api/schemas'
import { toTransactionGroupView } from '../../lib/transactionGroup'
import { formatAmount } from '../../lib/format'

/**
 * 移入回收站确认框：正文展示描述和金额。
 * 按钮、进行中禁用、点外面关不关这些都由 ConfirmDialog 定，这里只管把话说清楚。
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

  return (
    <ConfirmDialog
      open={open}
      title="移入回收站"
      confirmLabel="移入回收站"
      pendingLabel="移动中…"
      pending={pending}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <p className="m-0 leading-relaxed">
        确定将整组交易「
        <span className="font-semibold text-[var(--text-primary)]">{first.description}</span>
        」移入回收站吗？
        {splits.length > 1 && <span>该组包含 {splits.length} 条拆分，</span>}
        合计 {group.totals.map((total) => `${total.currencySymbol || total.currencyCode || ''}${formatAmount(total.amount)}`).join('、')}。
        后续可在回收站中恢复。
      </p>
    </ConfirmDialog>
  )
}
