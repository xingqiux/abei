import { useBillInboxSummary } from '../api/queries'
import { EMPTY_BILL_INBOX_TODO, type BillInboxTodo } from '../api/schemas'

export type TodoCounts = BillInboxTodo & {
  /**
   * 全站唯一的主数字：待入账 + 待确认，也就是收件箱「待处理」tab 上那个数。
   *
   * 不含待解锁 / 解析失败的邮件——那是邮件，不是流水，加进来的结果是侧栏写 173、
   * 点进去 tab 写 160，两个数谁也不认识谁。要人动手的邮件靠 `hasDanger` 那颗红点
   * 提醒，不混进笔数里。
   *
   * 口径是**行数**，不是「要做几次判断」。「疑似同一笔」那一节的节头按对数印
   * （3 对 = 6 行），因为那一节摆的是成对卡、一对一张；这里不跟着换算成对数：
   * 这个数要回答的是「还有多少笔流水没落地」，一对里的两行是两笔流水，
   * 合并之后也确实要少掉两行。两处报的是两件事，各自在自己的位置上是对的。
   */
  pending: number
  /** 有待解锁或解析失败的邮件时，徽标升级为 danger */
  hasDanger: boolean
  isLoading: boolean
  isError: boolean
}

/**
 * 全站唯一待办口径（设计稿 02 §3、06 §1）。
 *
 * 这里过去把收件箱、未对账天数、本月待付订阅加在一起算出「41」这种数，
 * 三种完全不同的事被折成一个数字，点进去看到的又是另一个数。现在只读
 * `/bill-inbox/summary` 的 `todo` 对象，不在前端做任何聚合。
 */
export function useTodoCounts(): TodoCounts {
  const inboxQuery = useBillInboxSummary()
  const todo = inboxQuery.data?.todo ?? EMPTY_BILL_INBOX_TODO

  return {
    ...todo,
    pending: todo.importable + todo.attention,
    hasDanger: todo.stuck_tasks > 0,
    isLoading: inboxQuery.isLoading,
    isError: inboxQuery.isError,
  }
}
