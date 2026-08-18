import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { getAdminProcessingSummary, type AdminProcessingMailbox } from '../../api/mail'
import { InlineError } from '../../components/abei/ErrorState'
import { StatusChip } from '../../components/abei/StatusChip'
import { Button } from '../../components/ui/Button'
import { formatDateTime } from '../../lib/format'

/**
 * 全局只读统计：所有邮箱的处理结果，按邮箱铺开。
 *
 * 这块和这个页面其余部分不是一个作用域，得说清楚，不然会误导。后台是 owner 自己的开发者
 * 控制台——下面的邮件列表、规则、重归类，动的都是当前登录者自己的邮箱。这张表是唯一的例外：
 * 它跨用户读，只读，不提供任何跨用户的操作。看到别人的解析失败数，也只能去提醒本人，
 * 后台没有替他重跑的按钮，也不该有。
 */
export function ProcessingSummaryPanel() {
  const [expanded, setExpanded] = useState(false)
  const navigate = useNavigate()
  const query = useQuery({
    queryKey: ['admin-processing-summary'],
    queryFn: () => getAdminProcessingSummary(),
    staleTime: 60_000,
    // 同步跑完会改这里的数。原先只在挂载时取一次，一整天开着的后台看到的是早上的数。
    refetchInterval: 60_000,
    refetchOnWindowFocus: 'always',
  })

  const summary = query.data

  // 出错时整块消失是最糟的处理：看不出是「没有数据」还是「没取到数据」。
  if (query.isError) {
    return (
      <InlineError
        message="全局处理统计没取到"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    )
  }

  if (!summary) return null

  const mailboxes = summary.mailboxes
  const troubled = mailboxes.filter(hasTrouble)
  const totalFailed = mailboxes.reduce((sum, box) => sum + box.parse_failed, 0)

  return (
    <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--text-secondary)]">
          <StatusChip label="全局只读统计" kind="muted" />
          <span>{panelSentence(summary.window_days, mailboxes, troubled)}</span>
          {totalFailed > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className="text-[var(--danger)]"
              onClick={() => void navigate({ to: '/documents', search: { status: 'failed' } })}
            >
              查看 {totalFailed} 封解析失败
            </Button>
          )}
        </span>
        {mailboxes.length > 0 && (
          <Button variant="ghost" size="xs" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
            {expanded ? <CaretDown aria-hidden className="size-4" /> : <CaretRight aria-hidden className="size-4" />}
            {expanded ? '收起' : '按邮箱看'}
          </Button>
        )}
      </div>

      {expanded && mailboxes.length > 0 && (
        <div className="mt-2 overflow-x-auto border-t border-[var(--border-subtle)] pt-2">
          <p className="pb-2 text-[11px] text-[var(--text-tertiary)]">
            这张表跨所有用户，只能看。下面的邮件列表和规则只作用于当前登录的邮箱。
          </p>
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-[var(--text-tertiary)]">
              <tr>
                <th className="py-1 pr-3 font-medium">邮箱</th>
                <th className="py-1 pr-3 font-medium">同步</th>
                <th className="py-1 pr-3 font-medium">命中规则</th>
                <th className="py-1 pr-3 font-medium">解析</th>
                <th className="py-1 pr-3 font-medium">上次同步</th>
              </tr>
            </thead>
            <tbody>
              {mailboxes.map((box) => (
                <tr key={box.user_id} className="border-t border-[var(--border-subtle)] align-top">
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--text-primary)]">
                        {box.mailbox_email || box.user_email || `用户 ${box.user_id}`}
                      </span>
                      {!box.enabled && <StatusChip label="已停用" kind="muted" />}
                    </div>
                  </td>
                  <td className="py-1.5 pr-3 text-[var(--text-secondary)]">
                    {box.runs} 次
                    {box.failed_runs > 0 && (
                      <span className="ml-1 text-[var(--danger)]">失败 {box.failed_runs}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{box.matched}</td>
                  <td className="py-1.5 pr-3 text-[var(--text-secondary)]">
                    {box.parse_total} 封
                    {box.parse_failed > 0 && (
                      <span className="ml-1 text-[var(--danger)]">解析失败 {box.parse_failed}</span>
                    )}
                    {box.parse_waiting_input > 0 && (
                      <span className="ml-1 text-[var(--attention)]">待解锁 {box.parse_waiting_input}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-[var(--text-secondary)]">
                    {box.last_requested_at ? formatDateTime(box.last_requested_at) : '还没同步过'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function hasTrouble(box: AdminProcessingMailbox): boolean {
  return box.failed_runs > 0 || box.parse_failed > 0 || box.parse_waiting_input > 0
}

function panelSentence(
  windowDays: number,
  mailboxes: AdminProcessingMailbox[],
  troubled: AdminProcessingMailbox[],
): string {
  if (mailboxes.length === 0) return `最近 ${windowDays} 天没有邮箱同步过。`
  const parsed = mailboxes.reduce((sum, box) => sum + box.parse_total, 0)
  const head = `最近 ${windowDays} 天，${mailboxes.length} 个邮箱共解析 ${parsed} 封账单邮件`
  if (troubled.length === 0) return `${head}，都正常。`
  return `${head}，其中 ${troubled.length} 个邮箱有失败或卡住的。`
}
