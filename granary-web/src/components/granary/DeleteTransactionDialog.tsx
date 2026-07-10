import { Modal } from './Modal'
import { MoneyText } from './MoneyText'
import type { TransactionSplit } from '../../api/schemas'

/**
 * 删除交易确认框（规范 §5）：正文展示描述+金额，确认按钮 `--g-danger` 底色。
 */
export function DeleteTransactionDialog({
  open,
  tx,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean
  tx: TransactionSplit | null
  pending?: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  if (!tx) return null

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
        确定删除「
        <span style={{ fontWeight: 'var(--g-weight-demibold)' }}>{tx.description}</span>
        」
        <span className="mx-1 inline-block align-middle">
          <MoneyText value={tx.amount} kind={tx.type} symbol={tx.currency_symbol} />
        </span>
        吗？此操作不可撤销。
      </p>
    </Modal>
  )
}
