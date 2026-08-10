import { useMemo } from 'react'
import type { BillImportResponse } from '../../api/schemas'
import { Modal } from '../../components/abei/Modal'
import { formatAmount } from '../../lib/format'
import { Button } from '../../components/ui/Button'

/**
 * 一次入账很多笔时的干跑确认（≤20 笔直接执行 + 撤销，见设计稿 02 §4）。
 * 队列改成跨任务之后这里不再绑定单个任务，标题由调用方给。
 */
export function ImportConfirmDialog({
  open,
  title,
  dryRun,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean
  title: string
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
      title={title}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onCancel}>
            先不入账
          </Button>
          <Button variant="primary" size="md" disabled={willImport.length === 0 || pending} onClick={onConfirm}>
            {pending ? '入账中…' : `确认入账 ${willImport.length} 笔`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p>
          选中 <span className="num">{dryRun.summary.total}</span> 笔 → 将入账{' '}
          <span className="num text-[var(--done)]">{willImport.length}</span> 笔，跳过{' '}
          <span
            className={`num ${trueSkips.length > 0 ? 'text-[var(--attention)]' : 'text-[var(--text-secondary)]'}`}
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
                <span className="num text-[var(--text-secondary)]">× {count}</span>
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
                <span className="shrink-0 num text-[var(--text-secondary)]">
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
