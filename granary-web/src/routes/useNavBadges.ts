import { useBillInboxSummary, useReconciliationSummary } from '../api/queries'
import type { NavPath } from './navItems'

export interface NavBadge {
  text: string
  kind: 'warn' | 'danger'
}

/**
 * 侧栏 / 移动端底部 tab / 「我的」sheet 共用的徽标计算（规范 §3）：
 * 收件箱徽标 = 需处理（验证码/待处理/失败）+ 已解析待审；出现失败或待验证码时升级为 danger。
 * 按天对账徽标 = 未对账天数，始终 danger。
 */
export function useNavBadges(): Partial<Record<NavPath, NavBadge>> {
  const inbox = useBillInboxSummary()
  const recon = useReconciliationSummary()

  const inboxCount = inbox.data
    ? inbox.data.pending_total + inbox.data.channels.reduce((acc, c) => acc + c.parsed, 0)
    : 0
  const inboxKind: 'warn' | 'danger' =
    inbox.data && (inbox.data.failed > 0 || inbox.data.needs_code > 0) ? 'danger' : 'warn'
  const daysUnreconciled = recon.data?.days_unreconciled ?? 0

  const badges: Partial<Record<NavPath, NavBadge>> = {}
  if (inboxCount > 0) badges['/bill-inbox'] = { text: String(inboxCount), kind: inboxKind }
  if (daysUnreconciled > 0) badges['/reconciliation'] = { text: String(daysUnreconciled), kind: 'danger' }
  return badges
}
