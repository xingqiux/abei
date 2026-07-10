import { useMemo } from 'react'
import type { DateRange } from '../../api/firefly'
import { useBudgetLimits, useBudgets } from '../../api/queries'

export interface BudgetLimitInfo {
  amount: number
  limitId: string
}

/**
 * 预算 tab：预算列表 + 每个预算各自的当期限额（0~1 条）。
 * limitByBudget: id -> { amount, limitId }，供编辑限额 PUT。
 */
export function useBudgetsData(range: DateRange) {
  const budgetsQuery = useBudgets(range)
  const budgetIds = useMemo(() => (budgetsQuery.data?.data ?? []).map((b) => b.id), [budgetsQuery.data])
  const limitQueries = useBudgetLimits(budgetIds, range)

  const limitByBudget = useMemo(() => {
    const map = new Map<string, BudgetLimitInfo>()
    budgetIds.forEach((id, i) => {
      const limits = limitQueries[i]?.data?.data ?? []
      if (limits.length === 0) return
      const sum = limits.reduce((acc, l) => acc + Number(l.attributes.amount ?? 0), 0)
      // 编辑取第一条（通常日期范围只命中 1 条）
      map.set(id, { amount: sum, limitId: limits[0].id })
    })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetIds, limitQueries.map((q) => q.dataUpdatedAt).join(',')])

  return { budgetsQuery, limitByBudget }
}
