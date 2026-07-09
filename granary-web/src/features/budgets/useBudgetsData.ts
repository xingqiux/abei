import { useMemo } from 'react'
import type { DateRange } from '../../api/firefly'
import { useBudgetLimits, useBudgets } from '../../api/queries'

/**
 * 预算 tab：预算列表 + 每个预算各自的当期限额（0~1 条），合并成 id -> 限额金额 的 Map。
 * useBudgetLimits 内部用 useQueries 并发拉取，下标与 budgetIds 一一对应（同账单收件箱任务列表惯例）。
 */
export function useBudgetsData(range: DateRange) {
  const budgetsQuery = useBudgets(range)
  const budgetIds = useMemo(() => (budgetsQuery.data?.data ?? []).map((b) => b.id), [budgetsQuery.data])
  const limitQueries = useBudgetLimits(budgetIds, range)

  const limitByBudget = useMemo(() => {
    const map = new Map<string, number>()
    budgetIds.forEach((id, i) => {
      const limits = limitQueries[i]?.data?.data ?? []
      if (limits.length === 0) return
      const sum = limits.reduce((acc, l) => acc + Number(l.attributes.amount ?? 0), 0)
      map.set(id, sum)
    })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetIds, limitQueries.map((q) => q.dataUpdatedAt).join(',')])

  return { budgetsQuery, limitByBudget }
}
