import { Modal } from './Modal'
import type { TransactionSplit } from '../../api/schemas'
import { toTransactionGroupView } from '../../lib/transactionGroup'
import { formatAmount } from '../../lib/format'

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
      <button
        type="button"
        disabled={pending}
        onClick={onClose}
        className="rounded-md bg-gray-100 px-3 py-1.5 text-[13px] text-gray-900 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
      >
        取消
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={onConfirm}
        className="rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-semibold text-white shadow-sm hover:bg-red-500 disabled:opacity-50"
      >
        {pending ? '移动中…' : '移入回收站'}
      </button>
    </>
  )

  return (
    <Modal open={open} onClose={onClose} title="移入回收站" width={400} footer={footer}>
      <p className="m-0 leading-relaxed text-gray-900 dark:text-gray-100">
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
