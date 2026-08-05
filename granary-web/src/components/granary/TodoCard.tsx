import type { ComponentType } from 'react'
import { Link } from '@tanstack/react-router'
import { CalendarDaysIcon, InboxIcon } from '@heroicons/react/24/outline'
import { useBillInboxSummary, useReconciliationSummary } from '../../api/queries'

export function TodoCard() {
  const inbox = useBillInboxSummary()
  const recon = useReconciliationSummary()

  const pending = inbox.data?.pending_total ?? 0
  const parsed = inbox.data?.channels.reduce((acc, c) => acc + c.parsed, 0) ?? 0
  const daysUnreconciled = recon.data?.days_unreconciled ?? 0
  const lastReconciled = recon.data?.last_reconciled_date

  const items: { icon: ComponentType<{ className?: string }>; text: string; to: string }[] = []
  if (pending > 0) items.push({ icon: InboxIcon, text: `收件箱 ${pending} 条需处理`, to: '/bill-inbox' })
  if (parsed > 0) items.push({ icon: InboxIcon, text: `收件箱 ${parsed} 条已解析待审`, to: '/bill-inbox' })
  if (daysUnreconciled > 0)
    items.push({
      icon: CalendarDaysIcon,
      text: lastReconciled ? `${lastReconciled} 后已 ${daysUnreconciled} 天未对账` : `已 ${daysUnreconciled} 天未对账`,
      to: '/reconciliation',
    })

  // 没有任何待办就整卡隐藏（原则：待办卡只在有事时出现）
  if (items.length === 0) return null

  return (
    <div
      className="flex items-center justify-between rounded-xl bg-white py-3 pl-4 pr-4 shadow-sm ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-gray-700"
      style={{ borderLeft: '3px solid var(--g-accent)' }}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-gray-900 dark:text-gray-100">
        {items.map((item, i) => {
          const Icon = item.icon
          return (
            <span key={item.text} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-gray-400">·</span>}
              <Icon aria-hidden className="size-4 text-indigo-600 dark:text-indigo-400" />
              {item.text}
            </span>
          )
        })}
      </div>
      <Link to={items[0].to} className="shrink-0 text-[13px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
        去处理 →
      </Link>
    </div>
  )
}
