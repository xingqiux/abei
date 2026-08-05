import { useMemo } from 'react'
import type { BillImportResponse, BillTask } from '../../api/schemas'
import { Modal } from '../../components/abaku/Modal'
import { formatAmount } from '../../lib/format'

export function ImportConfirmDialog({
  open,
  task,
  dryRun,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean
  task: BillTask
  dryRun: BillImportResponse | null
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { willImport, trueSkips, reasonGroups } = useMemo(() => {
    const rows = dryRun?.rows ?? []
    const willImportRows = rows.filter((r) => r.action === 'would_import')
    const trueSkipRows = rows.filter((r) => r.action !== 'would_import')
    const groups = new Map<string, number>()
    for (const r of trueSkipRows) {
      const reason = r.error ?? '未知原因'
      groups.set(reason, (groups.get(reason) ?? 0) + 1)
    }
    return { willImport: willImportRows, trueSkips: trueSkipRows, reasonGroups: Array.from(groups.entries()) }
  }, [dryRun])

  if (!dryRun) return null

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={`确认入账 · ${task.attributes.summary ?? `任务 #${task.id}`}`}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[6px] px-3 py-1.5 text-[12.5px] bg-[var(--surface-hover)]  text-[var(--text-primary)] "

          >
            取消
          </button>
          <button
            type="button"
            disabled={willImport.length === 0 || pending}
            onClick={onConfirm}
            className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50 bg-[var(--brand)]  text-white font-semibold"

          >
            {pending ? '入账中…' : `确认入账 ${willImport.length} 笔`}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          选中 <span className="font-mono tabular-nums">{dryRun.summary.total}</span> 笔 → 将入账{' '}
          <span className="font-mono tabular-nums text-[var(--done)] ">
            {willImport.length}
          </span>{' '}
          笔，跳过{' '}
          <span className="font-mono tabular-nums" style={{ color: trueSkips.length > 0 ? 'var(--attention)' : 'var(--text-secondary)' }}>
            {trueSkips.length}
          </span>{' '}
          笔
        </div>

        {reasonGroups.length > 0 && (
          <div className="flex flex-col gap-1 rounded-[6px] p-2 bg-[var(--surface-hover)] ">
            <div className="text-[11px] text-[var(--text-secondary)] ">
              跳过原因
            </div>
            {reasonGroups.map(([reason, count]) => (
              <div key={reason} className="flex items-center justify-between text-[12px]">
                <span style={{ color: 'var(--text-primary)' }}>{reason}</span>
                <span className="font-mono tabular-nums text-[var(--text-secondary)] ">
                  × {count}
                </span>
              </div>
            ))}
          </div>
        )}

        {willImport.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="text-[11px] text-[var(--text-secondary)] ">
              将入账（预览前 5 条）
            </div>
            {willImport.slice(0, 5).map((r) => (
              <div key={r.row_id} className="flex items-center justify-between gap-2 text-[12px] text-[var(--text-primary)] ">
                <span className="min-w-0 flex-1 truncate">{r.description_preview ?? r.counterparty ?? '--'}</span>
                <span className="font-mono tabular-nums shrink-0 text-[var(--text-secondary)] ">
                  {r.currency_symbol ?? r.currency_code ?? ''}{formatAmount(r.firefly_amount ?? r.amount ?? 0)}
                </span>
              </div>
            ))}
            {willImport.length > 5 && (
              <div className="text-[11px] text-[var(--text-secondary)] ">
                以及其余 {willImport.length - 5} 笔…
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
