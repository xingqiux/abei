import { useState } from 'react'
import { ArrowClockwise, CaretDown, CaretRight, WarningCircle } from '@phosphor-icons/react'
import { useBillProcessingSummary, useRetryParseJob } from '../../api/queries'
import type { BillProcessingStuckJob, BillProcessingSummary } from '../../api/schemas'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { showToast } from '../../store/toastStore'
import { channelDisplayName } from './billInboxHelpers'

/**
 * 「这一批邮件到底怎么样了」。
 *
 * 收件箱本身只答得出「现在还剩多少行」。一封邮件没解析出来时，它在这一页上
 * 什么都不留——用户只会在月底发现某笔账没进来，然后回邮件里一封封翻。
 * 这张卡片就是补这个：收了多少信、成了几封、卡住的是哪几封、为什么、以及重试。
 */

/** 一句话汇总。数字都摆在卡片上，这句只说结论。 */
export function summarySentence(summary: BillProcessingSummary): string {
  const { mail, parse, rows } = summary
  if (mail.runs === 0 && parse.total === 0) {
    return `最近 ${summary.window_days} 天没有收到新邮件。`
  }
  const parts = [`收到 ${parse.total} 封账单邮件`]
  if (parse.succeeded > 0) parts.push(`解析成功 ${parse.succeeded} 封`)
  if (parse.running > 0) parts.push(`还在解析 ${parse.running} 封`)
  if (parse.waiting_input > 0) parts.push(`${parse.waiting_input} 封在等账单密码`)
  if (parse.failed > 0) parts.push(`${parse.failed} 封没解析出来`)
  const tail = rows.produced > 0 ? `，产出 ${rows.produced} 笔流水` : ''
  return `最近 ${summary.window_days} 天${parts.join('、')}${tail}。`
}

/** 卡住的任务在等什么。failed 给重试，waiting_input 要人去补密码。 */
function stuckReason(job: BillProcessingStuckJob): string {
  if (job.status === 'waiting_input') {
    return job.waiting_reason?.trim() || '等着补账单密码'
  }
  return job.error_message?.trim() || job.error_code?.trim() || '解析失败，没有更多说明'
}

export function ProcessingSummaryCard({ mailboxSyncing }: { mailboxSyncing?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const query = useBillProcessingSummary()
  const retry = useRetryParseJob()

  // 同步还在跑的时候数字一直在变，这里跟着刷一次就够，不做轮询。
  const summary = query.data
  if (query.isError || !summary) return null

  const stuck = summary.parse.stuck
  const hasTrouble = stuck.length > 0 || summary.mail.failed_runs > 0

  async function handleRetry(job: BillProcessingStuckJob) {
    try {
      await retry.mutateAsync(job.job_id)
      showToast({ kind: 'success', message: '已重新排队解析' })
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof Error ? `重试没能提交：${error.message}` : '重试没能提交',
      })
    }
  }

  return (
    <Card padded={false} className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          {hasTrouble && <WarningCircle aria-hidden className="size-4 text-[var(--attention-mark)]" />}
          <span>
            {summarySentence(summary)}
            {mailboxSyncing && ' 正在检查新邮件…'}
          </span>
        </div>
        {stuck.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? (
              <CaretDown aria-hidden className="size-4" />
            ) : (
              <CaretRight aria-hidden className="size-4" />
            )}
            {expanded ? '收起' : `看看卡住的 ${stuck.length} 封`}
          </Button>
        )}
      </div>

      {expanded && stuck.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2 border-t border-[var(--border-subtle)] pt-3">
          {stuck.map((job) => (
            <li
              key={job.job_id}
              className="flex flex-wrap items-start justify-between gap-2 text-xs sm:flex-nowrap"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium text-[var(--text-primary)]">
                  {channelDisplayName(job.channel_key)}
                  {job.summary ? ` · ${job.summary}` : ''}
                </span>
                <span className="text-[var(--text-tertiary)]">{stuckReason(job)}</span>
              </div>
              {job.status === 'failed' && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={retry.isPending}
                  onClick={() => void handleRetry(job)}
                >
                  <ArrowClockwise aria-hidden className="size-4" />
                  重试
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
