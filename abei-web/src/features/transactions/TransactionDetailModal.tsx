import { PencilSimple } from '@phosphor-icons/react'
import { useTransaction } from '../../api/queries'
import { ErrorState } from '../../components/abei/ErrorState'
import { Modal } from '../../components/abei/Modal'
import { Skeleton } from '../../components/abei/Skeleton'
import { formatDateTime, formatSignedAmount, semanticColorClass, semanticOf } from '../../lib/format'
import { hasReconciledTransactionSplit, toTransactionGroupView } from '../../lib/transactionGroup'
import { useRecordTxStore } from '../../store/recordTxStore'
import { buildEditPayload, isEditableTransactionGroup } from '../record-transaction/editPayload'
import { Button } from '../../components/ui/Button'

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
          <Button variant="secondary" size="md" onClick={onClose}>
            关闭
          </Button>
          {editable && (
            <Button variant="primary" size="md" onClick={edit}>
              <PencilSimple aria-hidden className="size-4" />
              编辑交易
            </Button>
          )}
        </>
      }
    >
      {query.isLoading ? (
        <div className="flex flex-col gap-3"><Skeleton className="h-16" /><Skeleton className="h-24" /></div>
      ) : query.isError ? (
        <ErrorState message="交易详情加载失败" error={query.error} onRetry={() => void query.refetch()} />
      ) : !view || !first ? (
        <div className="py-6 text-center text-[var(--text-secondary)] ">交易不存在或没有可显示的明细</div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] pb-3 ">
            <div className="min-w-0">
              <div className="text-[11px] text-[var(--text-secondary)] ">{TYPE_LABELS[first.type] ?? first.type} · #{groupId}</div>
              <div className="mt-1 text-base font-semibold text-[var(--text-primary)] ">{group?.attributes.group_title || first.description}</div>
              <div className="mt-1 text-[11.5px] text-[var(--text-secondary)] ">{formatDateTime(first.date)}</div>
            </div>
            <div className={`num shrink-0 text-right text-[17px] ${semanticColorClass(semanticOf(first.type))}`}>
              {view.totals.map((total) => <div key={total.currencyCode || total.currencySymbol}>{formatSignedAmount(total.amount, semanticOf(first.type), total.currencySymbol)}</div>)}
            </div>
          </div>

          {/* 键值对走 dl/dt/dd：读屏会把「来源」和它的值当成一对，而不是两段无关文字 */}
          <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-xs">
            <Detail label="来源">{first.source_name || '未记录'}</Detail>
            <Detail label="去向">{first.destination_name || '未记录'}</Detail>
            <Detail label="分类">{first.category_name || '未分类'}</Detail>
            <Detail label="标签">{first.tags?.length ? first.tags.join('、') : '无'}</Detail>
          </dl>

          <div>
            <div className="mb-1 text-[11px] font-medium text-[var(--text-tertiary)] uppercase">明细{view.splits.length > 1 ? ` · ${view.splits.length} 项` : ''}</div>
            <div className="border-y border-[var(--border-subtle)] ">
              {view.splits.map((split, index) => (
                <div key={String(split.transaction_journal_id ?? index)} className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] py-2.5 last:border-b-0 ">
                  <div className="min-w-0">
                    <div className="font-semibold text-[var(--text-primary)] ">{split.description}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--text-secondary)] ">
                      {[split.category_name, `${split.source_name || '?'} → ${split.destination_name || '?'}`].filter(Boolean).join(' · ')}
                    </div>
                    {split.notes && <div className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)] ">{split.notes}</div>}
                  </div>
                  <div className="num shrink-0 text-[var(--text-primary)]">{formatSignedAmount(split.amount, semanticOf(split.type), split.currency_symbol)}</div>
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
  return (
    <div>
      <dt className="text-[10.5px] text-[var(--text-tertiary)]">{label}</dt>
      <dd className="mt-0.5 truncate text-[var(--text-primary)]">{children}</dd>
    </div>
  )
}
