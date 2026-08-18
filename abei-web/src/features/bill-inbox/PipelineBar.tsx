import { useState } from 'react'
import { ArrowClockwise, ArrowRight, WarningCircle } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { useBillProcessingSummary, useRetryParseJob } from '../../api/queries'
import type { BillProcessingStuckJob, BillProcessingSummary } from '../../api/schemas'
import { Button } from '../../components/ui/Button'
import { Skeleton } from '../../components/abei/Skeleton'
import { InlineError } from '../../components/abei/ErrorState'
import { showToast } from '../../store/toastStore'
import { channelDisplayName } from './billInboxHelpers'
import * as copy from './copy'
import { MailPicker, type SourceGroup } from './ChannelBar'

/**
 * 邮箱 → 解析 → 流水这条管道的两个出口。
 *
 * 批次八把它拆成了两层。首屏（收件箱）只留 [`StuckBanner`]：要人动手的那几条
 * 邮件是队列清不动的直接原因，必须在首屏说；而「收了 N 封、解析成 N 封、
 * 产出 N 笔」这套漏斗数字，回答的是「邮箱那头怎么样」，不是「我还有多少笔要处理」。
 * 两组数字摆在同一屏上，页面就有了两个主数字，谁也说不清哪个才是今天的活。
 * 漏斗连同邮件清单一起搬进二级页 [`MailPipelinePanel`]。
 */

/** 管道的三段：收到多少 → 解析成功多少 → 产出多少笔。数字缺失时那一段不出现。 */
export interface PipelineStage {
  label: string
  value: string
}

export function pipelineStages(summary: BillProcessingSummary): PipelineStage[] {
  const { parse, rows } = summary
  return [
    { label: '账单邮件', value: `${parse.total} 封` },
    { label: '解析成功', value: `${parse.succeeded} 封` },
    { label: '产出流水', value: `${rows.produced} 笔` },
  ]
}

/**
 * 管道上漏掉的那几段。顺序即紧要程度：要人补密码的排在没解析出来的前面。
 *
 * 「没匹配上账单规则」那一条批次七拿掉了：规则是 admin 的事，用户这一侧
 * 既写不了规则也管不了它，报一个自己动不了的数字只是让人干着急。
 */
export function pipelineLeaks(
  summary: BillProcessingSummary,
): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = []
  if (summary.parse.waiting_input > 0) out.push({ key: 'waiting', text: copy.pipelineWaiting(summary.parse.waiting_input) })
  if (summary.parse.running > 0) out.push({ key: 'running', text: copy.pipelineRunning(summary.parse.running) })
  if (summary.parse.failed > 0) out.push({ key: 'failed', text: copy.pipelineFailed(summary.parse.failed) })
  return out
}

/**
 * 需要人动手的邮件，按「同渠道同原因」聚合。
 *
 * 逐封列出来的问题是：招行一天来三封、每封都在等同一个解压密码，展开层就是
 * 三行一模一样的字，而人要做的只有一件事——去补那个密码。聚合成一条以后，
 * 一条 = 一件要做的事，逐封清单收进这一条的展开态里，重新解析的能力不丢。
 */
export type StuckKind = 'waiting' | 'failed'

export interface StuckGroup {
  key: string
  kind: StuckKind
  channelKey: string
  jobs: BillProcessingStuckJob[]
}

export function groupStuckJobs(jobs: BillProcessingStuckJob[]): StuckGroup[] {
  const groups: StuckGroup[] = []
  const index = new Map<string, StuckGroup>()
  for (const job of jobs) {
    const kind: StuckKind = job.status === 'waiting_input' ? 'waiting' : 'failed'
    const key = `${kind}:${job.channel_key}`
    let group = index.get(key)
    if (!group) {
      group = { key, kind, channelKey: job.channel_key, jobs: [] }
      index.set(key, group)
      groups.push(group)
    }
    group.jobs.push(job)
  }
  // 待解锁排在解析失败前面：前者用户补一次密码就能走通，后者常常只能等
  return groups.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'waiting' ? -1 : 1))
}

/** 聚合条的正文：N 封{渠道}账单在等解压密码 / N 封{渠道}账单没解析出来 */
export function stuckGroupText(group: StuckGroup, channelLabel: string): string {
  return group.kind === 'waiting'
    ? copy.stuckWaitingText(group.jobs.length, channelLabel)
    : copy.stuckFailedText(group.jobs.length, channelLabel)
}

/**
 * 逐封那一行的说明。错误码永远不直出：正文是人话，后端给的
 * waiting_reason / error_code / 英文 message 一律降为小字。
 */
export function stuckJobDetail(job: BillProcessingStuckJob): { text: string; detail: string | null } {
  if (job.status === 'waiting_input') {
    return { text: copy.waitingReasonText(job.waiting_reason), detail: job.waiting_reason?.trim() || null }
  }
  return copy.parseErrorText(job.error_code, job.error_message)
}

/** 顶部那颗展开按钮上写什么：按状态拆开说，不写「卡了几封」这种笼统数 */
export function stuckToggleLabel(groups: StuckGroup[]): string {
  const waiting = groups.filter((group) => group.kind === 'waiting').reduce((sum, group) => sum + group.jobs.length, 0)
  const failed = groups.filter((group) => group.kind === 'failed').reduce((sum, group) => sum + group.jobs.length, 0)
  return [
    waiting > 0 ? copy.pipelineWaiting(waiting) : null,
    failed > 0 ? copy.pipelineFailed(failed) : null,
  ].filter(Boolean).join(' · ')
}

/**
 * 首屏那条聚合横幅：要人动手的邮件，一条 = 一件要做的事。
 *
 * 没有这样的邮件时整条不出现——首屏的每一行都得为「清空队列」服务，
 * 一条常驻的「一切正常」只是在占位置。
 */
export function StuckBanner() {
  const query = useBillProcessingSummary()

  if (query.isLoading) {
    return (
      <div className={SHELL}>
        <Skeleton className="h-5 w-2/3" />
      </div>
    )
  }

  if (query.isError || !query.data) {
    return (
      <div className={SHELL}>
        <InlineError message={copy.PIPELINE_ERROR} error={query.error} onRetry={() => void query.refetch()} />
      </div>
    )
  }

  const stuckGroups = groupStuckJobs(query.data.parse.stuck)
  if (stuckGroups.length === 0) return null

  return (
    <ul className={`${SHELL} flex flex-col gap-1.5`}>
      {stuckGroups.map((group) => {
        const channelLabel = channelDisplayName(group.channelKey)
        const first = group.jobs[0]
        return (
          <li key={group.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
            <WarningCircle aria-hidden className="size-4 shrink-0 text-[var(--attention-mark)]" />
            <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
              {stuckGroupText(group, channelLabel)}
            </span>
            {/*
              两个出口都通向二级页：解锁的输入框和逐封清单都在那边。
              首屏再摆一套输入框就等于把二级页又搬回来了。
            */}
            <Link
              to="/bill-inbox/mail"
              search={group.kind === 'waiting' && first ? { task: first.document_id } : {}}
              className="shrink-0 rounded px-1.5 py-1 text-[12px] font-semibold text-[var(--brand-text)] underline-offset-2 hover:underline"
            >
              {group.kind === 'waiting' ? copy.STUCK_UNLOCK_ACTION : copy.STUCK_DETAIL_ACTION}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * 二级页的主体：漏斗 + 邮件清单 + 逐封处理。
 *
 * 这里才是漏斗数字该待的地方——进这一页的人问的就是「邮箱那头怎么样」。
 */
export function MailPipelinePanel({
  mailboxSyncing,
  groups,
  selectedTaskId,
  onSelectTask,
}: {
  mailboxSyncing?: boolean
  groups: SourceGroup[]
  selectedTaskId: string | null
  onSelectTask: (taskId: string | null) => void
}) {
  /** 聚合条里被展开的那一条，展开后才逐封列出来 */
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const query = useBillProcessingSummary()
  const retry = useRetryParseJob()

  const summary = query.data

  async function handleRetry(job: BillProcessingStuckJob) {
    try {
      await retry.mutateAsync(job.job_id)
      showToast({ kind: 'success', message: copy.RETRY_PARSE_QUEUED })
    } catch (error) {
      showToast({
        kind: 'error',
        message: copy.retryParseFailed(error instanceof Error ? error.message : undefined),
      })
    }
  }

  // 加载中给骨架、出错说一句错在哪并给重试。这两种情况都 return null 的话，
  // 整条管道凭空消失，用户既不知道解析失败了几封，也不知道这里本来有东西。
  if (query.isLoading) {
    return (
      <div className={SHELL}>
        <Skeleton className="h-5 w-2/3" />
      </div>
    )
  }

  if (query.isError || !summary) {
    return (
      <div className={SHELL}>
        <InlineError message={copy.PIPELINE_ERROR} error={query.error} onRetry={() => void query.refetch()} />
      </div>
    )
  }

  const stages = pipelineStages(summary)
  const leaks = pipelineLeaks(summary)
  const stuckGroups = groupStuckJobs(summary.parse.stuck)
  const quiet = summary.mail.runs === 0 && summary.parse.total === 0

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-1.5">
        <SectionTitle title={copy.MAIL_FUNNEL_TITLE} />
        <div className={`${SHELL} flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px]`}>
          {quiet ? (
            <span className="text-[var(--text-secondary)]">{copy.PIPELINE_QUIET}</span>
          ) : (
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              {stages.map((stage, index) => (
                <span key={stage.label} className="flex items-center gap-1.5">
                  {index > 0 && <ArrowRight aria-hidden className="size-3.5 text-[var(--text-tertiary)]" />}
                  <span className="text-[var(--text-secondary)]">{stage.label}</span>
                  <span className="num font-semibold text-[var(--text-primary)]">{stage.value}</span>
                </span>
              ))}
            </span>
          )}

          {mailboxSyncing && <span className="text-[var(--text-tertiary)]">{copy.PIPELINE_SYNCING}</span>}

          {leaks.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5 text-[var(--text-secondary)]">
              <WarningCircle aria-hidden className="size-4 text-[var(--attention-mark)]" />
              {leaks.map((leak) => leak.text).join(' · ')}
            </span>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-1.5">
        <SectionTitle title={copy.MAIL_STUCK_TITLE} hint={copy.MAIL_STUCK_HINT} />
        {stuckGroups.length === 0 ? (
          <p className="text-[11.5px] text-[var(--text-tertiary)]">{copy.MAIL_STUCK_EMPTY}</p>
        ) : (
          <ul className={`${SHELL} flex flex-col gap-2`}>
            {stuckGroups.map((group) => {
              const open = openGroup === group.key
              const channelLabel = channelDisplayName(group.channelKey)
              return (
                <li key={group.key} className="flex flex-col gap-1.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 sm:flex-nowrap">
                    <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">
                      {stuckGroupText(group, channelLabel)}
                    </span>
                    {group.kind === 'waiting' ? (
                      <Button
                        variant="primary"
                        size="xs"
                        onClick={() => { if (group.jobs[0]) onSelectTask(group.jobs[0].document_id) }}
                      >
                        {copy.STUCK_UNLOCK_ACTION}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="xs"
                        aria-expanded={open}
                        onClick={() => setOpenGroup(open ? null : group.key)}
                      >
                        {open ? copy.STUCK_DETAIL_ACTION_OPEN : copy.STUCK_DETAIL_ACTION}
                      </Button>
                    )}
                  </div>

                  {/* 展开态才逐封列。聚合掉的是重复的那句话，不是重新解析这个能力。 */}
                  {open && (
                    <ul className="flex flex-col gap-1.5 pl-3">
                      {group.jobs.map((job) => {
                        const reason = stuckJobDetail(job)
                        return (
                          <li
                            key={job.job_id}
                            className="flex flex-wrap items-start justify-between gap-2 sm:flex-nowrap"
                          >
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span className="truncate text-[var(--text-primary)]">
                                {job.summary?.trim() || channelLabel}
                              </span>
                              <span className="text-[var(--text-secondary)]">{reason.text}</span>
                              {reason.detail && (
                                <span className="text-[10.5px] text-[var(--text-tertiary)]">{reason.detail}</span>
                              )}
                            </div>
                            {job.status === 'failed' && (
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={retry.isPending}
                                onClick={() => void handleRetry(job)}
                              >
                                <ArrowClockwise aria-hidden className="size-4" />
                                {copy.RETRY_PARSE}
                              </Button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <SectionTitle title={copy.MAIL_LIST_TITLE} hint={copy.MAIL_LIST_HINT} />
        <div className={SHELL}>
          <MailPicker groups={groups} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
        </div>
      </section>
    </div>
  )
}

/** 二级页三块的节头。标题和 hint 之间贴得比节间距近，靠亲密性分组。 */
function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h2>
      {hint && <p className="text-[11px] text-[var(--text-tertiary)]">{hint}</p>}
    </div>
  )
}

const SHELL =
  'rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2'
