import { useMemo } from 'react'
import type { DateRange } from '../../api/firefly'
import { useBudgetLimits, useBudgets } from '../../api/queries'

export interface BudgetLimitInfo {
  amount: string
  limitId: string
  start: string
  end: string
  symbol?: string | null
  code?: string | null
}

/**
 * 预算 tab：预算列表 + 每个预算各自的当期限额（0~1 条）。
 * limitByBudget: id -> { amount, limitId }，供编辑限额 PUT。
 */
export function useBudgetsData(range: DateRange) {
  const budgetsQuery = useBudgets(range)
  const budgetIds = useMemo(() => (budgetsQuery.data?.data ?? []).map((b) => b.id), [budgetsQuery.data])
  const limitQueries = useBudgetLimits(budgetIds, range)

  const limitsByBudget = useMemo(() => {
    const map = new Map<string, BudgetLimitInfo[]>()
    budgetIds.forEach((id, i) => {
      const limits = limitQueries[i]?.data?.data ?? []
      map.set(id, limits.map((limit) => ({
        amount: limit.attributes.amount,
        limitId: limit.id,
        start: limit.attributes.start.slice(0, 10),
        end: limit.attributes.end.slice(0, 10),
        symbol: limit.attributes.currency_symbol,
        code: limit.attributes.currency_code,
      })))
    })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetIds, limitQueries.map((q) => q.dataUpdatedAt).join(',')])

  const limitStateByBudget = new Map(
    budgetIds.map((id, index) => [id, {
      isLoading: limitQueries[index]?.isLoading ?? false,
      isError: limitQueries[index]?.isError ?? false,
      refetch: limitQueries[index]?.refetch,
    }]),
  )

  return { budgetsQuery, limitsByBudget, limitStateByBudget }
}
