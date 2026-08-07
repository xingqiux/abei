import { useTodoCounts } from '../hooks/useTodoCounts'

export interface NavBadge {
  text: string
  kind: 'warn' | 'danger'
}

/**
 * 侧栏 / 移动端底部 tab / 「我的」sheet 共用的徽标计算（规范 §3）：
 * 收件箱徽标 = 需处理（验证码/待处理/失败）+ 已解析待审；出现失败或待验证码时升级为 danger。
 * 按天对账徽标 = 未对账天数，始终 danger。
 * 「今天」徽标 = 收件箱 + 对账 + 本月待付订阅的总待办数。
 */
export function useNavBadges(): Partial<Record<string, NavBadge>> {
  const todos = useTodoCounts()

  const badges: Partial<Record<string, NavBadge>> = {}
  if (todos.total > 0) {
    badges['/'] = {
      text: String(todos.total),
      kind: todos.hasDanger ? 'danger' : 'warn',
    }
  }
  if (todos.inboxTotal > 0) {
    badges['/bill-inbox'] = { text: String(todos.inboxTotal), kind: todos.hasDanger ? 'danger' : 'warn' }
  }
  if (todos.daysUnreconciled > 0) {
    badges['/reconciliation'] = { text: String(todos.daysUnreconciled), kind: 'danger' }
  }
  return badges
}
