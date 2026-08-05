import { useState } from 'react'
import { ArrowDownTrayIcon, MapPinIcon } from '@heroicons/react/24/outline'
import { downloadBillArtifact } from '../../api/firefly'
import { useBillTaskArtifacts, useBillTaskEvents, useBillTaskReview } from '../../api/queries'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import type { BillTaskReview } from '../../api/schemas'
import { formatAmount, formatDateTime } from '../../lib/format'

type ReviewCandidate = BillTaskReview['conflict_candidates'][number]

const STAGE_LABELS = {
  received: '已接收',
  downloaded: '已下载',
  extracted: '已解压',
  derived: '已派生',
} as const

function formatBytes(size: number | null): string {
  if (size === null) return '大小未知'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function TaskEvidencePanel({ taskId, onReviewRow }: { taskId: string; onReviewRow: (rowId: string) => void }) {
  const artifacts = useBillTaskArtifacts(taskId)
  const events = useBillTaskEvents(taskId)
  const review = useBillTaskReview(taskId)
  const hasError = artifacts.isError || events.isError || review.isError
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  async function download(id: string, fallbackName: string) {
    if (downloadingId) return
    setDownloadingId(id)
    try {
      const result = await downloadBillArtifact(id)
      const url = URL.createObjectURL(result.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = result.filename || fallbackName
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof FireflyApiError ? error.message : '产物下载失败',
        duration: 6000,
      })
    } finally {
      setDownloadingId(null)
    }
  }

  const candidateCounts = review.data
    ? [
        ['新增', review.data.new_candidates.length],
        ['跳过', review.data.skip_candidates.length],
        ['冲突', review.data.conflict_candidates.length],
        ['跨来源重复', review.data.cross_source_candidates.length],
        ['需备注', review.data.needs_user_note.length],
        ['疑似转账', review.data.transfer_candidates.length],
      ] as const
    : []
  const issueGroups: Array<{ label: string; items: ReviewCandidate[] }> = review.data ? [
    { label: '冲突', items: review.data.conflict_candidates },
    { label: '跨来源重复', items: review.data.cross_source_candidates },
    { label: '需备注', items: review.data.needs_user_note },
    { label: '疑似转账', items: review.data.transfer_candidates },
    { label: '建议跳过', items: review.data.skip_candidates },
  ].filter((group) => group.items.length > 0) : []

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <section className="min-w-0">
        <h3 className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">REVIEW</h3>
        <div className="flex flex-wrap gap-1.5">
          {candidateCounts.map(([label, count]) => (
            <span key={label} className="rounded-[4px] px-1.5 py-1 text-[11.5px]" style={{ background: 'light-dark(var(--color-gray-100), var(--color-gray-700))', color: count > 0 ? 'light-dark(var(--color-gray-900), var(--color-gray-100))' : 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}>
              {label} <span className="font-mono tabular-nums">{count}</span>
            </span>
          ))}
          {review.isLoading && <span className="text-[11.5px] text-gray-500 dark:text-gray-400">加载中…</span>}
        </div>
        <div className="mt-2 flex max-h-[190px] flex-col gap-1 overflow-y-auto">
          {issueGroups.flatMap((group) => group.items.map((candidate) => (
            <div key={`${group.label}-${candidate.row_id}`} className="flex items-start gap-1.5 rounded-[4px] px-1.5 py-1" style={{ background: 'light-dark(var(--color-gray-100), var(--color-gray-700))' }}>
              <div className="min-w-0 flex-1 text-[11px] leading-relaxed">
                <div className="truncate text-gray-900 dark:text-gray-100">
                  {group.label} · #{candidate.row_number ?? candidate.row_id} · {candidate.description_preview || candidate.counterparty || '未命名流水'}
                </div>
                <div style={{ color: 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}>
                  {candidate.reason ?? '需要人工复核'}
                  {(candidate.firefly_amount || candidate.amount) && ` · ${candidate.currency_symbol || candidate.currency_code || ''}${formatAmount(candidate.firefly_amount || candidate.amount || '0')}`}
                </div>
              </div>
              <button type="button" title="定位并修复流水" aria-label={`定位流水 ${candidate.row_id}`} onClick={() => onReviewRow(candidate.row_id)} className="shrink-0 rounded p-1 text-indigo-600 dark:text-indigo-400"><MapPinIcon aria-hidden className="size-3" /></button>
            </div>
          )))}
          {review.isSuccess && issueGroups.length === 0 && <span className="text-[11px] text-gray-500 dark:text-gray-400">没有需要人工修复的问题</span>}
        </div>
      </section>

      <section className="min-w-0">
        <h3 className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">产物</h3>
        <div className="flex flex-col gap-1">
          {(artifacts.data?.data ?? []).map((artifact) => (
            <div key={artifact.id} className="flex items-start justify-between gap-2 text-[11.5px]">
              <div className="min-w-0 flex-1">
                <div className="truncate text-gray-900 dark:text-gray-100">{artifact.attributes.filename ?? `${artifact.attributes.kind}-${artifact.id}`}</div>
                <div className="truncate text-[10.5px] text-gray-500 dark:text-gray-400">{artifact.attributes.mime_type} · {formatBytes(artifact.attributes.size)} · {STAGE_LABELS[artifact.attributes.generation_stage]}{artifact.attributes.encrypted ? ' · 已加密' : ''}</div>
              </div>
              <button type="button" disabled={downloadingId !== null} title="下载产物" aria-label={`下载 ${artifact.attributes.filename ?? artifact.id}`} onClick={() => void download(artifact.id, artifact.attributes.filename ?? `artifact-${artifact.id}`)} className="shrink-0 rounded p-1 disabled:opacity-40 text-indigo-600 dark:text-indigo-400">
                <ArrowDownTrayIcon aria-hidden className="size-3.5" />
              </button>
            </div>
          ))}
          {artifacts.isSuccess && artifacts.data.data.length === 0 && <span className="text-[11.5px] text-gray-500 dark:text-gray-400">无可下载产物</span>}
        </div>
      </section>

      <section className="min-w-0">
        <h3 className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">事件</h3>
        <div className="flex max-h-[140px] flex-col gap-1 overflow-y-auto">
          {(events.data?.data ?? []).map((event) => (
            <div key={event.id} className="text-[11.5px] leading-relaxed">
              <span className="font-mono tabular-nums text-gray-500 dark:text-gray-400">{event.attributes.created_at ? formatDateTime(event.attributes.created_at) : '--'}</span>{' '}
              <span style={{ color: 'light-dark(var(--color-gray-900), var(--color-gray-100))' }}>{event.attributes.event_type}</span>
              {event.attributes.message && <span style={{ color: 'light-dark(var(--color-gray-500), var(--color-gray-400))' }}> · {event.attributes.message}</span>}
            </div>
          ))}
          {events.isSuccess && events.data.data.length === 0 && <span className="text-[11.5px] text-gray-500 dark:text-gray-400">暂无事件</span>}
        </div>
      </section>

      {hasError && (
        <div className="lg:col-span-3 flex items-center justify-between text-[11.5px] text-red-600 dark:text-red-400">
          <span>任务附加信息加载不完整</span>
          <button type="button" onClick={() => { void artifacts.refetch(); void events.refetch(); void review.refetch() }} style={{ color: 'light-dark(var(--color-indigo-600), var(--color-indigo-500))' }}>重试</button>
        </div>
      )}
    </div>
  )
}
