import { useBillInboxSummary } from '../api/queries'
import { EMPTY_BILL_INBOX_TODO, type BillInboxTodo } from '../api/schemas'

export type TodoCounts = BillInboxTodo & {
  /** 有卡住的任务时，徽标升级为 danger */
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
    hasDanger: todo.stuck_tasks > 0,
    isLoading: inboxQuery.isLoading,
    isError: inboxQuery.isError,
  }
}
