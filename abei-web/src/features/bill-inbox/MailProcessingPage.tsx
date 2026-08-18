import { useMemo } from 'react'
import { ArrowLeft, ArrowsClockwise } from '@phosphor-icons/react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useBillInboxSummary, useBillTasks, useSyncBillInbox } from '../../api/queries'
import { AbeiApiError } from '../../api/client'
import { Button } from '../../components/ui/Button'
import { showToast } from '../../store/toastStore'
import { buildSourceGroups, relativeTimeLabel } from './billInboxHelpers'
import * as copy from './copy'
import { MailPipelinePanel } from './PipelineBar'

/**
 * 「邮件处理」二级页（信息架构 L2）。
 *
 * 收件箱首屏回答的是「我还有多少笔要处理」，这一页回答的是「邮箱那头怎么样」。
 * 两个问题过去挤在同一屏上：漏斗条常驻页头，邮件清单、逐封解锁全收在它的展开层里，
 * 于是首屏同时印着「产出流水 173 笔」和「待处理 160 笔」两个主数字，
 * 而真正要人动手的那几封邮件藏在两级展开之后。
 *
 * 这一页把漏斗、邮件清单、逐封处理三块摊平，首屏只留一条聚合横幅当入口。
 */
export function MailProcessingPage() {
  const search = useSearch({ from: '/bill-inbox/mail' })
  const navigate = useNavigate({ from: '/bill-inbox/mail' })
  const selectedTaskId = search.task ?? null

  const summaryQuery = useBillInboxSummary()
  const tasksQuery = useBillTasks()
  const syncMutation = useSyncBillInbox()

  const groups = useMemo(
    () => buildSourceGroups(tasksQuery.data?.data ?? [], summaryQuery.data?.channels ?? []),
    [tasksQuery.data, summaryQuery.data],
  )

  const mailboxSync = summaryQuery.data?.mailbox_sync
  const syncActive = mailboxSync?.status === 'queued' || mailboxSync?.status === 'running'
  const syncBusy = syncMutation.isPending || syncActive
  const lastSyncHint = syncActive ? null : relativeTimeLabel(mailboxSync?.finished_at)

  function selectTask(taskId: string | null) {
    void navigate({ search: { task: taskId ?? undefined }, replace: true })
  }

  async function handleSync() {
    if (syncBusy) return
    try {
      await syncMutation.mutateAsync({})
      showToast({ kind: 'success', message: '已开始检查新邮件' })
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof AbeiApiError ? err.message : '同步邮件失败，请稍后重试',
        duration: 6000,
      })
    }
  }

  return (
    <div className="flex flex-col gap-6 pb-16">
      <header className="flex flex-col gap-2">
        <Link
          to="/bill-inbox"
          className="flex w-fit items-center gap-1 text-[12px] text-[var(--brand-text)] underline-offset-2 hover:underline"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          {copy.MAIL_PAGE_BACK}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">{copy.MAIL_PAGE_TITLE}</h1>
            <p className="text-[11.5px] text-[var(--text-tertiary)]">{copy.MAIL_PAGE_SUBTITLE}</p>
          </div>
          <div className="flex items-center gap-2">
            {lastSyncHint && (
              <span className="text-[11px] text-[var(--text-tertiary)] max-sm:hidden">
                {copy.lastSyncNote(lastSyncHint)}
              </span>
            )}
            <Button variant="secondary" size="sm" disabled={syncBusy} onClick={() => void handleSync()}>
              <ArrowsClockwise aria-hidden className={`size-4 ${syncBusy ? 'animate-spin' : ''}`} />
              {syncBusy ? copy.SYNC_BUTTON_BUSY : copy.SYNC_INLINE}
            </Button>
          </div>
        </div>
      </header>

      <MailPipelinePanel
        mailboxSyncing={syncBusy}
        groups={groups}
        selectedTaskId={selectedTaskId}
        onSelectTask={selectTask}
      />
    </div>
  )
}
