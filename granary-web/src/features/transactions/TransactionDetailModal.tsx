import { Pencil } from 'lucide-react'
import { useTransaction } from '../../api/queries'
import { ErrorState } from '../../components/granary/ErrorState'
import { Modal } from '../../components/granary/Modal'
import { Skeleton } from '../../components/granary/Skeleton'
import { formatDateTime, formatSignedAmount } from '../../lib/format'
import { hasReconciledTransactionSplit, toTransactionGroupView } from '../../lib/transactionGroup'
import { useRecordTxStore } from '../../store/recordTxStore'
import { buildEditPayload, isEditableTransactionGroup } from '../record-transaction/editPayload'

const TYPE_LABELS: Record<string, string> = {
  withdrawal: '支出',
  deposit: '收入',
  transfer: '转账',
  reconciliation: '对账调整',
  'opening balance': '期初余额',
}

export function TransactionDetailModal({ groupId, onClose }: { groupId: string | null; onClose: () => void }) {
  const query = useTransaction(groupId)
  const openEdit = useRecordTxStore((state) => state.openEdit)
  const group = query.data?.data
  const view = group ? toTransactionGroupView(group) : null
  const first = view?.splits[0]
  const editable = !!first && isEditableTransactionGroup(first.type, hasReconciledTransactionSplit(view.splits))

  function edit() {
    if (!groupId || !view || !first || !editable) return
    onClose()
    openEdit(buildEditPayload(groupId, first, view.splits.length))
  }

  return (
    <Modal
      open={groupId != null}
      onClose={onClose}
      title="交易详情"
      width={560}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-[6px] px-3 py-1.5 text-[12.5px]" style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}>
            关闭
          </button>
          {editable && (
            <button type="button" onClick={edit} className="flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12.5px]" style={{ background: 'var(--g-accent)', color: 'var(--g-accent-ink)', fontWeight: 'var(--g-weight-demibold)' }}>
              <Pencil size={13} />
              编辑交易
            </button>
          )}
        </>
      }
    >
      {query.isLoading ? (
        <div className="flex flex-col gap-3"><Skeleton className="h-16" /><Skeleton className="h-24" /></div>
      ) : query.isError ? (
        <ErrorState message="交易详情加载失败" onRetry={() => void query.refetch()} />
      ) : !view || !first ? (
        <div className="py-6 text-center" style={{ color: 'var(--g-ink-2)' }}>交易不存在或没有可显示的明细</div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4 border-b pb-3" style={{ borderColor: 'var(--g-border)' }}>
            <div className="min-w-0">
              <div className="text-[11px]" style={{ color: 'var(--g-ink-2)' }}>{TYPE_LABELS[first.type] ?? first.type} · #{groupId}</div>
              <div className="mt-1 text-[16px]" style={{ fontWeight: 'var(--g-weight-demibold)' }}>{group?.attributes.group_title || first.description}</div>
              <div className="mt-1 text-[11.5px]" style={{ color: 'var(--g-ink-2)' }}>{formatDateTime(first.date)}</div>
            </div>
            <div className="font-num shrink-0 text-right text-[17px]" style={{ color: first.type === 'withdrawal' ? 'var(--g-expense)' : first.type === 'deposit' ? 'var(--g-income)' : 'var(--g-ink)' }}>
              {view.totals.map((total) => <div key={total.currencyCode || total.currencySymbol}>{formatSignedAmount(total.amount, first.type, total.currencySymbol)}</div>)}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-5 gap-y-3 text-[12px]">
            <Detail label="来源">{first.source_name || '未记录'}</Detail>
            <Detail label="去向">{first.destination_name || '未记录'}</Detail>
            <Detail label="分类">{first.category_name || '未分类'}</Detail>
            <Detail label="标签">{first.tags?.length ? first.tags.join('、') : '无'}</Detail>
          </div>

          <div>
            <div className="mb-1 text-[11px]" style={{ color: 'var(--g-ink-2)' }}>明细{view.splits.length > 1 ? ` · ${view.splits.length} 项` : ''}</div>
            <div className="border-y" style={{ borderColor: 'var(--g-border)' }}>
              {view.splits.map((split, index) => (
                <div key={String(split.transaction_journal_id ?? index)} className="flex items-start justify-between gap-3 border-b py-2.5 last:border-b-0" style={{ borderColor: 'var(--g-border)' }}>
                  <div className="min-w-0">
                    <div style={{ fontWeight: 'var(--g-weight-demibold)' }}>{split.description}</div>
                    <div className="mt-0.5 text-[11px]" style={{ color: 'var(--g-ink-2)' }}>
                      {[split.category_name, `${split.source_name || '?'} → ${split.destination_name || '?'}`].filter(Boolean).join(' · ')}
                    </div>
                    {split.notes && <div className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--g-ink-2)' }}>{split.notes}</div>}
                  </div>
                  <div className="font-num shrink-0">{formatSignedAmount(split.amount, split.type, split.currency_symbol)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Detail({ label, children }: { label: string; children: string }) {
  return <div><div className="text-[10.5px]" style={{ color: 'var(--g-ink-2)' }}>{label}</div><div className="mt-0.5 truncate">{children}</div></div>
}
