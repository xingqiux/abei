import { Link } from '@tanstack/react-router'
import { Inbox, CalendarCheck } from 'lucide-react'
import { useBillInboxSummary, useReconciliationSummary } from '../../api/queries'

export function TodoCard() {
  const inbox = useBillInboxSummary()
  const recon = useReconciliationSummary()

  const pending = inbox.data?.pending_total ?? 0
  const parsed = inbox.data?.channels.reduce((acc, c) => acc + c.parsed, 0) ?? 0
  const daysUnreconciled = recon.data?.days_unreconciled ?? 0
  const lastReconciled = recon.data?.last_reconciled_date

  const items: { icon: typeof Inbox; text: string; to: string }[] = []
  if (pending > 0) items.push({ icon: Inbox, text: `收件箱 ${pending} 条需处理`, to: '/bill-inbox' })
  if (parsed > 0) items.push({ icon: Inbox, text: `收件箱 ${parsed} 条已解析待审`, to: '/bill-inbox' })
  if (daysUnreconciled > 0)
    items.push({
      icon: CalendarCheck,
      text: lastReconciled ? `${lastReconciled} 后已 ${daysUnreconciled} 天未对账` : `已 ${daysUnreconciled} 天未对账`,
      to: '/reconciliation',
    })

  // 没有任何待办就整卡隐藏（原则：待办卡只在有事时出现）
  if (items.length === 0) return null

  return (
    <div
      className="flex items-center justify-between rounded-[10px] py-3 pl-3.5 pr-4"
      style={{
        background: 'var(--g-surface)',
        boxShadow: 'var(--g-shadow)',
        borderLeft: '3px solid var(--g-accent)',
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]" style={{ color: 'var(--g-ink)' }}>
        {items.map((item, i) => {
          const Icon = item.icon
          return (
            <span key={item.text} className="flex items-center gap-1.5">
              {i > 0 && <span style={{ color: 'var(--g-ink-2)' }}>·</span>}
              <Icon aria-hidden size={14} color="var(--g-accent)" />
              {item.text}
            </span>
          )
        })}
      </div>
      <Link to={items[0].to} className="shrink-0 text-[12.5px]" style={{ color: 'var(--g-accent)' }}>
        去处理 →
      </Link>
    </div>
  )
}
