import { useEffect, useMemo, useState } from 'react'
import type { BillImportResponse, BillTask } from '../../api/schemas'
import {
  useBillTaskRows,
  useImportBillTaskRows,
  useRetryBillTask,
  useSubmitBillTaskSecret,
} from '../../api/queries'
import { EmptyState } from '../../components/abaku/EmptyState'
import { InlineError } from '../../components/abaku/ErrorState'
import { Skeleton } from '../../components/abaku/Skeleton'
import { Button } from '../../components/ui/Button'
import { Field, Input } from '../../components/ui/Field'
import { showToast } from '../../store/toastStore'
import { isRowSelectable } from './billInboxHelpers'
import { ImportConfirmDialog } from './ImportConfirmDialog'
import { IgnoreConfirmDialog } from './IgnoreConfirmDialog'
import { FireflyApiError } from '../../api/client'
import { LottieIcon } from '../../components/abaku/LottieIcon'
import { StatementRow } from './StatementRow'
import { TaskEvidencePanel } from './TaskEvidencePanel'

const PAGE_SIZE = 50

export function TaskDetailPanel({ task, onIgnored }: { task: BillTask; onIgnored: () => void }) {
  const status = task.attributes.status
  const isNeedsSecret = status === 'needs_secret'
  const isFailed = status === 'failed' || status === 'unknown'
  const rowsQuery = useBillTaskRows(isNeedsSecret || isFailed ? null : task.id)
  const rows = useMemo(() => rowsQuery.data?.data ?? [], [rowsQuery.data])

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [dryRun, setDryRun] = useState<BillImportResponse | null>(null)
  const [previewRowIds, setPreviewRowIds] = useState<string[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [ignoreOpen, setIgnoreOpen] = useState(false)
  const [secretValue, setSecretValue] = useState('')

  const eligibleIds = useMemo(() => rows.filter(isRowSelectable).map((r) => r.id), [rows])

  useEffect(() => {
    setSelected(new Set(eligibleIds))
    setVisibleCount(PAGE_SIZE)
    setSecretValue('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsQuery.data, task.id])

  useEffect(() => {
    setDryRun(null)
    setPreviewRowIds([])
    setConfirmOpen(false)
  }, [task.id])

  const importMutation = useImportBillTaskRows()
  const secretMutation = useSubmitBillTaskSecret()
  const retryMutation = useRetryBillTask()

  const allEligibleSelected = eligibleIds.length > 0 && eligibleIds.every((id) => selected.has(id))
  const someEligibleSelected = eligibleIds.some((id) => selected.has(id))

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(allEligibleSelected ? new Set() : new Set(eligibleIds))
  }

  async function handleImportClick() {
    if (selected.size === 0) return
    try {
      const res = await importMutation.mutateAsync({
        taskId: task.id,
        rowIds: Array.from(selected),
        confirm: false,
      })
      setPreviewRowIds(res.rows.filter((row) => row.action === 'would_import').map((row) => row.row_id))
      setDryRun(res)
      setConfirmOpen(true)
    } catch {
      showToast({ message: '干跑请求失败，请重试', kind: 'error' })
    }
  }

  async function handleConfirmImport() {
    if (previewRowIds.length === 0) return
    try {
      const res = await importMutation.mutateAsync({
        taskId: task.id,
        rowIds: previewRowIds,
        confirm: true,
      })
      setConfirmOpen(false)
      setDryRun(null)
      setPreviewRowIds([])
      showToast({ message: `已入账 ${res.summary.imported} 笔`, kind: 'success' })
    } catch {
      showToast({ message: '入账失败，请重试', kind: 'error' })
    }
  }

  async function handleSubmitSecret() {
    const value = secretValue.trim()
    if (!value) {
      showToast({ message: '请输入密码或验证码', kind: 'error' })
      return
    }
    try {
      await secretMutation.mutateAsync({ taskId: task.id, value })
      setSecretValue('')
      showToast({ message: '验证码已提交，任务将继续处理', kind: 'success' })
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '提交失败，请重试'
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

  async function handleRetry() {
    try {
      await retryMutation.mutateAsync(task.id)
      showToast({ message: '已重新排队处理', kind: 'success' })
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '重试失败，请重试'
      showToast({ message, kind: 'error', duration: 6000 })
    }
  }

  const visibleRows = rows.slice(0, visibleCount)
  const canLoadMore = visibleCount < rows.length
  const errorText = task.attributes.error_message || task.attributes.error_code || null
  // 密码错了后端退回 needs_secret，把原因（含还能试几次）写在 error_message 上。
  // 光靠 toast 不够：它几秒就没了，刷新一下就再也看不出自己错在哪。
  const secretError = task.attributes.error_code === 'secret_rejected' ? errorText : null

  function focusReviewRow(rowId: string) {
    setVisibleCount(rows.length)
    requestAnimationFrame(() => {
      const element = document.getElementById(`bill-row-${rowId}`)
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      element?.querySelector<HTMLButtonElement>('[aria-label="编辑行"]')?.focus()
    })
  }

  return (
    <div className="mx-2 mb-1 flex flex-col gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-3">
      {/* needs_secret：行内密码/验证码表单 */}
      {isNeedsSecret && (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void handleSubmitSecret()
            }}
          >
            <div className="min-w-[180px] flex-1">
              {/* 用真 label 而不是 placeholder：placeholder 一输入就消失，
                  用户回头看不出这格填的是什么 */}
              <Field label="需要解压密码或验证码" hint="提交后任务将重新处理附件" error={secretError ?? undefined}>
                <Input type="password" autoComplete="off" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} />
              </Field>
            </div>
            <Button type="submit" variant="primary" size="md" disabled={secretMutation.isPending || !secretValue.trim()}>
              {secretMutation.isPending ? (
                <>
                  <LottieIcon kind="loading" size={14} color="var(--brand-on)" />
                  提交中…
                </>
              ) : (
                '提交'
              )}
            </Button>
          </form>
        </div>
      )}

      {/* failed / unknown：错误信息 + 重试 */}
      {isFailed && (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3">
          <div className="text-sm font-semibold text-[var(--danger)]">处理失败</div>
          {errorText && (
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{errorText}</p>
          )}
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" disabled={retryMutation.isPending} onClick={() => void handleRetry()}>
              {retryMutation.isPending ? (
                <>
                  <LottieIcon kind="loading" size={14} color="var(--brand-on)" />
                  重试中…
                </>
              ) : (
                '重试'
              )}
            </Button>
            <Button variant="ghost-danger" size="sm" onClick={() => setIgnoreOpen(true)}>
              忽略此任务
            </Button>
          </div>
        </div>
      )}

      {/* 可审阅行列表（parsed 等） */}
      {!isNeedsSecret && !isFailed && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-[var(--text-secondary)]">
              已选 <span className="font-mono tabular-nums text-[var(--text-primary)]">{selected.size}</span> / 可入账{' '}
              {eligibleIds.length} 笔
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost-danger" size="sm" onClick={() => setIgnoreOpen(true)}>
                忽略此任务
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={selected.size === 0 || importMutation.isPending}
                onClick={() => void handleImportClick()}
              >
                {importMutation.isPending ? '处理中…' : `入账 ${selected.size} 笔`}
              </Button>
            </div>
          </div>

          {rowsQuery.isLoading ? (
            <div className="flex flex-col gap-1" role="status" aria-label="账单流水加载中">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : rowsQuery.isError ? (
            <InlineError message="账单流水加载失败" onRetry={() => void rowsQuery.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState statusIcon="inbox" message="该任务没有待处理的流水" />
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[720px]">
                <div className="flex h-7 items-center gap-2 border-b border-[var(--border-subtle)] px-2 text-[11px] text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    aria-label="全选可入账行"
                    checked={allEligibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allEligibleSelected && someEligibleSelected
                    }}
                    onChange={toggleAll}
                    className="shrink-0"
                  />
                  <span className="w-[48px] shrink-0">日期</span>
                  <span className="min-w-0 flex-1">描述</span>
                  <span className="w-[80px] shrink-0">分类</span>
                  <span className="w-[180px] shrink-0">账户流向</span>
                  <span className="w-[110px] shrink-0 text-right">金额</span>
                  <span className="w-[64px] shrink-0 text-right">状态</span>
                </div>

                <div className="flex flex-col">
                  {visibleRows.map((row) => (
                    <StatementRow
                      key={row.id}
                      row={row}
                      selected={selected.has(row.id)}
                      onToggle={() => toggleRow(row.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {canLoadMore && (
            <div className="flex justify-center pt-1">
              <Button variant="secondary" size="sm" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
                加载更多（{rows.length - visibleCount} 条剩余）
              </Button>
            </div>
          )}
        </>
      )}

      <TaskEvidencePanel taskId={task.id} onReviewRow={focusReviewRow} />

      <ImportConfirmDialog
        open={confirmOpen}
        task={task}
        dryRun={dryRun}
        pending={importMutation.isPending}
        onCancel={() => {
          setConfirmOpen(false)
          setDryRun(null)
          setPreviewRowIds([])
        }}
        onConfirm={handleConfirmImport}
      />

      <IgnoreConfirmDialog
        open={ignoreOpen}
        task={task}
        onCancel={() => setIgnoreOpen(false)}
        onIgnored={() => {
          setIgnoreOpen(false)
          onIgnored()
        }}
      />
    </div>
  )
}
