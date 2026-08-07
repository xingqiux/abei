import { useMemo } from 'react'
import { useBillInboxSummary, useReconciliationSummary, useRecurrences } from '../api/queries'
import { monthRange } from '../lib/format'
import { nextOccurrence } from '../lib/recurrence'

export function useTodoCounts() {
  const inboxQuery = useBillInboxSummary()
  const reconciliationQuery = useReconciliationSummary()
  const recurrencesQuery = useRecurrences()

  const parsed = inboxQuery.data?.channels?.reduce((sum, channel) => sum + channel.parsed, 0) ?? 0
  const needsCode = inboxQuery.data?.needs_code ?? 0
  const unprocessed = inboxQuery.data?.unprocessed ?? 0
  const failed = inboxQuery.data?.failed ?? 0
  /** 与收件箱「需处理」tab 对齐（含密码/失败/队列等） */
  const processing = inboxQuery.data?.pending_total ?? needsCode + unprocessed + failed
  const daysUnreconciled = reconciliationQuery.data?.days_unreconciled ?? 0
  const dueSubscriptions = useMemo(() => {
    const end = new Date(`${monthRange(new Date()).end}T23:59:59`)
    return (recurrencesQuery.data?.data ?? []).filter((recurrence) => {
      if (recurrence.attributes.active === false) return false
      const next = nextOccurrence(recurrence)
      return next !== null && next <= end
    }).length
  }, [recurrencesQuery.data])
  const inboxTotal = parsed + needsCode + unprocessed + failed

  return {
    parsed,
    needsCode,
    unprocessed,
    failed,
    processing,
    inboxTotal,
    daysUnreconciled,
    dueSubscriptions,
    total: inboxTotal + daysUnreconciled + dueSubscriptions,
    hasDanger: needsCode > 0 || failed > 0,
  }
}
