import { useMemo } from 'react'
import type { BillImportResponse, BillTask } from '../../api/schemas'
import { Modal } from '../../components/abaku/Modal'
import { formatAmount } from '../../lib/format'
import { Button } from '../../components/ui/Button'

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
          <Button variant="secondary" size="md" onClick={onCancel}>
            取消
          </Button>
          <Button variant="primary" size="md" disabled={willImport.length === 0 || pending} onClick={onConfirm}>
            {pending ? '入账中…' : `确认入账 ${willImport.length} 笔`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p>
          选中 <span className="font-mono tabular-nums">{dryRun.summary.total}</span> 笔 → 将入账{' '}
          <span className="font-mono tabular-nums text-[var(--done)]">{willImport.length}</span> 笔，跳过{' '}
          <span
            className={`font-mono tabular-nums ${trueSkips.length > 0 ? 'text-[var(--attention)]' : 'text-[var(--text-secondary)]'}`}
          >
            {trueSkips.length}
          </span>{' '}
          笔
        </p>

        {reasonGroups.length > 0 && (
          <div className="flex flex-col gap-1 rounded-md bg-[var(--surface-hover)] p-2">
            <div className="text-[11px] font-medium text-[var(--text-tertiary)] uppercase">跳过原因</div>
            {reasonGroups.map(([reason, count]) => (
              <div key={reason} className="flex items-center justify-between text-xs">
                <span className="text-[var(--text-primary)]">{reason}</span>
                <span className="font-mono tabular-nums text-[var(--text-secondary)]">× {count}</span>
              </div>
            ))}
          </div>
        )}

        {willImport.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="text-[11px] font-medium text-[var(--text-tertiary)] uppercase">将入账（预览前 5 条）</div>
            {willImport.slice(0, 5).map((r) => (
              <div key={r.row_id} className="flex items-center justify-between gap-2 text-xs text-[var(--text-primary)]">
                <span className="min-w-0 flex-1 truncate">{r.description_preview ?? r.counterparty ?? '--'}</span>
                <span className="shrink-0 font-mono tabular-nums text-[var(--text-secondary)]">
                  {r.currency_symbol ?? r.currency_code ?? ''}{formatAmount(r.firefly_amount ?? r.amount ?? 0)}
                </span>
              </div>
            ))}
            {willImport.length > 5 && (
              <div className="text-[11px] text-[var(--text-secondary)]">以及其余 {willImport.length - 5} 笔…</div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
