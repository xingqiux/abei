import { Modal } from './Modal'
import type { TransactionSplit } from '../../api/schemas'
import { toTransactionGroupView } from '../../lib/transactionGroup'
import { formatAmount } from '../../lib/format'

/**
 * 删除交易确认框（规范 §5）：正文展示描述+金额，确认按钮 `--g-danger` 底色。
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
        {pending ? '删除中…' : '确认删除'}
      </button>
    </>
  )

  return (
    <Modal open={open} onClose={onClose} title="删除交易" width={400} footer={footer}>
      <p className="m-0 leading-relaxed" style={{ color: 'var(--g-ink)' }}>
        确定删除整组交易「
        <span style={{ fontWeight: 'var(--g-weight-demibold)' }}>{first.description}</span>
        」吗？
        {splits.length > 1 && <span>该组包含 {splits.length} 条拆分，</span>}
        合计 {group.totals.map((total) => `${total.currencySymbol || total.currencyCode || ''}${formatAmount(total.amount)}`).join('、')}。
        此操作不可撤销。
      </p>
    </Modal>
  )
}
