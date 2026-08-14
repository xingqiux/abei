import { useState } from 'react'
import { DownloadSimple } from '@phosphor-icons/react'
import { downloadBillArtifact } from '../../api/firefly'
import { useBillTaskArtifacts, useBillTaskEvents } from '../../api/queries'
import { AbeiApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import type { BillRowTaskRef } from '../../api/schemas'
import { formatDateTime } from '../../lib/format'
import { IconButton } from '../../components/ui/Button'
import { InlineError } from '../../components/abei/ErrorState'
import { SOURCE_FALLBACK_LABELS } from './billInboxHelpers'
import { eventLabel } from './RowTimeline'

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

/**
 * 来源凭证（三级披露的最后一层）：这条流水是从哪封邮件来的、处理过程发生了什么、
 * 中间产物在哪。
 *
 * 原先这块挂在任务上，因为界面本来就是按任务组织的。队列改成按流水组织之后，
 * 它跟着行走：人展开一行想问的是「这条哪来的」，不是「这个任务干了啥」。
 * 判重理由和 AI 建议已经在二级详情里按行给了，所以这里不再重复任务级复核汇总。
 */
export function TaskEvidencePanel({ task }: { task: BillRowTaskRef }) {
  const artifacts = useBillTaskArtifacts(task.id)
  const events = useBillTaskEvents(task.id)
  const hasError = artifacts.isError || events.isError
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
        message: error instanceof AbeiApiError ? error.message : '产物下载失败',
        duration: 6000,
      })
    } finally {
      setDownloadingId(null)
    }
  }

  const channel = SOURCE_FALLBACK_LABELS[task.source] ?? task.source

  return (
    <div className="grid grid-cols-1 gap-3 rounded-md bg-[var(--surface-2)] p-3 lg:grid-cols-3">
      <section className="min-w-0">
        <h4 className="mb-2 text-[11px] font-medium text-[var(--text-tertiary)] uppercase">邮件</h4>
        <dl className="flex flex-col gap-1 text-[11.5px] leading-relaxed">
          <div className="flex gap-2">
            <dt className="shrink-0 text-[var(--text-secondary)]">主题</dt>
            <dd className="min-w-0 flex-1 text-[var(--text-primary)]">{task.summary || '（无主题）'}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-[var(--text-secondary)]">渠道</dt>
            <dd className="min-w-0 flex-1 text-[var(--text-primary)]">{channel}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-[var(--text-secondary)]">收到</dt>
            <dd className="num min-w-0 flex-1 text-[var(--text-primary)]">
              {task.received_at ? formatDateTime(task.received_at) : '--'}
            </dd>
          </div>
        </dl>
      </section>

      <section className="min-w-0">
        <h4 className="mb-2 text-[11px] font-medium text-[var(--text-tertiary)] uppercase">产物</h4>
        <div className="flex flex-col gap-1">
          {(artifacts.data?.data ?? []).map((artifact) => (
            <div key={artifact.id} className="flex items-start justify-between gap-2 text-xs">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[var(--text-primary)]">{artifact.attributes.filename ?? `${artifact.attributes.kind}-${artifact.id}`}</div>
                <div className="truncate text-[10.5px] text-[var(--text-secondary)]">{artifact.attributes.mime_type} · {formatBytes(artifact.attributes.size)} · {STAGE_LABELS[artifact.attributes.generation_stage]}{artifact.attributes.encrypted ? ' · 已加密' : ''}</div>
              </div>
              <IconButton
                label={`下载 ${artifact.attributes.filename ?? artifact.id}`}
                variant="soft"
                className="size-6"
                disabled={downloadingId !== null}
                onClick={() => void download(artifact.id, artifact.attributes.filename ?? `artifact-${artifact.id}`)}
              >
                <DownloadSimple aria-hidden className="size-3.5" />
              </IconButton>
            </div>
          ))}
          {artifacts.isSuccess && artifacts.data.data.length === 0 && <span className="text-xs text-[var(--text-secondary)]">无可下载产物</span>}
        </div>
      </section>

      <section className="min-w-0">
        <h4 className="mb-2 text-[11px] font-medium text-[var(--text-tertiary)] uppercase">事件</h4>
        <div className="flex max-h-[140px] flex-col gap-1 overflow-y-auto">
          {(events.data?.data ?? []).map((event) => (
            <div key={event.id} className="text-xs leading-relaxed">
              <span className="num text-[var(--text-secondary)]">{event.attributes.created_at ? formatDateTime(event.attributes.created_at) : '--'}</span>{' '}
              <span className="text-[var(--text-primary)]">{eventLabel(event.attributes.event_type)}</span>
              {event.attributes.message && <span className="text-[var(--text-secondary)]"> · {event.attributes.message}</span>}
            </div>
          ))}
          {events.isSuccess && events.data.data.length === 0 && <span className="text-xs text-[var(--text-secondary)]">暂无事件</span>}
        </div>
      </section>

      {hasError && (
        <div className="lg:col-span-3">
          <InlineError
            message="来源凭证加载不完整"
            error={artifacts.error ?? events.error}
            onRetry={() => { void artifacts.refetch(); void events.refetch() }}
          />
        </div>
      )}
    </div>
  )
}
