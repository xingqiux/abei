import { useTodoCounts } from '../hooks/useTodoCounts'

export interface NavBadge {
  text: string
  /** 里面混着待解锁 / 解析失败的邮件。徽章右上会多一颗红点。 */
  hasDanger: boolean
}

/**
 * 侧栏 / 移动端底部 tab / 「我的」sheet 共用的徽标（设计稿 06 §1）。
 *
 * 全站只有账单收件箱一处带徽标，值就是收件箱那个主数字 `todo.pending`
 * （待入账 + 待确认），和页内「待处理」tab 上的数一模一样。以前挂的是
 * `todo.total`，它还加了待解锁 / 解析失败的邮件——那是邮件不是流水，
 * 于是侧栏写一个数、点进去 tab 写另一个数。「今天」也不再挂那个把
 * 收件箱、对账、订阅加在一起的聚合数——点进去对不上，等于在骗人。
 *
 * 徽标本身一律中性色。数字大不代表出事了，把 319 印成红的只会让人天天
 * 看见红。只有待解锁 / 解析失败的邮件才多一颗红点，数字不变色。
 */
export function useNavBadges(): Partial<Record<string, NavBadge>> {
  const todos = useTodoCounts()

  const badges: Partial<Record<string, NavBadge>> = {}
  if (todos.pending > 0) {
    badges['/bill-inbox'] = { text: String(todos.pending), hasDanger: todos.hasDanger }
  }
  return badges
}
