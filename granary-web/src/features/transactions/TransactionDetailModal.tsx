import { PencilIcon } from '@heroicons/react/20/solid'
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
          <button type="button" onClick={onClose} className="rounded-md bg-gray-100 px-3 py-1.5 text-[13px] text-gray-900 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700">
            关闭
          </button>
          {editable && (
            <button type="button" onClick={edit} className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-semibold text-white shadow-sm hover:bg-indigo-500">
              <PencilIcon aria-hidden className="size-3.5" />
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
        <div className="py-6 text-center text-gray-500 dark:text-gray-400">交易不存在或没有可显示的明细</div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4 border-b border-gray-200 pb-3 dark:border-gray-700">
            <div className="min-w-0">
              <div className="text-[11px] text-gray-500 dark:text-gray-400">{TYPE_LABELS[first.type] ?? first.type} · #{groupId}</div>
              <div className="mt-1 text-base font-semibold text-gray-900 dark:text-gray-100">{group?.attributes.group_title || first.description}</div>
              <div className="mt-1 text-[11.5px] text-gray-500 dark:text-gray-400">{formatDateTime(first.date)}</div>
            </div>
            <div className={`shrink-0 text-right font-mono text-[17px] ${first.type === 'withdrawal' ? 'text-red-600 dark:text-red-400' : first.type === 'deposit' ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-900 dark:text-gray-100'}`}>
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
            <div className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">明细{view.splits.length > 1 ? ` · ${view.splits.length} 项` : ''}</div>
            <div className="border-y border-gray-200 dark:border-gray-700">
              {view.splits.map((split, index) => (
                <div key={String(split.transaction_journal_id ?? index)} className="flex items-start justify-between gap-3 border-b border-gray-200 py-2.5 last:border-b-0 dark:border-gray-700">
                  <div className="min-w-0">
                    <div className="font-semibold text-gray-900 dark:text-gray-100">{split.description}</div>
                    <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                      {[split.category_name, `${split.source_name || '?'} → ${split.destination_name || '?'}`].filter(Boolean).join(' · ')}
                    </div>
                    {split.notes && <div className="mt-1 text-[11.5px] leading-relaxed text-gray-500 dark:text-gray-400">{split.notes}</div>}
                  </div>
                  <div className="shrink-0 font-mono text-gray-900 dark:text-gray-100">{formatSignedAmount(split.amount, split.type, split.currency_symbol)}</div>
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
  return <div><div className="text-[10.5px] text-gray-500 dark:text-gray-400">{label}</div><div className="mt-0.5 truncate text-gray-900 dark:text-gray-100">{children}</div></div>
}
