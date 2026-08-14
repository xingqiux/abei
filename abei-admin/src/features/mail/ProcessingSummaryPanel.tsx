import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { getAdminProcessingSummary, type AdminProcessingMailbox } from '../../api/mail'
import { StatusChip } from '../../components/abei/StatusChip'
import { Button } from '../../components/ui/Button'
import { formatDateTime } from '../../lib/format'

/**
 * 管理视角的处理结果：和用户端同一份账，按邮箱铺开。
 * 用来一眼看出「谁的解析卡住了」，而不用挨个用户点进去看。
 */
export function ProcessingSummaryPanel() {
  const [expanded, setExpanded] = useState(false)
  const query = useQuery({
    queryKey: ['admin-processing-summary'],
    queryFn: () => getAdminProcessingSummary(),
    staleTime: 60_000,
  })

  const summary = query.data
  if (query.isError || !summary) return null

  const mailboxes = summary.mailboxes
  const troubled = mailboxes.filter(hasTrouble)

  return (
    <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-[var(--text-secondary)]">
          {panelSentence(summary.window_days, mailboxes, troubled)}
        </span>
        {mailboxes.length > 0 && (
          <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
            {expanded ? <CaretDown aria-hidden className="size-4" /> : <CaretRight aria-hidden className="size-4" />}
            {expanded ? '收起' : '按邮箱看'}
          </Button>
        )}
      </div>

      {expanded && mailboxes.length > 0 && (
        <div className="mt-2 overflow-x-auto border-t border-[var(--border-subtle)] pt-2">
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
                      <span className="ml-1 text-[var(--danger)]">失败 {box.parse_failed}</span>
                    )}
                    {box.parse_waiting_input > 0 && (
                      <span className="ml-1 text-[var(--attention)]">等密码 {box.parse_waiting_input}</span>
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
