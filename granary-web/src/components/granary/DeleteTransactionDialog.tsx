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
        className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50"
        style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
      >
        取消
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={onConfirm}
        className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50"
        style={{
          background: 'var(--g-danger)',
          color: '#fff',
          fontWeight: 'var(--g-weight-demibold)',
        }}
      >
        {pending ? '移动中…' : '移入回收站'}
      </button>
    </>
  )

  return (
    <Modal open={open} onClose={onClose} title="移入回收站" width={400} footer={footer}>
      <p className="m-0 leading-relaxed" style={{ color: 'var(--g-ink)' }}>
        确定将整组交易「
        <span style={{ fontWeight: 'var(--g-weight-demibold)' }}>{first.description}</span>
        」移入回收站吗？
        {splits.length > 1 && <span>该组包含 {splits.length} 条拆分，</span>}
        合计 {group.totals.map((total) => `${total.currencySymbol || total.currencyCode || ''}${formatAmount(total.amount)}`).join('、')}。
        后续可在回收站中恢复。
      </p>
    </Modal>
  )
}
